---
summary: "移除前置 Sonnet 路由 Agent，改为默认 DEFAULT_DIR + 主 Agent 自主触发 setup_workspace"
status: completed
owner: unclee
last_updated: "2026-04-03"
read_when:
  - 修改路由逻辑
  - 修改 thread-context.ts
  - 修改 workspace setup 流程
  - 修改 executor restart 机制
---

# 移除前置路由 Agent，主 Agent 自主路由

## 背景

当前路由模式：每个新话题的首条消息先经过独立的 Sonnet 路由 Agent 判断工作目录，再启动主 Agent 执行。

核心问题：
1. **选错仓库后无法修正** — 路由决策绑定到 thread 后 `routingCompleted = true`，后续消息永远复用，用户只能开新话题
2. **上下文太薄** — 路由 Agent 是一次性 session，只看到当前消息 + 项目名列表，不知道用户在做什么
3. **静默 fallback 太多** — 各种失败都静默降级到 defaultWorkDir，用户不知道发生了什么
4. **额外延迟和成本** — 每个新话题多一次 Sonnet 调用 (2-5s)

## 新方案

**默认在 `DEFAULT_WORK_DIR` 启动主 Agent，如果 Agent 在执行过程中判断出用户明确要在某个特定仓库工作，自行调用 `setup_workspace` MCP tool 切换。**

这套机制的核心组件已经存在：
- `setup_workspace` MCP tool（`src/workspace/tool.ts`）
- `onWorkspaceChanged` 回调 + abort（`src/claude/executor.ts:380-389`）
- restart 逻辑（`src/feishu/event-handler.ts:1761-1864`）

### 与现状的关键差异

| | 现在 | 新方案 |
|--|------|--------|
| 路由时机 | 执行前，Sonnet 单独决策 | 执行中，主 Agent 自然推理 |
| 路由上下文 | 只有当前消息 + 项目列表 | 完整对话 + CLAUDE.md + 代码上下文 |
| 选错修正 | 不可能 | 后续消息仍可触发 `setup_workspace` 切换 |
| 启动延迟 | 多一次 Sonnet 调用 | 无额外延迟 |

## 核心问题：restart 时上下文传递

### 当前 restart prompt 结构

```
┌─ system prompt (SDK 自动, 来自新 cwd 的 CLAUDE.md) ─┐
│  knowledge + workspace prompt                        │
└──────────────────────────────────────────────────────┘
┌─ executor userPromptPrefix (executor.ts:480-498) ────┐
│  memoryContext                                        │
│  botIdentityContext                                   │
│  historySummaries (跨会话摘要)                          │
│  readOnly 提示                                        │
└──────────────────────────────────────────────────────┘
┌─ effectivePrompt (event-handler.ts:1587-1619) ───────┐
│  聊天历史 (history.text)          ← ✅ 保留            │
│  历史文件内容 (history.fileTexts)  ← ✅ 保留            │
│  引用消息 (quoted message)        ← ✅ 保留            │
│  用户原始消息 + 时间戳             ← ✅ 保留            │
└──────────────────────────────────────────────────────┘
┌─ 第一次 query 中 Agent 产生的内容 ─────────────────────┐
│  Agent 的推理文本                  ← ❌ 丢失            │
│  Agent 的工具调用（Read/Grep 等）   ← ❌ 丢失            │
│  工具返回的结果（文件内容等）        ← ❌ 丢失            │
└──────────────────────────────────────────────────────┘
```

**原 prompt 和聊天历史完整保留**。丢失的是 Agent 在第一次 query 中自己产生的工作上下文。

### 当前 `result.output` 的局限

executor.ts:694-716 中，`output` 只累积 `assistant` 消息的 text block。
工具调用和工具返回结果不在 `output` 中。

### 当前 restart prompt 的重复注入问题

event-handler.ts:1800 传入 `prompt: effectivePrompt`，而 `effectivePrompt` 是在 event-handler 层构建的，**不包含** executor 层的 `userPromptPrefix`（memory/identity/history 等）。executor 的 `userPromptPrefix` 是在 executor.ts:480-498 中独立拼接的，每次 query 独立构建。

