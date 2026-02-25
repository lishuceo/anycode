# Plan 4: 多 Agent 角色架构

> 日期: 2026-02-24
> 状态: 草案
> 前置依赖: Plan 1 (渠道插件化) 可并行推进，不强依赖

---

## 一、背景与动机

当前 Anywhere-Code 是**单 Agent 模型**：所有用户消息都由同一个 Claude Code agent 处理，具备完整的代码读写能力。这带来几个问题：

1. **Non-owner 风险** — 非仓库 owner 的用户消息也由同一个有写权限的 agent 处理，虽然有 read-only 模式，但缺乏"先讨论方案再动代码"的过渡阶段
2. **角色单一** — 所有交互（方案讨论、代码开发、问题咨询）都是同一个 agent 人格，无法针对不同场景优化 prompt 和工具集
3. **成本浪费** — 简单聊天也用 Opus 全量工具集执行，成本高
4. **扩展性差** — 无法引入产品经理、项目管理、领域专家等不同角色

### 目标

引入 **Chat Agent** 作为默认交互入口，建立**多角色 Agent 体系**，支持：
- Chat Agent：只读、方案讨论、知识问答、可调度其他 agent
- Dev Agent：当前的 Claude Code agent，代码读写
- 未来角色：PM、项目管理、客服、领域专家等

### 参考

- OpenClaw 多 agent 群聊实现（见 `docs/openclaw-analysis.md`）
- 飞书 bot-to-bot 通信限制（见下文技术调研）

---

## 二、核心设计决策

### 决策 1: 多 Bot 账号 + 单后端服务

```
飞书云
 ├─ ChatBot (App ID: cli_aaa) ◄──WS──┐
 ├─ DevBot  (App ID: cli_bbb) ◄──WS──┼──► Anywhere-Code (单 Node 进程)
 └─ PMBot   (App ID: cli_ccc) ◄──WS──┘        │
                                          多账号管理层
                                               │
                                          Binding 路由
                                               │
                                     ┌─────────┼─────────┐
                                   Chat      Dev       PM
                                   Agent     Agent     Agent
```

**理由：**
- 用户通过 @不同 bot 来选择角色，体验直观
- 后端共享 session store、workspace manager、权限系统，避免重复建设
- Agent 间调度走内部函数调用（不走飞书消息），可靠且无循环风险
- 与 OpenClaw 验证过的架构一致

**飞书限制结论（已调研）：**
- Bot 自己发的消息**不触发**自己的 `im.message.receive_v1` 事件
- 其他 bot 发的消息在开启"获取群组中所有消息"权限后**可以收到**（sender_type = "app"）
- Bot 之间**不能私聊**，只能在群里通信
- 官方建议过滤 sender_type = "app" 消息，防死循环
- **结论：不依赖飞书消息做 agent 间通信，走内部调度**

### 决策 2: 声明式 Binding 路由

借鉴 OpenClaw 的 `bindings[]` 模式，声明式配置 agent 路由：

```typescript
// 配置示例
const bindings: AgentBinding[] = [
  // 最高优先级：特定群绑定特定 agent
  { agentId: 'dev', match: { accountId: 'dev-bot', peer: { kind: 'group', id: 'oc_xxx' } } },
  // 按 bot 账号路由（默认规则）
  { agentId: 'chat', match: { accountId: 'chat-bot' } },
  { agentId: 'dev',  match: { accountId: 'dev-bot' } },
  { agentId: 'pm',   match: { accountId: 'pm-bot' } },
  // 兜底
  { agentId: 'chat', match: { accountId: '*' } },
];
```

First match wins，支持 `(accountId, peer, userId)` 多维度匹配。

### 决策 3: Agent 间调度走内部 MCP Tool

Chat Agent 通过 MCP tool `invoke_agent` 调度其他 agent（如触发 Dev Agent 开发）。类似现有 `setup_workspace` 的模式：agent 发起 tool call → 系统拦截 → 执行调度逻辑。

```
ChatBot 用户对话 → Chat Agent 判断需要开发
  → Chat Agent 调用 invoke_agent({ target: 'dev', task: '...' })
  → 系统拦截 tool call
  → 调用者身份验证（通过闭包绑定，不信任 tool input 中的身份字段）
  → 权限检查（non-owner 需审批）
  → 异步启动 Dev Agent 执行（独立队列，不阻塞 Chat Agent）
  → Dev Agent 结果通过 DevBot 直接发回群里
  → Chat Agent 收到 { status: 'started' } 立即返回
```

