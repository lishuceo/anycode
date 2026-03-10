# Routing Agent 设计方案

## 背景

当用户发起新话题时，系统需要决定"在哪个仓库/目录下工作"。这个决策目前通过 `setup_workspace` MCP tool + restart 机制完成（见 `workspace-cache-and-restart.md`），存在两次 query、状态管理复杂等问题。

本方案引入独立的 **Routing Agent**，在主 Claude Code 查询启动前确定工作目录，从根本上消除 restart 主路径。

## 核心思路

Routing Agent 是一个**轻量、短生命周期的 Claude Code 实例**（Sonnet 4.6），专职做一件事：决定当前 thread 应该在哪个目录下工作。

```
Thread 第一条消息
  ↓
Routing Agent（Claude Code Sonnet 4.6，短 session，自主发现上下文）
  ├─ ls $REPO_CACHE_DIR           → 看本地缓存了什么
  ├─ ls $DEFAULT_WORK_DIR         → 看项目目录下有什么
  ├─ ls $WORKSPACE_BASE_DIR       → 看已有的工作区
  ├─ gh repo list                 → 缓存没找到时，从 GitHub 账号搜索
  ├─ 读取 session 摘要历史         → 了解上下文
  └─ 必要时向用户提问
  ↓
返回结构化路由决策
  ↓
按决策 clone / 设置 workdir / 使用默认目录
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

核心优势：**自给自足**。Routing Agent 自己去找需要的信息，不依赖我们的上下文构建代码正确无误。路由决策错误代价高（主查询在错误目录跑），自主验证比被动推理更可靠。

## Routing Agent 详细设计

### 触发条件

仅在以下情况运行：
1. **Thread 首条消息，且 workdir 未确定**（`thread_sessions` 中无记录，或 `routingState` 为 `pending_clarification`）
2. **用户显式发起 workspace 切换**（如 `/workspace <url>`）

Thread 后续消息直接跳过，使用已绑定的 workdir。

### Agent 配置

```typescript
{
  model: 'claude-sonnet-4-6',        // Sonnet 4.6：路由决策不需要 Opus 级别的推理
  maxTurns: 10,                       // 路由决策不需要太多轮次
  maxBudgetUsd: 0.5,                  // 严格预算，防止跑偏
  cwd: config.claude.defaultWorkDir,  // 路由 agent 本身不需要特定 cwd
  disableWorkspaceTool: true,         // 路由 agent 不应触发 setup_workspace
  settingSources: [],                 // 不加载任何项目 CLAUDE.md，避免干扰
  persistSession: false,              // 路由 session 用完即丢，不需要 resume
}
```

### System Prompt

```
你是一个工作区路由助手。你的唯一任务是决定用户的请求应该在哪个代码仓库/目录下执行。

## 你能做的事
- 运行 `ls ${REPO_CACHE_DIR}` 查看本地已缓存的仓库
- 运行 `ls ${DEFAULT_WORK_DIR}` 查看项目目录下的仓库
- 运行 `ls ${WORKSPACE_BASE_DIR}` 查看已有的工作区
- 运行 `ls <path>` 验证本地路径是否存在
- 运行 `gh repo list --json name,url,updatedAt --limit 50` 查看 GitHub 账号下的仓库
- 如果信息不足，向用户提问（保持简短）

## 你不能做的事
- 不要开始执行用户的实际任务
- 不要修改任何文件
- 不要 clone 仓库（由系统负责）

## 查找顺序

当用户提到某个仓库或项目名时，按以下顺序查找：

1. **本地缓存** — `ls ${REPO_CACHE_DIR}`，看有没有匹配的 bare clone
2. **项目目录** — `ls ${DEFAULT_WORK_DIR}`，看有没有匹配的目录
3. **已有工作区** — `ls ${WORKSPACE_BASE_DIR}`，看有没有之前创建的工作区
4. **GitHub 账号** — `gh repo list --json name,url --limit 50`，在用户的 GitHub 仓库中搜索匹配
5. 以上都找不到 → 如果用户给了 URL 则用 URL；否则向用户提问

## 输出格式
决策完成后，输出以下 JSON（且仅输出此 JSON）：

```json
{
  "decision": "use_existing" | "clone_remote" | "use_default" | "need_clarification",
  "workdir": "/absolute/path",           // use_existing 时必填
  "repo_url": "https://...",             // clone_remote 时必填
  "mode": "readonly" | "writable",       // clone_remote 时必填
  "branch": "main",                      // 可选，不填则用默认分支
  "question": "你想修改代码还是只读分析？" // need_clarification 时必填
}
```

## 决策类型说明

- **use_existing**: 本地已有目标仓库（在缓存、项目目录或工作区中找到），直接使用该路径
- **clone_remote**: 本地没有，但在 GitHub 账号中找到或用户提供了 URL，需要 clone
- **use_default**: 用户的请求不涉及特定仓库（如通用问题、创建新项目、闲聊等），使用默认工作目录
- **need_clarification**: 信息不足以做出决策，需要向用户提问

