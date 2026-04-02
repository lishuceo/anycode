---
summary: "轻量路由 Agent：在主查询前确定工作目录，支持本地/远程/默认三种决策"
related_paths:
  - src/claude/router.ts
  - src/feishu/thread-context.ts
last_updated: "2026-04-02"
---

# Routing Agent 架构

轻量 Claude Code 实例（Sonnet），在主查询前决定工作目录。仅 thread 首条消息运行，后续消息直接复用已绑定的 workdir。

## 决策类型

```typescript
interface RoutingDecision {
  decision: 'use_existing' | 'clone_remote' | 'use_default' | 'need_clarification';
  workdir?: string;           // use_existing: 必填
  repo_url?: string;          // clone_remote: 必填
  mode?: 'readonly' | 'writable';
  branch?: string;
  question?: string;          // need_clarification: 必填
  cloneError?: string;        // clone 失败信息
  warning?: string;           // 非阻塞警告（如 cache fetch 失败）
}
```

## 项目发现

`buildRoutingSystemPrompt()` 将发现的项目信息注入 system prompt：

- **`discoverLocalProjects()`** — 扫描 `DEFAULT_WORK_DIR`，读取 `package.json` description 或 `CLAUDE.md` 首行标题，最多 30 个
- **`discoverCachedRepos()`** — 扫描 `REPO_CACHE_DIR`，从 `host/org/repo.git` 目录结构还原 URL，最多 50 个
- **自身服务检测** — `isServiceOwnRepo()` 检查 package.json name，避免误路由到 bridge 服务自身

## 决策优先级（8 级）

1. 消息中有明确 URL → `clone_remote`
2. 消息中有明确本地路径 → `use_existing`（验证路径存在）
3. 提到已知项目名 → 匹配后 `use_existing`
4. 提到缓存的远程仓库 → `clone_remote`
5. 涉及本服务自身 → `use_existing`（指向服务目录）
6. 不涉及特定仓库 → `use_default`
7. 涉及未知仓库 → `clone_remote`（若有足够信息）或 `need_clarification`
8. 信息不足 → `need_clarification`

## Agent 配置

```typescript
{
  model: 'claude-sonnet-4-6',     // 路由不需要 Opus
  maxTurns: 10,
  maxBudgetUsd: 1.0,
  timeoutSeconds: 60,
  hardTimeoutSeconds: 120,
  disableWorkspaceTool: true,     // 路由 agent 不应触发 setup_workspace
  settingSources: [],             // 不加载项目 CLAUDE.md
}
```

Session key: `routing:{chatId}:{userId}:{threadId?}`，一次性使用，不 resume。

## need_clarification 流程

当路由 agent 无法确定仓库时：

```
1. 首条消息 → Routing Agent 返回 need_clarification + question
   → 存入 ThreadSession.routingState: { status, originalPrompt, question, retryCount }
   → 向用户发送问题

2. 用户回复 → 检测到 routingState.status === 'pending_clarification'
   → 拼接上下文: "[原始请求]...\n[路由问题]...\n[用户回复]..."
   → 重新运行 Routing Agent
   → 清空 routingState，绑定 workdir
```

## 降级策略

| 失败场景 | 行为 |
|---------|------|
| 路由 agent 超时/报错 | `use_default`（defaultWorkDir）+ warning |
| JSON 解析失败 | `use_default` + warning |
| `use_existing` 路径不存在 | `use_default` + warning |
| `clone_remote` 缺 repo_url | `use_default` + warning |
| Cache fetch 失败 | 继续使用 stale cache + warning（非阻塞） |

## 文件

- `src/claude/router.ts` (345 行) — `routeWorkspace()`, `buildRoutingSystemPrompt()`, `parseRoutingDecision()`, `discoverLocalProjects()`, `discoverCachedRepos()`
- `src/feishu/thread-context.ts` — 调用 `routeWorkspace()` 并协调 session 绑定

## 设计决策

| 决策 | 理由 |
|------|------|
| 用 Claude Code 而非 Messages API | 路由 agent 可自主 ls/gh 探索，自给自足，不依赖上下文注入正确 |
| Sonnet 而非 Opus | 路由决策不需要深度推理，成本低 |
| settingSources: [] | 避免加载项目 CLAUDE.md 干扰路由判断 |
| 主查询保留 setup_workspace 兜底 | 用户在对话中途切换仓库时仍有路径 |