**安全约束：**
- 调用者 agentId 由 MCP server 闭包绑定（创建时注入），不从 tool input 读取，防止伪造
- `context` 字段注入 Dev Agent 时标记为不可信用户内容，Dev Agent prompt 中明确提示"以下方案摘要由 Chat Agent 生成，需自行验证合理性"
- 审批卡片展示实际的 `task` + `context` 内容（而非用户原始消息），让 Owner 审批的是真正要执行的内容
- 每个 agent 有独立的 `maxBudgetUsd` 限制，invoke_agent 触发的 Dev Agent 不共享 Chat Agent 的预算

---

## 三、Agent 角色定义

### Chat Agent（方案讨论 / 默认入口）

| 属性 | 值 |
|------|------|
| 飞书身份 | 独立 Bot 应用 (ChatBot) |
| 默认 Model | Sonnet 4.6（成本低，聊天够用） |
| 工具白名单 | `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task`, `invoke_agent` |
| 禁止工具 | `Edit`, `Write`, `Bash`, `NotebookEdit`, `Skill` |
| System Prompt | 方案讨论专用：引导用户明确需求、分析代码架构、制定方案、决定是否需要开发 |
| 读取 CLAUDE.md | 是（了解项目上下文） |
| Session 隔离 | 独立 conversationId，key: `chat:{chatId}:{threadId}` |

**核心能力：**
- 阅读和分析代码（只读）
- 与用户讨论方案、回答问题
- 调用 `invoke_agent` 触发 Dev Agent 开发
- Non-owner 无需审批即可使用（只读无风险）

### Dev Agent（代码开发 / 当前 Agent）

| 属性 | 值 |
|------|------|
| 飞书身份 | 独立 Bot 应用 (DevBot) |
| 默认 Model | Opus 4.6（代码开发需要强能力） |
| 工具白名单 | 全部工具 + `setup_workspace` MCP tool |
| System Prompt | 当前的开发 agent prompt（含 CLAUDE.md） |
| 读取 CLAUDE.md | 是 |
| Session 隔离 | 独立 conversationId，key: `dev:{chatId}:{threadId}` |

**触发方式：**
- 用户直接 @DevBot 发消息
- Chat Agent 通过 `invoke_agent` 调度
- `/dev` 命令（兼容现有流程）

### 未来角色（示例）

| 角色 | Model | 工具集 | 典型用途 |
|------|-------|--------|---------|
| PM Agent | Sonnet | Read, Glob, Grep, WebSearch | 需求梳理、PRD 编写、进度追踪 |
| Support Agent | Haiku | Read, Glob, Grep, WebSearch | 引擎使用问题答疑、文档查询 |
| Review Agent | Opus | Read, Glob, Grep | 代码审查（已有 pipeline reviewer 基础） |

---

## 四、架构设计

### 4.1 新增文件结构

```
src/
  agent/
    types.ts              # AgentRole, AgentConfig, AgentBinding 等类型
    registry.ts           # Agent 注册表：role → config 映射
    router.ts             # Binding 路由：inbound message → agentId（纯配置匹配，不含 LLM）
    dispatcher.ts         # Agent 间调度：invoke_agent 实现
    tool.ts               # invoke_agent MCP tool 定义（独立于 workspace/tool.ts）
    prompts/
      chat.ts             # Chat Agent system prompt
      dev.ts              # Dev Agent system prompt（现有 prompt 迁移）
      pm.ts               # PM Agent system prompt (future)
  feishu/
    multi-account.ts      # 多 Bot 账号管理（新增）
    event-handler.ts      # 改造：接入 agent router + 事件处理顺序调整
    client.ts             # 改造：从单例改为 per-account 实例池
    request-context.ts    # RequestContext 对象，携带 accountId 贯穿调用链
  session/
    manager.ts            # 改造：session key + queue key + session lock 加 agentId 前缀
```

### 4.2 多账号管理

当前 `feishuClient` 是模块级单例。改造为 per-account 实例池：

```typescript
// src/feishu/multi-account.ts

interface BotAccount {
  accountId: string;        // 'chat-bot' | 'dev-bot' | 'pm-bot'
  appId: string;
  appSecret: string;
  botName: string;
  client: lark.Client;      // 独立 SDK 实例
  wsClient: lark.WSClient;  // 独立 WebSocket 连接
  botOpenId?: string;        // 运行时填充，用于 @mention 检测
}

class AccountManager {
  private accounts: Map<string, BotAccount> = new Map();

  /** 初始化所有 bot 账号，建立 WebSocket 连接 */
  async initialize(configs: BotAccountConfig[]): Promise<void>;

  /** 根据 accountId 获取对应 client */
  getClient(accountId: string): lark.Client;

  /** 根据 appId 反查 accountId（事件回调时用） */
  resolveAccountId(appId: string): string | undefined;

  /** 获取某个 bot 的 open_id（@mention 检测用） */
  getBotOpenId(accountId: string): string | undefined;

  /** 获取所有已注册 bot 的 open_id 集合（@mention 过滤用） */
  getAllBotOpenIds(): Set<string>;
}

export const accountManager = new AccountManager();
```

