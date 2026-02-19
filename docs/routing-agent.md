# Routing Agent 设计方案

## 背景

当用户发起新话题时，系统需要决定"在哪个仓库/目录下工作"。这个决策目前通过 `setup_workspace` MCP tool + restart 机制完成（见 `workspace-cache-and-restart.md`），存在两次 query、状态管理复杂等问题。

本方案引入独立的 **Routing Agent**，在主 Claude Code 查询启动前确定工作目录，从根本上消除 restart 主路径。

## 核心思路

Routing Agent 是一个**轻量、短生命周期的 Claude Code 实例**，专职做一件事：决定当前 thread 应该在哪个目录下工作。

它与主 Claude Code 查询的关系：

```
Thread 第一条消息
  ↓
Routing Agent（Claude Code，短 session，自主发现上下文）
  ├─ ls $REPO_CACHE_DIR          → 看本地缓存了什么
  ├─ gh repo list                → 看账号下有什么仓库
  ├─ 读取 session 摘要历史        → 了解上下文
  └─ 必要时向用户提问
  ↓
返回结构化路由决策
  ↓
按决策 clone / 设置 workdir
  ↓
主 Claude Code 查询从正确 CWD 启动（CLAUDE.md 直接生效，无需 restart）
  ↓
thread.conversationId = 主查询 session_id（永久绑定）

Thread 后续消息
  ↓
跳过 Routing Agent（workdir 已绑定到 thread）
  ↓
直接 resume 主查询
```

## 为什么用 Claude Code 而非 Anthropic Messages API

| 维度 | Claude Code Agent | Messages API |
|------|-------------------|--------------|
| 上下文获取 | 自主运行 Bash/gh/ls，自给自足 | 依赖我们正确注入，有遗漏 bug 风险 |
| 歧义处理 | 可直接向用户提问 | 需要我们额外实现追问流程 |
| 决策质量 | 可探索仓库内容辅助判断 | 只能用我们提供的信息推理 |
| 系统一致性 | 复用同一套 Claude Code 基础设施 | 需维护两套 AI 调用方式 |
| 系统可靠性 | 更多移动部件 | 更简单 |

核心优势：**自给自足**。Routing Agent 自己去找需要的信息，不依赖我们的上下文构建代码正确无误。路由决策错误代价高（主查询在错误目录跑），自主验证比被动推理更可靠。

## Routing Agent 详细设计

### 触发条件

仅在以下情况运行：
1. **Thread 首条消息，且 workdir 未确定**（`thread_sessions` 中无记录）
2. **用户显式发起 workspace 切换**（如 `/workspace <url>`）

Thread 后续消息直接跳过，使用已绑定的 workdir。

### Agent 配置

```typescript
{
  model: 'claude-opus-4-6',          // 与主查询一致，确保理解质量
  maxTurns: 10,                       // 路由决策不需要太多轮次
  maxBudgetUsd: 0.5,                  // 严格预算，防止跑偏
  cwd: config.claude.defaultWorkDir, // 路由 agent 本身不需要特定 cwd
  disableWorkspaceTool: true,         // 路由 agent 不应触发 setup_workspace
  settingSources: [],                 // 不加载任何项目 CLAUDE.md，避免干扰
  persistSession: false,              // 路由 session 用完即丢，不需要 resume
}
```

### System Prompt

```
你是一个工作区路由助手。你的唯一任务是决定用户的请求应该在哪个代码仓库/目录下执行。

## 你能做的事
- 运行 `ls $REPO_CACHE_DIR` 查看本地已缓存的仓库
- 运行 `gh repo list --json name,url,updatedAt --limit 50` 查看账号下的仓库
- 运行 `ls <path>` 验证本地路径是否存在
- 如果信息不足，向用户提问（保持简短）

## 你不能做的事
- 不要开始执行用户的实际任务
- 不要修改任何文件
- 不要 clone 仓库（由系统负责）

## 输出格式
决策完成后，输出以下 JSON（且仅输出此 JSON）：

```json
{
  "decision": "use_existing" | "clone_remote" | "use_local" | "need_clarification",
  "workdir": "/absolute/path",           // use_existing / use_local 时必填
  "repo_url": "https://...",             // clone_remote 时必填
  "mode": "readonly" | "writable",       // clone_remote 时必填
  "branch": "main",                      // 可选，不填则用默认分支
  "question": "你想修改代码还是只读分析？" // need_clarification 时必填
}
```

## 决策优先级
1. 消息中有明确 URL → clone_remote
2. 消息中有明确本地路径 → use_local（验证路径存在）
3. 提到仓库名 → 在缓存和账号仓库中查找匹配
4. 无明确指向，但当前 session 有工作目录 → use_existing（继续在当前目录工作）
5. 完全不明确 → need_clarification
```