但 restart 时同时传了 `memoryContext`、`historySummaries` 等参数（line 1811-1813），executor 会再次构建 `userPromptPrefix`。这是正确的——`effectivePrompt` 和 `userPromptPrefix` 是两个独立层次，不存在重复。

### 解决方案：累积完整对话轨迹，传入第二次 query

#### SDK 消息流结构

SDK 的 `SDKMessage` union 中，工具结果通过 `SDKUserMessage`（`type: 'user'`）传递，
其 `message: MessageParam` 中包含 `tool_result` content block。
当前 executor switch 语句在 `default` 分支忽略了 `user` 类型消息。

需要新增 `case 'user'` 分支来捕获工具结果，通过 `parent_tool_use_id` 关联回对应的 tool_use block。

#### 数据结构

```typescript
// types.ts 新增
interface ToolCallTrace {
  id: string;                    // tool_use_id，用于关联 tool_result
  name: string;
  input: Record<string, unknown>;
  result?: string;               // 从 user message 的 tool_result block 回填
}

interface ConversationTurn {
  role: 'assistant';
  text: string;                  // Agent 的推理文本
  toolCalls: ToolCallTrace[];
}
```

#### executor.ts 改动

```typescript
const conversationTrace: ConversationTurn[] = [];
let pendingToolCalls = new Map<string, ToolCallTrace>();  // tool_use_id → trace

// case 'assistant': 在现有逻辑后追加
const turn: ConversationTurn = { role: 'assistant', text: '', toolCalls: [] };
for (const block of message.message?.content ?? []) {
  if ('text' in block && block.text) {
    turn.text += block.text;
  }
  if ('type' in block && block.type === 'tool_use') {
    const trace: ToolCallTrace = {
      id: block.id,
      name: block.name,
      input: block.input,
    };
    turn.toolCalls.push(trace);
    pendingToolCalls.set(block.id, trace);
  }
}
conversationTrace.push(turn);

// case 'user': 新增（当前走 default 被忽略）
case 'user': {
  // 回填工具结果到对应的 toolCall
  if (message.message?.content) {
    for (const block of message.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const trace = pendingToolCalls.get(block.tool_use_id);
        if (trace) {
          // 提取文本结果，截断到 2000 字符
          const text = block.content?.map(c => c.type === 'text' ? c.text : '').join('') ?? '';
          trace.result = text.length > 2000
            ? text.slice(0, 1500) + '\n...(truncated)...\n' + text.slice(-500)
            : text;
        }
      }
    }
  }
  break;
}
```

**累积上限**：`conversationTrace` 数组在每个 turn push 时检查总序列化长度，
超过 50KB 时丢弃最早的 turn（保留最近的），防止长时间首次 query 的内存膨胀。

#### 格式化函数（event-handler.ts）

```typescript
function formatConversationTrace(trace: ConversationTurn[]): string {
  if (!trace?.length) return '';
  const parts: string[] = [];
  for (const turn of trace) {
    if (turn.text) parts.push(turn.text);
    for (const tc of turn.toolCalls) {
      // 只保留关键输入字段，不序列化完整 input
      const inputSummary = tc.name === 'Read' ? tc.input.file_path
        : tc.name === 'Bash' ? tc.input.command
        : tc.name === 'Grep' ? `${tc.input.pattern} in ${tc.input.path ?? '.'}`
        : JSON.stringify(tc.input).slice(0, 200);
      parts.push(`[${tc.name}] ${inputSummary}`);
      if (tc.result) parts.push(tc.result);
    }
  }
  const joined = parts.join('\n');
  // 总长度上限
  if (joined.length > 15000) {
    return joined.slice(-15000);
  }
  return joined;
}
```

#### restart prompt 注入（executor.ts）

```typescript
if (input.priorContext) {
  userPromptPrefix += [
    '<prior-analysis>',
    '以下是你在切换工作区前的完整工作记录（推理、工具调用和结果）。',
    '基于此继续工作，不要重复已完成的分析。',
    '注意：文件路径可能指向旧工作区，当前已切换到新工作区。',
    '',
    input.priorContext,
    '</prior-analysis>',
    '',
  ].join('\n');
}
```

#### restart 后第二次 query 完整 prompt 结构