**feishuClient 迁移策略：** 现有 7+ 个模块直接引用 `feishuClient` 单例。为避免逐个参数穿透 `accountId`，引入 `RequestContext` 对象：

```typescript
// src/feishu/request-context.ts

interface RequestContext {
  accountId: string;
  agentId: AgentId;
  chatId: string;
  threadId?: string;
  userId: string;
  /** 获取当前 context 对应的飞书 client */
  getFeishuClient(): FeishuClient;
}
```

事件处理入口创建 `RequestContext`，之后所有调用链通过 ctx 获取 client，不再直接引用 `feishuClient` 全局单例。单 bot 兼容模式下，RequestContext 始终返回唯一的 client 实例。

**跨 bot 回复验证（Phase 1 必须验证）：** 当 invoke_agent 触发 DevBot 在 ChatBot 创建的 thread 中回复时，需要确认飞书 API 允许 Bot B reply_in_thread 到 Bot A 创建的消息。Phase 1 第一步创建两个测试 bot 时同步验证此行为。如果不支持，fallback 方案：DevBot 创建独立 thread 并 @用户。

### 4.3 两层路由：Binding Router + Workspace Router

本方案引入的 Binding Router（选 agent 角色）与现有的 Workspace Router（选工作目录）是两个独立层次，执行顺序明确：

```
消息进入
  ↓
① shouldRespond() — @mention 过滤（本 bot 该不该处理这条消息？）
  ↓
② Binding Router (src/agent/router.ts) — 选 agent 角色
  ↓
③ Slash command 路由 (/dev, /help 等) — 在 agent 角色确定后执行
  ↓
④ Workspace Router (src/claude/router.ts, 现有) — 选工作目录
  ↓
⑤ Agent 执行
```

**关键澄清：**
- **Binding Router** 是新增的 `src/agent/router.ts`，纯配置匹配，不调用 LLM
- **Workspace Router** 是现有的 `src/claude/router.ts`，调用 LLM 决定工作目录
- Workspace Router 是**系统级组件**，独立于 agent 权限模型运行——它使用自己的 executor 配置（含 Bash 工具、Sonnet 模型），不受 Chat Agent 的工具白名单限制
- 两者命名区分清楚：binding router（agent 路由） vs workspace router（目录路由）

**`/dev` 命令路由修正：** `/dev` 等 slash command 必须在 binding 路由之后执行。如果 `/dev` 发给了 ChatBot：
- 视为隐式 `invoke_agent({ target: 'dev', task: ... })`，走 dispatcher 异步调度
- 不在 ChatBot 的上下文中直接启动 pipeline

```typescript
// src/agent/types.ts

type AgentId = 'chat' | 'dev' | 'pm' | string;

interface AgentBinding {
  agentId: AgentId;
  match: {
    accountId?: string;               // bot 账号，'*' = 任意
    peer?: {
      kind: 'group' | 'direct';
      id: string;                     // chatId
    };
    userId?: string;                  // 特定用户
  };
}

interface AgentConfig {
  id: AgentId;
  displayName: string;
  model: string;                      // 'claude-opus-4-6' | 'claude-sonnet-4-6'
  /** 工具限制通过 canUseTool 回调实现，而非 allowedTools 参数
   *  （SDK 的 allowedTools 是启用列表不是限制列表） */
  toolPolicy: 'all' | 'readonly';
  systemPromptBuilder: (ctx: AgentContext) => string;
  readOnly: boolean;
  settingSources: ('user' | 'project')[];
  maxBudgetUsd: number;
  maxTurns: number;
}
```

**Binding 配置校验（启动时）：**
- 检查是否存在至少一个 non-wildcard binding 指向写权限 agent
- 检查 wildcard binding 是否指向只读 agent（防止配置错误导致所有消息进入写权限 agent）
- 配置不合法时 warn 但不阻止启动

```typescript
// src/agent/router.ts

/**
 * First-match-wins 路由
 * 按优先级：peer > userId > accountId > wildcard
 */
function resolveAgent(
  bindings: AgentBinding[],
  inbound: { accountId: string; chatId: string; userId: string; chatType: 'group' | 'p2p' }
): AgentId {
  for (const binding of bindings) {
    if (matchesBinding(binding.match, inbound)) {
      return binding.agentId;
    }
  }
  return 'chat'; // 兜底走 chat agent
}
```