### 路由决策处理

```typescript
async function routeWorkspace(
  prompt: string,
  chatId: string,
  userId: string,
  sessionSummaries: string[],
): Promise<RoutingDecision> {

  const result = await claudeExecutor.execute({
    sessionKey: `routing:${chatId}:${userId}`,
    prompt: buildRoutingPrompt(prompt, sessionSummaries),
    workingDir: config.claude.defaultWorkDir,
    disableWorkspaceTool: true,
    persistSession: false,
    maxTurns: 10,
    maxBudgetUsd: 0.5,
  });

  // 从输出中提取 JSON 决策
  const decision = parseRoutingDecision(result.output);

  if (decision.decision === 'need_clarification') {
    // 向用户提问，等待回复后重新路由
    return decision;
  }

  if (decision.decision === 'clone_remote') {
    // 执行 clone（复用 workspace/manager.ts）
    const workspace = setupWorkspace({
      repoUrl: decision.repo_url,
      mode: decision.mode,
      sourceBranch: decision.branch,
    });
    return { ...decision, workdir: workspace.workspacePath };
  }

  return decision;
}
```

### 与 event-handler 集成

```typescript
async function executeClaudeTask(prompt, chatId, userId, messageId, rootId) {
  const threadId = await ensureThread(...);
  const threadSession = sessionManager.getThreadSession(threadId);

  let workdir: string;

  if (!threadSession?.workingDir) {
    // Thread 首条消息，需要路由
    const decision = await routeWorkspace(prompt, chatId, userId, summaries);

    if (decision.decision === 'need_clarification') {
      // 发问题给用户，本次不执行主查询
      await feishuClient.replyText(messageId, decision.question);
      return;
    }

    workdir = decision.workdir;
    sessionManager.setThreadWorkdir(threadId, workdir); // 绑定到 thread
  } else {
    workdir = threadSession.workingDir;
  }

  // 正常执行主查询，从正确 CWD 启动
  const result = await claudeExecutor.execute({
    prompt,
    workingDir: workdir,
    resumeSessionId: threadSession?.conversationId,
    disableWorkspaceTool: true, // 主查询不再需要 setup_workspace
    ...
  });

  sessionManager.setThreadSession(threadId, {
    conversationId: result.sessionId,
    workingDir: workdir,
  });
}
```

## 对现有机制的影响

### restart 机制的命运

引入 Routing Agent 后：

- **主路径**：Routing Agent 决定 workdir → 主查询直接在正确 CWD 启动，无需 restart
- **兜底路径**：Routing Agent 误判（极少数情况）→ 主查询中 `setup_workspace` 触发 restart

restart 机制**保留但降级为兜底**，不再是主路径。`disableWorkspaceTool: true` 对主查询默认开启（由 Routing Agent 负责 workspace 决策），但在 Routing Agent 跳过的场景（如 Thread 后续消息切换仓库时）可按需开放。

### 与 thread→session 映射的协作

```
thread_sessions 表
  ├─ thread_id        → 飞书 thread 标识
  ├─ working_dir      → Routing Agent 决定，首条消息后永久绑定
  ├─ conversation_id  → 主查询 session_id，每次 resume 后更新
  └─ conversation_cwd → 与 working_dir 同步
```

两个方案天然互补：thread→session 解决 resume 稳定性，Routing Agent 解决首条消息 workdir 确定的质量问题。

## 潜在问题

### Routing Agent 本身失败怎么办

- **超时/报错**：降级到当前 session 的 workdir（`sessions` 表中的全局 workdir）
- **决策无法解析**：同上，降级 + 记录错误日志
- **预算耗尽**：说明路由问题复杂，可能需要向用户提问而非强行决策

### Routing Agent 误判怎么办

用户反馈"你在错误的仓库里"→ 用户显式发 `/workspace <url>` 重置。此时：
1. 清空 `thread_sessions.conversation_id`（旧 session 作废）
2. 重新路由，绑定新 workdir
3. 主查询在新 workdir 全新启动

## 实现步骤（待 thread→session 映射完成后）

1. 新增 `src/claude/router.ts` — Routing Agent 封装（执行、解析决策、处理 clarification）
2. 新增 routing system prompt 和 `buildRoutingPrompt()` 辅助函数
3. 改造 `src/feishu/event-handler.ts` — `executeClaudeTask` 在 thread 首条消息时调用 router
4. 主查询默认 `disableWorkspaceTool: true`，restart 降级为兜底
5. 新增 `/workspace <url>` slash command 支持显式切换工作区