```
┌─ system prompt (来自新 cwd 的 CLAUDE.md) ────────────┐
│  新仓库的 knowledge + workspace prompt                │
└──────────────────────────────────────────────────────┘
┌─ executor userPromptPrefix ──────────────────────────┐
│  memoryContext                                        │
│  botIdentityContext                                   │
│  historySummaries                                     │
│  readOnly 提示                                        │
│  <prior-analysis>                          ← 新增     │
│    用户想在 repo-X 工作...                              │
│    [Bash] ls /projects                                │
│    repo-X/ repo-Y/ ...                                │
│    [Read] /projects/repo-X/package.json               │
│    { "name": "repo-x", ... }                          │
│    确认是 repo-X，调用 setup_workspace                  │
│  </prior-analysis>                                    │
└──────────────────────────────────────────────────────┘
┌─ effectivePrompt (与第一次 query 完全相同) ──────────────┐
│  聊天历史 (history.text)                               │
│  历史文件内容 (history.fileTexts)                       │
│  引用消息 (quoted message)                             │
│  用户原始消息 + 时间戳                                  │
└──────────────────────────────────────────────────────┘
```

## 后续消息的 workspace 切换能力

### 问题

当前 `isFirstMessage = !activeConversationId`（event-handler.ts:1717），
restart 后 conversationId 已存在，后续消息 `isFirstMessage = false`，
导致 `disableWorkspaceTool: true`（line 1752）——**后续消息完全无法切换 workspace**。

这直接否定了"用户可以纠错"的能力。

### 解决方案

将 `isFirstMessage` 守卫从"有无 conversationId"改为 **每条消息都允许首次 workspace 切换**，
但通过 restart 计数防止无限循环：

```typescript
// event-handler.ts
// 替换原来的 isFirstMessage 逻辑
// 每条消息允许最多 1 次 workspace 切换（setup_workspace → restart）
// restart 后的第二次 query 禁用 workspace tool（防循环）
const disableWorkspaceTool = false;  // 首次执行总是启用

// restart 时：
const restartResult = await claudeExecutor.execute({
  // ...
  disableWorkspaceTool: true,  // restart query 禁用，防止无限循环
});
```

`onWorkspaceChanged` 回调也需要同步放开——每条消息的首次 execute 都传入回调：

```typescript
onWorkspaceChanged: onWorkspaceChanged,  // 不再受 isFirstMessage 限制
```

**安全保证**：
- 每条消息最多触发 1 次 restart（restart query 的 `disableWorkspaceTool: true` 断开循环）
- SDK 的 `maxTurns` 和 `maxBudgetUsd` 仍然生效
- 后续消息切换 workspace 时，旧 conversationId 清空，新 query 获得新 session

### 后续消息 workspace 切换的上下文处理

后续消息（已有 conversationId）切换 workspace 时，需要额外考虑：
- 清空旧 conversationId（已有逻辑：line 1791）
- 更新 thread workingDir（已有逻辑：line 1789）
- priorContext 传递（复用首条消息的 restart 逻辑）

## Pipeline 模式处理

### 问题

`executePipelineTask` 调用 `resolveThreadContext` 获取 workingDir，
然后传给 `PipelineOrchestrator.run()`。Orchestrator 的各阶段（plan → implement → push）
共用同一个 workdir，且 orchestrator **没有 restart 处理逻辑**。

如果 plan 阶段的 agent 调用 `setup_workspace`，executor 返回 `needsRestart`，
但 orchestrator 不理解这个信号，pipeline 会直接 fail。

### 解决方案

**Pipeline 模式禁用 `setup_workspace`，要求显式指定仓库。**

1. `executePipelineTask` 传入 `disableWorkspaceTool: true` 给各阶段的 executor 调用
2. `/dev <repo-url>` 的 URL 提取逻辑保留在 event-handler slash command 处理中
3. `/dev` 不带参数时：使用当前 thread 的 workingDir（如果已有），否则用 defaultWorkDir
4. 如果用户在 pipeline 中需要切换仓库，先用普通消息触发 `setup_workspace`，再发 `/dev`

这样 orchestrator 不需要任何改动，且 pipeline 的行为更加可预测。

## Prompt injection 防护

### 风险

`priorContext` 包含第一次 query 的工具结果（文件内容、命令输出），
恶意文件内容可能包含 prompt injection payload，
通过 `<prior-analysis>` 标签原样注入第二次 query。