### 4.4 Agent 间调度 (invoke_agent)

**关键设计：纯异步，不阻塞调用方。** 原因：
- 如果 Chat Agent 同步等待 Dev Agent（`waitForResult: true`），会导致 Task Queue 死锁（两者共享 queue key）和 Session busy lock 冲突
- Dev Agent 可能运行数分钟甚至数十分钟，超过 Chat Agent 的 idle timeout (300s)

```typescript
// src/agent/dispatcher.ts

interface InvokeAgentInput {
  target: AgentId;           // 'dev' | 'pm' | ...
  task: string;              // 要执行的任务描述
  context?: string;          // Chat Agent 整理的方案/上下文摘要（标记为不可信内容）
  // 注意：没有 waitForResult，强制异步
}

interface InvokeAgentResult {
  status: 'started' | 'pending_approval' | 'rejected';
  approvalCardId?: string;   // 需要审批时，审批卡片的 message_id
}

class AgentDispatcher {
  /**
   * Chat Agent 调用 invoke_agent 时的入口（纯异步）
   *
   * 安全：source.agentId 由 MCP server 闭包绑定，不从 tool input 读取
   *
   * 流程：
   * 1. 权限检查（non-owner → 发审批卡片，返回 pending_approval）
   * 2. 验证 target agent 存在且调用者有权调度（调度权限矩阵）
   * 3. 打包上下文（context 标记为 untrusted_agent_context）
   * 4. 在独立队列中异步启动 target agent（见 4.7 并发设计）
   * 5. 立即返回 { status: 'started' }，Chat Agent 可通知用户 "DevBot 已开始工作"
   * 6. Dev Agent 结果通过 DevBot 的飞书 client 直接发送到 thread
   */
  async invoke(
    source: { agentId: AgentId; threadId: string; userId: string; accountId: string },
    input: InvokeAgentInput,
  ): Promise<InvokeAgentResult>;
}
```

### 4.5 Session Key 改造

当前 session key: `chatId:userId`，thread session key: `threadId`

改造后加 agentId 前缀，避免碰撞：

```
Session key:        agent:{agentId}:{chatId}:{userId}
Thread session key: agent:{agentId}:{threadId}
```

不同 agent 在同一个 thread 里各有独立的 conversation history。

**迁移策略：** 服务启动时执行一次性 DB migration（在事件处理之前）：
```sql
-- thread_sessions: threadId → agent:dev:{threadId}
UPDATE thread_sessions SET thread_id = 'agent:dev:' || thread_id
  WHERE thread_id NOT LIKE 'agent:%';
-- sessions: chatId:userId → agent:dev:{chatId}:{userId}
UPDATE sessions SET key = 'agent:dev:' || key
  WHERE key NOT LIKE 'agent:%';
```
不做运行时 fallback，避免创建重复记录。

**关联改造：** `killSessionsForChat(chatId, userId)` 的前缀匹配逻辑需同步更新，改为遍历所有 agent 前缀或用 `LIKE 'agent:%:${chatId}:${userId}%'` 查询。

### 4.6 并发设计（Task Queue / Session Lock）

当前系统的并发控制有两层，都需要改造以支持多 agent：

**Task Queue — 改为 agent 感知：**

```
当前 queue key:  {chatId}:{threadId}    → 同 thread 所有消息串行
改造后 queue key: {agentId}:{chatId}:{threadId} → 同 thread 同 agent 串行，不同 agent 并行
```

这意味着 ChatBot 和 DevBot 可以在同一个 thread 中并行工作。同一个 agent 的多条消息仍然串行（保持一致性）。

**Session busy lock — 改为 agent 感知：**

```
当前: sessionManager.tryAcquire(chatId, userId)      → 全局锁
改造: sessionManager.tryAcquire(agentId, chatId, userId) → per-agent 锁
```

**invoke_agent 的并发路径（关键）：**

```
Chat Agent 调用 invoke_agent
  ↓
MCP tool handler 拦截（在 Chat Agent 的 query 内部）
  ↓
agentDispatcher.invoke() —— 不进入 Chat Agent 的 queue
  ↓
在 Dev Agent 的独立 queue 中 enqueue：
  queue key = dev:{chatId}:{threadId}
  ↓
立即返回 { status: 'started' } 给 Chat Agent
  ↓（异步）
Dev Agent queue 处理任务，使用 Dev Agent 的 session lock：
  sessionManager.tryAcquire('dev', chatId, userId)
  ↓
Dev Agent 执行完毕，通过 DevBot client 发送结果
```

此设计避免了死锁：Chat Agent 不等待 Dev Agent，两者在不同的 queue 和 session lock 中运行。

### 4.7 上下文传递

