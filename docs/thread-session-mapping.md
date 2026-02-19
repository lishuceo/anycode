# Thread → Session 映射重构方案

## 问题背景

### 当前设计缺陷

Session key 为 `chatId:userId`，每个用户每个群聊只有**一个全局 `conversationId`**。

任何以下情况都会覆盖这个唯一的 ID：
- 用户在主聊天区发消息（`ensureThread` 主动清空）
- workspace 变更触发 restart（清空 S1、写入 S2）
- 进程在写入时序上被杀（restart 完成前服务重启）

导致的现象：用户在同一个话题里连续对话，却因服务重启或其他话题的操作丢失了 `conversationId`，agent 无法 resume，只能从摘要重建上下文。

### 根本原因

`conversationId` 存储在**错误的粒度**上。飞书话题（thread）和 Claude Code 会话（session）是天然的 1:1 关系，却被存成了 1 chat:1 user → 1 session 的全局状态。

---

## 新方案：`threadId → conversationId` 映射

### 核心思路

- **飞书 threadId** 是稳定 ID（话题创建后不变）
- **Claude Code session_id** 是稳定 ID（resume 后不变，`forkSession: true` 除外）
- 将两个稳定 ID 的映射持久化到 DB，服务重启后永远可以恢复

### 数据模型

新增 `thread_sessions` 表：

```sql
CREATE TABLE thread_sessions (
  thread_id       TEXT PRIMARY KEY,
  chat_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,          -- Claude Code session_id，可为空（setup 中）
  working_dir     TEXT NOT NULL,
  conversation_cwd TEXT,         -- 创建 session 时的 cwd，用于 cwd 匹配校验
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

`sessions` 表保留，作为兜底（处理无 threadId 的场景，如私聊直接发消息）。

---

## 详细流程

### 1. 普通消息（在已有话题内）

```
收到消息（有 rootId/threadId）
  ↓
查 thread_sessions WHERE thread_id = threadId
  ↓ 找到且有 conversation_id + cwd 匹配
resumeSessionId = conversation_id
  ↓ 执行完成
更新 thread_sessions: conversation_id = result.sessionId
```

### 2. 新话题（用户在主聊天区发消息）

```
收到消息（无 rootId）
  ↓
创建新 thread（飞书 API）→ 得到新 threadId
  ↓
INSERT thread_sessions (thread_id, conversation_id = NULL, ...)
  ↓ 执行（无 resume）
INSERT/UPDATE thread_sessions: conversation_id = result.sessionId
```

不再需要清空全局 `conversationId`，各 thread 互相独立。

### 3. Workspace setup → restart 流程

```
第一次 query（setup session S1，needsRestart = true）
  ↓
thread_sessions 暂不写入 conversation_id（S1 只做 workspace 初始化）
  ↓
第二次 query（work session S2，新 workingDir）
  ↓
更新 thread_sessions: conversation_id = S2.sessionId, working_dir = newWorkingDir
```

**与现在行为一致**：S1 的 session_id 永远不存，只保留 S2。
**如果 restart 期间服务被杀**：thread_sessions 中 conversation_id 为空，下次进来从头开始，与现在行为相同，不会更坏。

### 4. cwd 不匹配处理

保留现有逻辑：`conversation_cwd !== working_dir` 时跳过 resume，开新 session。
这种情况在新方案下理论上不会发生（每个 thread 的 workingDir 一旦确定就绑定），作为防御性保留。

---

## 改动范围

### 新增

- `src/session/database.ts` — 新增 `thread_sessions` 表 DDL + CRUD 方法
- `src/session/manager.ts` — 新增 `getThreadSession / setThreadSession` 方法

### 修改

- `src/feishu/thread-utils.ts` — `ensureThread` 不再清空全局 `conversationId`
- `src/feishu/event-handler.ts` — `executeClaudeTask` 优先按 threadId 查 session，restart 流程写入 thread_sessions 而非全局
- DB migration — `schema_version` 升到 3，创建 `thread_sessions` 表

### 保留不变

- `sessions` 表和全局 `conversationId` 字段——兜底用，处理无 threadId 场景
- workspace restart 两阶段逻辑——行为不变，只是存储目标换成 `thread_sessions`
- resume 失败检测逻辑（`!result.success && canResume && !result.output`）

---

## 迁移策略

1. 新增 `thread_sessions` 表（schema v3）
2. 现有 `sessions` 表数据保持不变，作为兜底
3. 新消息优先走 `thread_sessions`，查不到时 fallback 到 `sessions`（兼容存量会话）
4. 稳定后可在后续版本移除全局 `conversationId` 的主路径依赖

---

## 预期效果

- 同一话题内，无论服务重启多少次，只要 `~/.claude/projects/<cwd>/<session-id>.jsonl` 文件存在，就能正确 resume
- 多个话题并行，互不干扰
- Workspace setup 流程行为不变，无需额外处理