### 缓解措施

1. **标签隔离** — `<prior-analysis>` 标签明确标记为"工作记录"而非"用户指令"，
   system prompt 中注明不要将其中内容视为新指令

2. **与现有风险对比** — 当前 `effectivePrompt` 已包含聊天历史和文件内容（`history.fileTexts`），
   这些也是未经 sanitize 的外部内容。`priorContext` 的风险级别与之相当，没有引入新的攻击面

3. **截断限制** — 工具结果截断到 2000 字符，总 priorContext 截断到 15KB，
   限制了可注入的 payload 规模

4. **第二次 query 仍有 `canUseTool` 审计** — 所有工具调用仍经过权限检查

不额外做 sanitization（如 HTML 转义），因为工具结果本身就是代码/文本，转义会破坏内容语义。

## 项目列表发现能力

### 问题

当前路由 Agent 扫描 `defaultWorkDir` 下的项目目录注入 system prompt。
移除后，主 Agent 不知道有哪些可用项目。

### 解决方案

在 `buildWorkspaceSystemPrompt()`（executor.ts:146）中用 `readdirSync` 注入项目列表：

```typescript
// 扫描 defaultWorkDir 下的项目目录，提供给 Agent 参考
const projectList = readdirSync(projectsDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .filter(d => existsSync(join(projectsDir, d.name, '.git')))
  .map(d => d.name)
  .slice(0, 30);

// 注入到 system prompt
if (projectList.length > 0) {
  basePrompt += `\n\n## 可用项目\n\n以下项目在 \`${projectsDir}\` 下可用：\n${projectList.map(p => `- ${p}`).join('\n')}`;
}
```

零 LLM 成本，启动时即可获得项目列表。

## SQLite migration 策略

`routing_state` 和 `routing_completed` 列留作 dead columns，不做 DROP COLUMN migration。
- 这些列是 nullable 的
- 写入路径删除后，新 session 不会再写入
- 读取路径删除后，旧值被忽略
- 避免 SQLite 版本兼容问题（`DROP COLUMN` 需要 SQLite 3.35.0+）

## Greeting card 更新

当前 `buildGreetingCard()` 初始文案为"⏳ 正在初始化工作目录..."。

移除路由后不再有"初始化工作目录"阶段，改为：
- 初始文案："⏳ 正在启动..."
- `buildGreetingCardReady()` 逻辑不变，显示 threadId + workingDir
- 如果 workspace 通过 `setup_workspace` 切换，在 `onWorkspaceChanged` 回调中
  更新 greeting card 显示新的 workingDir

## 成本影响

| 场景 | 现在 | 新方案 |
|------|------|--------|
| 不需要切换仓库 | Sonnet 路由 (~$0.01) + Opus 执行 | Opus 执行（省掉路由） |
| 需要切换仓库 | Sonnet 路由 (~$0.01) + Opus 执行 | Opus Q1 (部分, ~$0.05-0.2) + Opus Q2 (完整) |
| 路由选错 | Sonnet + Opus 在错误仓库执行完整任务 | 不适用（主 Agent 判断更准） |

大多数消息不需要切换仓库，整体成本下降（省掉每个话题的 Sonnet 路由）。
需要切换时，Q1 的 token 浪费是代价，但通常很小（Agent 很快就会判断出需要切换）。

`maxBudgetUsd` 是 per-query 限制。restart 后两个 query 的费用在 event-handler 中合并报告
（line 1834-1836），用户看到的是总费用。

## 实施步骤

### Phase 1: 放开后续消息的 workspace 切换

**目标**：让每条消息都能触发 workspace 切换，而不仅是首条消息。

1. **event-handler.ts** — 删除 `isFirstMessage` 对 `disableWorkspaceTool` 和 `onWorkspaceChanged` 的限制
2. **event-handler.ts** — restart 后的第二次 query 保持 `disableWorkspaceTool: true`（防循环）
3. **event-handler.ts** — restart 时清空 conversationId 和更新 workingDir（已有逻辑，确认仍正确）

### Phase 2: 简化 thread-context.ts

**删除路由状态机**，`resolveThreadContext` 简化为：

```
ensureThread → session 管理 → workingDir 确定（无路由） → greeting 更新
```

1. 删除 `pending_clarification` 分支（line 125-199）
2. 删除首条消息路由分支中调用 `routeWorkspace()` 的逻辑（line 201-253）
3. 首条消息直接使用 `config.claude.defaultWorkDir`
4. 保留后续消息使用 `threadSession.workingDir`（setup_workspace 切换后值会更新）
5. 保留 stale workspace 检测和 greeting 更新
6. 删除 `resolveWorkdir()` 辅助函数

### Phase 3: 增强 restart 上下文传递

1. **types.ts** — 新增 `ToolCallTrace`、`ConversationTurn` 接口；`ClaudeResult` 新增 `conversationTrace` 字段；`ExecuteInput` 新增 `priorContext?: string` 字段
2. **executor.ts** — 在 `case 'assistant'` 中构建 `ConversationTurn`，记录 text + tool_use blocks（含 `id`）
3. **executor.ts** — 新增 `case 'user'` 分支，从 `message.message.content` 中提取 `tool_result` blocks，通过 `tool_use_id` 关联回 `pendingToolCalls` map 回填结果
4. **executor.ts** — 累积上限：总序列化超 50KB 时丢弃最早 turn
5. **executor.ts** — `priorContext` 拼入 `userPromptPrefix`，用 `<prior-analysis>` 标签包裹
6. **event-handler.ts** — `formatConversationTrace()` 函数：格式化对话轨迹为文本，工具结果截断到 2000 字符，总输出截断到 15KB
7. **event-handler.ts** — restart 调用时传入 `priorContext: formatConversationTrace(result.conversationTrace)`

### Phase 4: 清理

1. **删除 `src/claude/router.ts`** — 整个路由 Agent 文件
2. **删除 `src/claude/router.test.ts`**（如果存在）
3. **session 类型清理** — `routingState`, `routingCompleted` 类型定义标记为 deprecated 但保留（SQLite dead columns）
4. **session manager 方法清理** — 删除 `setThreadRoutingState`, `clearThreadRoutingState`, `markThreadRoutingCompleted`
5. **executor.ts** — 删除 `routing:` prefixed session key 的特殊处理
6. **message-builder.ts** — greeting card 文案从"初始化工作目录"改为"正在启动"
7. **更新 `/project` 和 `/workspace` slash 命令** — 保留，作为用户手动覆盖方式
8. **更新测试** — thread-context.test.ts 中路由相关测试用例删除，新增 workspace 切换测试
9. **更新 CLAUDE.md** — 架构描述，移除路由 Agent 相关内容

### Phase 5: 优化 setup_workspace tool description + 项目列表注入

1. **workspace/tool.ts** — 更新 tool description 为更主动的引导（见下方）
2. **executor.ts `buildWorkspaceSystemPrompt()`** — 用 `readdirSync` 注入项目列表

Tool description 更新：

```
为代码任务创建隔离工作区。