Chat Agent → Dev Agent 的上下文传递是关键挑战。方案：

```
Chat Agent 讨论完毕
  ↓
调用 invoke_agent({ target: 'dev', task: '...', context: '...' })
  ↓
Dispatcher 将 context 以不可信标记注入 Dev Agent 的 user prompt：
  "[由 Chat Agent 生成的方案摘要 — 请自行验证合理性后执行]\n{context}"
  ↓
Dev Agent 基于方案开始开发
```

**安全：** context 注入为 user message 而非 system prompt（避免提权），并明确标记来源，让 Dev Agent 有判断力处理不合理的内容。

Chat Agent 的 `invoke_agent` prompt 应引导它生成结构化的 context：
- 明确要做什么（需求描述）
- 明确不做什么（边界约束）
- 技术方案要点
- 涉及的文件/模块

---

## 五、Non-Owner 授权流程

### 场景矩阵

| 用户身份 | @ChatBot | @DevBot | Chat → invoke DevBot |
|---------|----------|---------|---------------------|
| Owner | 直接使用 | 直接使用 | 直接执行 |
| Non-owner (已授权) | 直接使用 | 直接使用 | 直接执行 |
| Non-owner (未授权) | 直接使用（只读无风险） | 发审批卡片给 Owner | 发审批卡片给 Owner |

### 审批流程

```
Non-owner @DevBot "帮我改一下 xxx"
  ↓
系统检测：non-owner + 写权限 agent → 需要审批
  ↓
DevBot 发审批卡片（飞书交互卡片）：
  ┌──────────────────────────────────┐
  │ 🔐 开发权限申请                    │
  │                                  │
  │ 用户: @张三                       │
  │ 请求: 帮我改一下 xxx               │
  │ Agent: DevBot (代码读写)          │
  │ 工作区: anywhere-code/feat/...    │
  │                                  │
  │ [✅ 允许] [❌ 拒绝] [📖 改为只读]  │
  └──────────────────────────────────┘
  ↓
Owner 点击 [允许]
  ↓
DevBot 开始执行（per-thread 缓存授权，后续消息无需再审批）
```

改造点：现有 `src/feishu/approval.ts` 已有 per-thread 审批机制，扩展为区分 agent 级别：
- Chat Agent: 无需审批（只读）
- Dev Agent: non-owner 需审批（写权限）
- 审批粒度: per-thread per-agent
- **关键：** `threadToApproval` Map 和 `checkAndRequestApproval` 的 key 从 `threadId` 改为 `agentId:threadId`，避免跨 agent 审批状态碰撞
- 审批卡片展示 invoke_agent 的实际 `task` + `context`，而非用户原始消息（确保 Owner 审批的是真正要执行的内容）

---

## 六、群内多 Bot 共存策略

### 6.1 消息去重（Critical — 不修复则多 bot 不工作）

**问题：** 单进程内多 bot 共享 `processedMessages` Map。当 Bot A 处理 messageId=M1 后标记为已处理，Bot B 收到同一条 M1 时被误判为重复而丢弃——即使 M1 是 @Bot B 的消息。

**修复：** dedup key 从 `messageId` 改为 `accountId:messageId`：

```typescript
// 改造前
const dedupKey = messageId;

// 改造后
const dedupKey = `${accountId}:${messageId}`;
```

每个 bot 独立判断自己是否已经处理过该消息，互不干扰。

### 6.2 @Mention 路由

当多个 bot 共存于同一个群时：

```typescript
// 事件处理时判断是否应该响应
function shouldRespond(
  event: MessageEvent,
  botOpenId: string,
  allBotOpenIds: Set<string>,  // 所有已注册 bot 的 open_id
  commanderBotOpenId?: string, // 当前群的 commander bot
): boolean {
  // 私聊：始终响应
  if (event.chat_type === 'p2p') return true;

  const mentions = event.mentions ?? [];
  const mentionedBotIds = new Set(
    mentions.filter(m => allBotOpenIds.has(m.id.open_id)).map(m => m.id.open_id)
  );

  // 规则 1: 如果消息明确 @了某个 bot，只有被 @的 bot 响应（@mention 优先级 > commander）
  if (mentionedBotIds.size > 0) {
    return mentionedBotIds.has(botOpenId);
  }

  // 规则 2: 没有 @任何 bot 时，commander bot 响应
  if (commanderBotOpenId && botOpenId === commanderBotOpenId) {
    return true;
  }

  // 规则 3: 没有 @，也没有 commander → 不响应
  return false;
}
```

**关键：** 显式 @mention 优先级高于 commander 模式，避免双重处理。

### 6.3 Commander 模式（可选）