## 决策优先级
1. 消息中有明确 URL → clone_remote
2. 消息中有明确本地路径 → use_existing（验证路径存在）
3. 提到仓库名 → 按查找顺序在本地和 GitHub 账号中搜索
4. 不涉及特定仓库（通用问题、新项目、闲聊等）→ use_default
5. 涉及特定仓库但无法确定是哪个 → need_clarification
```

### 路由决策处理

```typescript
// 路由决策类型
interface RoutingDecision {
  decision: 'use_existing' | 'clone_remote' | 'use_default' | 'need_clarification';
  workdir?: string;        // use_existing 时必填
  repo_url?: string;       // clone_remote 时必填
  mode?: 'readonly' | 'writable';  // clone_remote 时必填
  branch?: string;         // 可选
  question?: string;       // need_clarification 时必填
}

async function routeWorkspace(
  prompt: string,
  chatId: string,
  userId: string,
  sessionSummaries: string[],
): Promise<RoutingDecision> {

  const result = await claudeExecutor.execute({
    sessionKey: `routing:${chatId}:${userId}`,
    prompt: buildRoutingPrompt(prompt, sessionSummaries),
    model: 'claude-sonnet-4-6',
    workingDir: config.claude.defaultWorkDir,
    disableWorkspaceTool: true,
    settingSources: [],
    maxTurns: 10,
    maxBudgetUsd: 0.5,
  });

  // 从输出中提取 JSON 决策
  const decision = parseRoutingDecision(result.output);

  if (decision.decision === 'need_clarification') {
    return decision;
  }

  if (decision.decision === 'clone_remote') {
    const workspace = setupWorkspace({
      repoUrl: decision.repo_url,
      mode: decision.mode,
      sourceBranch: decision.branch,
    });
    return { ...decision, workdir: workspace.workspacePath };
  }

  if (decision.decision === 'use_default') {
    return { ...decision, workdir: config.claude.defaultWorkDir };
  }

  return decision;
}
```

### `need_clarification` 状态管理

当路由 agent 需要向用户提问时，将上下文存入 `thread_sessions`，下一条消息进来时自动拼接重新路由。

#### 数据结构

```typescript
// thread_sessions 表新增 routing_state 列
interface RoutingState {
  status: 'pending_clarification';
  originalPrompt: string;   // 用户原始请求
  question: string;         // 路由 agent 的提问
}
```

#### 流程

```
1. 首条消息 "帮我看看 my-project 的 bug"
   → Routing Agent 运行，发现 my-project-frontend 和 my-project-backend 都匹配
   → 返回 need_clarification: "你是指 my-project-frontend 还是 my-project-backend？"
   → 将 routingState 存入 thread_sessions
   → 向用户发送问题，本次不执行主查询

2. 用户回复 "backend"
   → executeClaudeTask 检测到 routingState.status === 'pending_clarification'
   → 拼接上下文重新路由：
     "[原始请求] 帮我看看 my-project 的 bug\n[路由问题] 你是指 ...\n[用户回复] backend"
   → Routing Agent 重新运行，这次有足够信息做出决策
   → 清空 routingState，绑定 workdir，执行主查询
