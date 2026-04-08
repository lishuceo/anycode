/**
 * 多 Agent 角色架构 — 类型定义
 *
 * Binding Router（选 agent 角色）与 Workspace Router（选工作目录）独立：
 * ① shouldRespond → ② Binding Router → ③ Slash command → ④ Workspace Router → ⑤ Agent 执行
 */

// ─── Agent 标识 ──────────────────────────────────────────

/** 内置 agent 角色 */
export type BuiltinAgentId = 'pm' | 'dev';

/** agent 标识（内置 + 自定义） */
export type AgentId = BuiltinAgentId | (string & {});

// ─── Agent 配置 ──────────────────────────────────────────

/**
 * 工具策略：
 * - 'all': 允许所有工具（写权限 agent）
 * - 'readonly': 禁止 Edit/Write/Bash/NotebookEdit/Skill 和 MCP 写工具
 *
 * 通过 canUseTool 回调实现（非 SDK 的 allowedTools 参数，后者是启用列表不是限制列表）
 */
export type ToolPolicy = 'all' | 'readonly';

/**
 * 默认回复模式：
 * - 'direct': 直接回复用户消息（引用回复），不创建话题。Agent 可通过 MCP 工具升级为话题模式。
 * - 'thread': 创建话题，在话题内发送进度卡片和结果卡片（当前 Dev Agent 行为）。
 */
export type ReplyMode = 'direct' | 'thread';

/** Agent 角色配置 */
export interface AgentConfig {
  /** 角色标识 */
  id: AgentId;
  /** 显示名称（用于日志和审批卡片） */
  displayName: string;
  /** 默认模型 */
  model: string;
  /** 工具策略 */
  toolPolicy: ToolPolicy;
  /** 是否只读（等价于 toolPolicy === 'readonly'，保持向后兼容） */
  readOnly: boolean;
  /** 加载哪些 settings 源 */
  settingSources: ('user' | 'project')[];
  /** 单次 query 最大花费 (USD) */
  maxBudgetUsd: number;
  /** 单次 query 最大轮次 */
  maxTurns: number;
  /** 是否需要写权限审批（non-owner 场景） */
  requiresApproval: boolean;
  /** 默认回复模式 */
  replyMode: ReplyMode;
  /** 人格提示词文件路径（每次 query 重新读取，支持热更新）。有 persona → replace 模式；无 → append 模式 */
  persona?: string;
  /** 知识文件列表（相对于 knowledgeDir 的文件名，每次 query 重新读取） */
  knowledge?: string[];
  /** 工具允许列表（在 toolPolicy 基础上额外允许，支持 glob 如 'mcp__*'） */
  toolAllow?: string[];
  /** 工具禁止列表（优先级高于 allow，支持 glob） */
  toolDeny?: string[];
  /** Bash 命令白名单正则（readOnly + toolAllow 含 Bash 时生效，仅匹配的命令被放行） */
  bashAllowPatterns?: string[];
  /** 即使 readOnly 也允许 Edit/Write 的路径 glob 列表（相对于 cwd，如 "config/personas/*"） */
  editablePathPatterns?: string[];
}

// ─── Binding 路由 ────────────────────────────────────────

/** 匹配条件 */
export interface BindingMatch {
  /** bot 账号标识，'*' = 任意 */
  accountId?: string;
  /** 特定群/私聊 */
  peer?: {
    kind: 'group' | 'direct';
    id: string;
  };
  /** 特定用户 */
  userId?: string;
}

/** Agent Binding — 消息 → agent 角色的路由规则 */
export interface AgentBinding {
  agentId: AgentId;
  match: BindingMatch;
}

// ─── Bot 账号 ────────────────────────────────────────────

/** 飞书 Bot 账号配置（从环境变量解析） */
export interface BotAccountConfig {
  /** 账号标识（用于 binding 匹配） */
  accountId: string;
  /** 飞书应用 ID */
  appId: string;
  /** 飞书应用 Secret */
  appSecret: string;
  /** Bot 显示名称 */
  botName: string;
}

// ─── 群配置 ──────────────────────────────────────────────

/** 群内多 bot 共存配置 */
export interface GroupConfig {
  /** Commander bot accountId — 不需要 @也响应，但显式 @其他 bot 时让位 */
  commander?: string;
}

// ─── Inbound 消息上下文 ─────────────────────────────────

/** 进入路由层的消息上下文 */
export interface InboundContext {
  accountId: string;
  chatId: string;
  userId: string;
  chatType: 'group' | 'p2p';
}