如果一个群里想要"不 @也能聊"的体验，可以指定一个 bot 为 commander：

```typescript
// 配置
const groupConfig = {
  'oc_xxx': {
    commander: 'chat-bot',  // ChatBot 不需要 @也响应（但 @其他 bot 时让位）
    // 未列出的 bot 只响应 @mention
  }
};
```

**边界规则：**
- 用户 @DevBot → 只有 DevBot 响应，Commander ChatBot 不响应
- 用户不 @任何 bot → Commander ChatBot 响应
- 用户同时 @ChatBot 和 @DevBot → 两个 bot 都响应（用户明确意图）

---

## 七、配置设计

### 环境变量

```bash
# 多 Bot 账号（JSON 格式）
BOT_ACCOUNTS='[
  { "accountId": "chat-bot", "appId": "cli_aaa", "appSecret": "secret_aaa", "botName": "ChatBot" },
  { "accountId": "dev-bot",  "appId": "cli_bbb", "appSecret": "secret_bbb", "botName": "DevBot" }
]'

# Agent 路由（JSON 格式）
AGENT_BINDINGS='[
  { "agentId": "chat", "match": { "accountId": "chat-bot" } },
  { "agentId": "dev",  "match": { "accountId": "dev-bot" } }
]'

# 兼容：单 Bot 模式（不配置 BOT_ACCOUNTS 时回退到现有逻辑）
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=secret_xxx
```

### 向后兼容