当你判断用户的请求明确指向某个特定仓库或项目，且当前工作目录不是该仓库时，
使用此工具切换到正确的工作区。切换后系统会自动重启以加载项目配置。

应该使用的场景：
- 用户提到了仓库 URL（如 github.com/org/repo）
- 用户提到了已知的项目名（参考 system prompt 中的可用项目列表）
- 用户描述的代码/功能明显属于另一个仓库
- 用户说"切换到 X"、"去 X 仓库"

不要在以下情况使用：
- 用户的问题是通用的，不指向特定仓库
- 当前工作目录已经是正确的仓库
- 不要用此工具切换当前工作区的模式（readonly/writable）

通常使用 mode="writable" 创建可修改的隔离工作区和 feature 分支。
调用后仅输出简短确认，不要继续执行后续任务（系统会自动重启）。
```

### Phase 6: Pipeline 模式适配

1. **event-handler.ts `executePipelineTask`** — 不再依赖路由，直接用 defaultWorkDir 或 thread 已有的 workingDir
2. **pipeline orchestrator** — 各阶段 executor 调用保持 `disableWorkspaceTool: true`（pipeline 不支持 mid-execution workspace 切换）
3. **`/dev <url>` 处理** — 保留 slash command 层面的 URL 提取 + `setupWorkspace` 调用，在 pipeline 创建前就完成 workspace 准备