```

路由 agent 的 session 仍然 `persistSession: false`（用完即丢），不需要维护路由 agent 自身的对话状态。上下文通过拼接消息重建。

### 与 event-handler 集成

```typescript
async function executeClaudeTask(prompt, chatId, userId, messageId, rootId) {
  const threadId = await ensureThread(...);
  const threadSession = sessionManager.getThreadSession(threadId);

  let workdir: string;

  if (threadSession?.routingState?.status === 'pending_clarification') {
    // 用户回复了路由问题，拼接上下文重新路由
    const context = [
      `[原始请求] ${threadSession.routingState.originalPrompt}`,
      `[路由问题] ${threadSession.routingState.question}`,
      `[用户回复] ${prompt}`,
    ].join('\n');

    const decision = await routeWorkspace(context, chatId, userId, summaries);

    if (decision.decision === 'need_clarification') {
      // 再次需要澄清（罕见），更新 routingState
      sessionManager.setThreadRoutingState(threadId, {
        status: 'pending_clarification',
        originalPrompt: threadSession.routingState.originalPrompt,
        question: decision.question,
      });
      await feishuClient.replyText(messageId, decision.question);
      return;
    }

    workdir = decision.workdir;
    sessionManager.clearThreadRoutingState(threadId);
    sessionManager.setThreadWorkingDir(threadId, workdir);

  } else if (!threadSession?.workingDir) {
    // Thread 首条消息，需要路由
    const decision = await routeWorkspace(prompt, chatId, userId, summaries);

    if (decision.decision === 'need_clarification') {
      sessionManager.setThreadRoutingState(threadId, {
        status: 'pending_clarification',
        originalPrompt: prompt,
        question: decision.question,
      });
      await feishuClient.replyText(messageId, decision.question);
      return;
    }

    workdir = decision.workdir;
    sessionManager.setThreadWorkingDir(threadId, workdir);
  } else {
    workdir = threadSession.workingDir;
  }

  // 主查询：保留 setup_workspace 作为兜底（system prompt 中弱化，仅用户明确要求切换时触发）
  const result = await claudeExecutor.execute({
    prompt,
    workingDir: workdir,
    resumeSessionId: threadSession?.conversationId,
    // 不设置 disableWorkspaceTool — 保留 setup_workspace 作为兜底
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
- **兜底路径**：主查询保留 `setup_workspace` 工具，但在 system prompt 中弱化 —— 告诉 Claude 优先在当前目录工作，只有用户明确要求切换仓库时才调用。如果触发了 `setup_workspace`，现有 restart 机制正常生效。

**主查询不再设置 `disableWorkspaceTool: true`**，确保用户在对话中途要求切换仓库时有兜底路径。System prompt 的引导 + Routing Agent 的预决策，使得主查询中 `setup_workspace` 极少被触发。

### 与 thread→session 映射的协作

```
thread_sessions 表
  ├─ thread_id        → 飞书 thread 标识
  ├─ working_dir      → Routing Agent 决定，首条消息后绑定
  ├─ conversation_id  → 主查询 session_id，每次 resume 后更新
  ├─ conversation_cwd → 与 working_dir 同步
  └─ routing_state    → 路由状态 (JSON, nullable)
      ├─ status: 'pending_clarification'
      ├─ originalPrompt: string
      └─ question: string
```

两个方案天然互补：thread→session 解决 resume 稳定性，Routing Agent 解决首条消息 workdir 确定的质量问题。

## 潜在问题

### Routing Agent 本身失败怎么办

- **超时/报错**：降级到用户最近一次使用的 workdir（从 `session_summaries` 取最近一条的 workingDir），如果没有则用 `defaultWorkDir`
- **决策无法解析**：同上，降级 + 记录错误日志
- **预算耗尽**：说明路由问题复杂，可能需要向用户提问而非强行决策

### Routing Agent 误判怎么办

用户反馈"你在错误的仓库里"→ 两种修正方式：

1. **隐式**：用户在对话中提到另一个仓库，主查询的 `setup_workspace` 兜底触发 restart
2. **显式**：用户发 `/workspace <url>` 重置：
   - 清空 `thread_sessions.conversation_id`（旧 session 作废）
   - 重新绑定新 workdir
   - 主查询在新 workdir 全新启动

## 对 executor 的改动

### 新增 `model` 和 `settingSources` 参数

`ExecuteInput` 需要支持路由 agent 覆盖模型和设置来源：

```typescript
export interface ExecuteInput extends ExecuteOptions {
  // ... 现有字段
  /** 覆盖模型 (路由 agent 使用 Sonnet) */
  model?: string;
  /** 覆盖 settingSources (路由 agent 使用 [] 避免加载项目 CLAUDE.md) */
  settingSources?: string[];
}
```

### System prompt 弱化 setup_workspace

主查询的 `buildWorkspaceSystemPrompt()` 调整措辞，弱化 `setup_workspace` 的使用引导：

```
## 工作区管理

你当前的工作目录已经由系统预先设定好。大多数情况下直接在当前目录工作即可。

你有一个 setup_workspace 工具可用，但仅在以下情况使用：
- 用户明确要求切换到另一个仓库
- 用户提供了新的仓库 URL 要求 clone

不要主动使用 setup_workspace，除非用户明确要求。
```

## 实现步骤

1. **`src/claude/router.ts`** — Routing Agent 封装
   - `routeWorkspace()` 主函数
   - `buildRoutingPrompt()` 构建路由 prompt（注入目录路径 + 历史摘要）
   - `parseRoutingDecision()` 从输出中提取 JSON
   - 降级逻辑（失败时使用最近 workdir 或默认目录）

2. **`src/claude/executor.ts`** — 支持路由 agent 参数
   - `ExecuteInput` 新增 `model`、`settingSources` 可选字段
   - `execute()` 中使用这些字段覆盖默认配置

3. **`src/session/` 层** — routing state 管理
   - `thread_sessions` 表新增 `routing_state` 列 (JSON, nullable)
   - `SessionManager` 新增 `setThreadRoutingState()` / `clearThreadRoutingState()`
   - `SessionDatabase` 对应的 SQL 操作

4. **`src/feishu/event-handler.ts`** — 集成路由逻辑
   - `executeClaudeTask()` 在 thread 首条消息时调用 `routeWorkspace()`
   - 处理 `need_clarification` 状态和用户回复拼接
   - 主查询去掉 `disableWorkspaceTool: true`（保留兜底）

5. **`src/claude/executor.ts`** — 弱化 system prompt
   - `buildWorkspaceSystemPrompt()` 调整 `setup_workspace` 使用引导