不配置 `BOT_ACCOUNTS` 时，系统自动回退到单 bot 模式（使用现有 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`），所有消息走 Dev Agent。零迁移成本。

---

## 八、分阶段实施计划

### Phase 1: 多账号基础设施 + Chat Agent

**目标：** ChatBot 能独立工作，只读讨论方案

**Phase 1.0 — 飞书能力验证（先行，不写代码）：**
1. 创建两个飞书 Bot 应用（ChatBot + DevBot）
2. 验证：两个 bot 能否加入同一个群
3. 验证：Bot B 能否 reply_in_thread 到 Bot A 创建的消息
4. 验证：两个 bot 的 WebSocket 长连接能否在同一个 Node 进程中共存
5. 如果任一验证失败 → 调整方案后再继续

**Phase 1.1 — 核心改动：**
1. `src/feishu/multi-account.ts` — 新增多 Bot 账号管理（AccountManager）
2. `src/feishu/request-context.ts` — 新增 RequestContext，携带 accountId 贯穿调用链
3. `src/feishu/client.ts` — 从单例改为 per-account 实例池（通过 RequestContext 获取），保持向后兼容
4. `src/feishu/event-handler.ts` — 调整事件处理顺序：shouldRespond → binding router → slash command → workspace router → execute
5. **dedup 改造** — dedup key 从 `messageId` 改为 `accountId:messageId`（Critical，不修复则多 bot 不工作）
6. `src/agent/types.ts` — AgentBinding, AgentConfig 类型定义
7. `src/agent/registry.ts` — Agent 注册表
8. `src/agent/router.ts` — Binding 路由引擎（纯配置匹配，与现有 workspace router 独立）
9. `src/agent/prompts/chat.ts` — Chat Agent system prompt
10. `src/session/manager.ts` — session key + queue key + session lock 加 agentId 前缀
11. **DB migration** — 启动时一次性迁移：存量 session/thread_session key 加 `agent:dev:` 前缀
12. **killSessionsForChat** — 更新前缀匹配逻辑适配新 key 格式
13. 群内 @mention 检测（含 commander 模式优先级规则：显式 @mention > commander）
14. Chat Agent 工具限制通过 `canUseTool` 回调实现（非 `allowedTools` 参数）

**验证标准：**
- 两个 bot 在群里独立工作，不互相抢消息
- @ChatBot 只能读代码、讨论方案，无法调用 Edit/Write/Bash
- @DevBot 行为与当前完全一致
- Commander 模式下 @DevBot 时 ChatBot 不响应
- `/stop` 命令正常工作
- 不配 BOT_ACCOUNTS 时完全向后兼容

### Phase 2: Agent 间调度 + 授权

**目标：** Chat Agent 能触发 Dev Agent 开发，non-owner 需审批

改动：
1. `src/agent/tool.ts` — invoke_agent MCP tool 定义（独立文件，不放 workspace/tool.ts）
2. `src/agent/dispatcher.ts` — 异步调度逻辑（独立 queue，不阻塞调用方）
3. `src/feishu/approval.ts` — approval key 从 `threadId` 改为 `agentId:threadId`；审批卡片展示 task/context
4. `src/agent/prompts/chat.ts` — 加入 invoke_agent 使用引导
5. 上下文传递：chat agent 生成结构化 context → 注入 dev agent user message（标记不可信）
6. invoke_agent 调用者身份通过 MCP server 闭包绑定，不信任 tool input
7. `/dev` 发给 ChatBot 时自动转为 invoke_agent 调度

**验证标准：**
- Chat Agent 讨论完方案后能调用 Dev Agent
- Dev Agent 执行时上下文包含方案摘要（标记为不可信）
- Non-owner 触发 Dev Agent 时 Owner 收到审批卡片（展示实际 task/context）
- Owner 审批后 Dev Agent 正常执行
- Chat Agent 不被 Dev Agent 长时间执行阻塞
- `/dev` 发给 ChatBot 正确路由到 DevBot 执行

### Phase 3: 多角色扩展

**目标：** 支持动态注册新角色

改动：
1. Agent 配置文件化（从代码配置迁移到 JSON/YAML 配置文件）
2. 角色专属 prompt 模板系统
3. 角色专属工具白名单配置化
4. 角色间调度权限矩阵（谁能调用谁）

**新角色接入流程（目标状态）：**
```
1. 创建飞书应用，拿到 appId / appSecret
2. 在 BOT_ACCOUNTS 中添加账号配置
3. 在 AGENT_BINDINGS 中添加路由规则
4. 创建 agent prompt 文件
5. 在 agent registry 中注册（配置，非代码）
6. 重启服务
```

---

## 九、关键风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 飞书限制多 bot 同群数量 | 架构不可行 | Phase 1 第一步验证：创建 2 个 bot 加入同一个群 |
| 跨 bot thread 回复不支持 | DevBot 无法在 ChatBot thread 中发结果 | Phase 1 同步验证；fallback：DevBot 创建独立 thread 并 @用户 |
| 上下文传递信息损失 | Dev Agent 执行偏离方案 | Chat Agent prompt 要求生成结构化 spec；context 标记为不可信，Dev Agent 自行验证 |
| Dedup 误丢消息 | 多 bot 共存时消息静默丢失 | dedup key 改为 `accountId:messageId`（见 6.1，Phase 1 核心改动） |
| Task Queue 死锁 | invoke_agent 永远挂起 | 强制异步调度 + agent 感知的 queue key（见 4.6） |
| Session 迁移 | 存量 session 失效 | 启动时一次性 DB migration，不做运行时 fallback（见 4.5） |
| `/dev` 发给 ChatBot | bot 身份与 pipeline 不匹配 | 视为隐式 invoke_agent，走 dispatcher 异步调度（见 4.3） |
| 多账号 WebSocket 稳定性 | 连接管理复杂度增加 | 每个账号独立重连逻辑，互不影响 |
| 成本膨胀 | 多 agent 多次 API 调用 | Chat Agent 用 Sonnet + 低 max_turns；每个 agent 独立预算上限 |
| invoke_agent prompt injection | 用户通过 Chat Agent 间接控制 Dev Agent | context 注入为 user message 标记不可信；审批卡片展示实际 task/context |

---

## 十、与现有演进计划的关系

| 现有计划 | 关系 |
|---------|------|
| Plan 1: 渠道插件化 | 并行推进。多 agent 架构在 `ChannelAdapter` 之上工作，渠道层不感知 agent 角色 |
| Plan 2: 结构化配置 | 互补。Agent 配置（bindings、角色定义）是结构化配置的一部分 |
| Plan 3: 飞书文档/Wiki/多维表格工具 | 互补。这些工具可按角色分配（PM Agent 才能写文档，Dev Agent 只写代码） |
| Pipeline (已实现) | 融合。Pipeline 是 Dev Agent 的一个执行模式，Chat Agent 可通过 invoke_agent 触发 pipeline。`/dev` 发给 ChatBot 时自动转为 invoke_agent |
| Workspace Router (已实现, `src/claude/router.ts`) | 保留。Workspace Router 是系统级组件，独立于 agent 权限模型运行（使用自己的 executor 配置含 Bash），在 binding router 之后、agent 执行之前运行。与新增 binding router (`src/agent/router.ts`) 无命名冲突——前者选目录，后者选角色 |

---

## 附录 A: Chat Agent System Prompt 草案

```
你是 ChatBot，一个专注于方案讨论和技术分析的 AI 助手。

## 你的角色
- 阅读和分析代码（只读，不修改任何文件）
- 与用户讨论技术方案、架构设计、需求细节
- 回答关于项目的问题
- 当方案明确后，调度 Dev Agent 进行代码开发

## 你不能做的事
- 修改、创建、删除任何文件
- 执行 bash 命令
- 直接写代码到仓库

