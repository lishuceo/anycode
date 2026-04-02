---
summary: "Thread 级会话绑定：threadId → workdir/conversationId 持久化映射"
related_paths:
  - src/session/**
  - src/feishu/thread-context.ts
last_updated: "2026-04-02"
---

# Session 架构

两层会话模型：chat 级 session（历史兼容）和 thread 级 session（主要使用）。

## Session Key 格式

- **Chat session**: `agent:{agentId}:{chatId}:{userId}`（如 `agent:dev:C123:U456`）
- **Thread session**: `agent:{agentId}:{threadId}`（如 `agent:dev:omt_xxxxx`）
- 默认 agentId: `'dev'`

## ThreadSession 结构

```typescript
interface ThreadSession {
  threadId: string;              // 飞书话题 ID（含 agent 前缀）
  chatId: string;
  userId: string;
  workingDir: string;            // 路由阶段绑定
  conversationId?: string;       // Claude Code session_id（用于 resume）
  conversationCwd?: string;      // 创建 conversationId 时的 cwd
  systemPromptHash?: string;     // system prompt hash（变化时自动重置 session）
  routingCompleted?: boolean;    // 路由是否完成
  routingState?: RoutingState;   // need_clarification 时保存
  pipelineContext?: PipelineContext;  // pipeline 执行后保存（用于后续 history 注入）
  approved?: boolean;            // owner 审批状态
}
```

## 数据库

SQLite 持久化，13 次 migration 演化：

| 表 | 用途 |
|---|------|
| `sessions` | Chat 级 session（key, working_dir, conversation_id, status 等） |
| `thread_sessions` | Thread 级 session（上述 ThreadSession 所有字段） |
| `session_summaries` | 对话摘要（自动生成，独立于 cleanup） |
| `user_tokens` | OAuth token（含 account_id 标识签发的 bot） |

## Session Manager 关键方法

| 方法 | 用途 |
|------|------|
| `getOrCreate(chatId, userId, agentId?)` | 获取或创建 chat session |
| `tryAcquire(chatId, userId)` | 原子 CAS 锁（idle → busy） |
| `getThreadSession(threadId)` | 获取 thread session |
| `upsertThreadSession()` | 创建/更新 thread session |
| `setThreadConversationId()` | 绑定 Claude Code session |
| `resetThreadConversation()` | 重置（cwd 变化时清空 conversationId） |
| `setThreadRoutingState()` / `clearThreadRoutingState()` | 管理路由状态 |
| `markThreadRoutingCompleted()` | 路由完成标记 |
| `setThreadPipelineContext()` | 保存 pipeline 结果 |
| `touchThreadSession()` | 刷新 updated_at 防止被 cleanup |

## 完整流程

```
消息到达（带 threadId）
  ↓
查找 ThreadSession
  ├── 无记录 → 运行 Routing Agent → 绑定 workdir → 创建 ThreadSession
  ├── routingState = pending_clarification → 拼接上下文重新路由
  ├── 有 workdir + conversationId → 检查 cwd 和 systemPromptHash 匹配 → resume
  └── 有 workdir 无 conversationId → 新建 Claude Code session
  ↓
执行 Claude Code query
  ↓
保存 conversationId（用于后续 resume）
```

### System Prompt Hash 自动重置

`systemPromptHash` 记录创建 session 时的 prompt hash。当 agent 配置或 CLAUDE.md 变化导致 hash 不同时，自动清空 `conversationId`，强制创建新 session（避免 resume 到旧 prompt 的 session）。

## 文件

- `src/session/manager.ts` — Session CRUD + 锁 + 清理
- `src/session/database.ts` — SQLite schema + migrations（v1-v13）
- `src/session/types.ts` — ThreadSession, RoutingState, PipelineContext
- `src/session/queue.ts` — Per-chat FIFO 任务队列（一个 chat 同时只执行一个 query）
- `src/feishu/thread-context.ts` — 统一编排：routing → workspace → session 绑定

## 设计决策

| 决策 | 理由 |
|------|------|
| Thread 级而非 Chat 级 session | 同一群聊可能有多个并行话题，需要独立 workdir |
| SQLite 持久化 | 服务重启后不丢失 session 绑定 |
| 原子 CAS 锁 | 防止同一 chat 并发执行多个 query |
| systemPromptHash 自动重置 | 配置变化后不 resume 到过期的 session |
| Agent 前缀在 key 中 | 多 agent 场景下同一 thread 不同 agent 需要独立 session |