## 何时调度 Dev Agent
当满足以下条件时，使用 invoke_agent 工具：
1. 用户明确表示"开始开发"/"写代码"/"实现这个方案"
2. 方案已经讨论清楚，有明确的实施步骤
3. 你已经整理好结构化的任务描述

调用时请提供：
- task: 清晰的任务描述
- context: 包含讨论达成的方案要点、技术选型、涉及的文件、约束条件
```

## 附录 B: invoke_agent MCP Tool Schema

```typescript
// src/agent/tool.ts（独立文件，不在 workspace/tool.ts 中）
{
  name: 'invoke_agent',
  description: '异步调度其他 Agent 执行任务。调用后立即返回，目标 Agent 的结果将通过其对应的 Bot 直接发送。',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['dev', 'pm'],
        description: '目标 Agent 角色'
      },
      task: {
        type: 'string',
        description: '要执行的任务描述'
      },
      context: {
        type: 'string',
        description: '方案上下文摘要，包含讨论要点、技术选型、约束条件等。注意：此内容将标记为不可信，目标 Agent 会自行验证。'
      },
    },
    required: ['target', 'task']
  }
}
// 注意：调用者 agentId 由 MCP server 闭包绑定，不在 inputSchema 中暴露
// 注意：没有 waitForResult 参数，强制异步执行
```

## 附录 C: 飞书 Bot-to-Bot 通信调研结论

| 问题 | 结论 |
|------|------|
| Bot 消息能否触发另一个 Bot 的事件回调？ | 有条件可以（目标 bot 需开启"获取群组中所有消息"权限），但不推荐依赖 |
| Bot 能否 @另一个 Bot？ | 技术上可以（富文本 at tag + open_id），但行为不保证 |
| Bot 之间能否私聊？ | 不能。飞书 DM 只支持 bot → user |
| 建议方案 | Agent 间调度走后端内部调用，不走飞书消息 |

## 附录 D: 审查记录

> 本文档经过 3-agent 并行审查（安全 / 逻辑与正确性 / 架构与质量），以下问题已在文档中修复：

| # | 类型 | 问题 | 修复位置 |
|---|------|------|---------|
| 1 | 🔴 安全 | invoke_agent context 注入导致权限升级 | 决策 3 安全约束 + 4.7 上下文传递 |
| 2 | 🔴 安全 | invoke_agent 缺少调用者身份验证 | 决策 3 安全约束（闭包绑定） |
| 3 | 🔴 逻辑 | Task Queue 死锁（ChatBot 等 DevBot 结果，DevBot 排在 ChatBot 后面） | 4.4 强制异步 + 4.6 并发设计 |
| 4 | 🔴 逻辑 | Session busy lock 冲突（invoke_agent 时两个 agent 争锁） | 4.6 agent 感知的 session lock |
| 5 | 🔴 逻辑 | 共享 dedup Map 导致跨 bot 消息丢失 | 6.1 dedup key 加 accountId |
| 6 | 🔴 架构 | 两层路由职责重叠 + Routing Agent 权限冲突 | 4.3 两层路由设计 + 第十节 Workspace Router |
| 7 | 🟡 安全 | 审批卡片展示原始消息而非实际 task/context | 第五节审批改造 |
| 8 | 🟡 逻辑 | Thread session key 迁移策略不具体 | 4.5 一次性 DB migration |
| 9 | 🟡 逻辑 | Commander + @mention 双重处理 | 6.2 shouldRespond 优先级规则 |
| 10 | 🟡 逻辑 | `/dev` 发给 ChatBot 时 bot 身份不匹配 | 4.3 隐式 invoke_agent |
| 11 | 🟡 逻辑 | killSessionsForChat 前缀匹配失效 | 4.5 关联改造 |
| 12 | 🟡 逻辑 | 跨 bot thread 回复未验证 | 4.2 Phase 1 验证项 |
| 13 | 🟡 架构 | feishuClient 迁移缺少具体方案 | 4.2 RequestContext |
| 14 | 🟡 架构 | invoke_agent tool 放错文件 | 4.1 独立 src/agent/tool.ts |
| 15 | 🟡 架构 | allowedTools 不是限制列表 | 4.3 AgentConfig.toolPolicy + canUseTool |
| 16 | 🟡 安全 | Binding 配置无校验 | 4.3 启动时配置校验 |

**未修复（标记为已知限制或 Phase 3 范围）：**
- 🔵 单 OWNER_USER_ID 不适合多团队场景 → Phase 3 per-agent ownership
- 🔵 无 per-agent 预算隔离和 invoke_agent 速率限制 → Phase 2 细化
- 🟡 多 bot 密钥放在同一 JSON 环境变量 → Plan 2 结构化配置解决（独立文件 + 权限控制）
