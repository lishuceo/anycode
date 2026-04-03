// ============================================================
// 从 @anthropic-ai/claude-agent-sdk 重导出需要的类型
// 以及本项目自定义的类型
// ============================================================

export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  Options as AgentSDKOptions,
  Query,
} from '@anthropic-ai/claude-agent-sdk';

/** 工具调用轨迹（用于 restart 时传递上下文） */
export interface ToolCallTrace {
  /** tool_use_id，用于关联 tool_result */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具输入参数 */
  input: Record<string, unknown>;
  /** 工具返回结果（从 user message 的 tool_result block 回填） */
  result?: string;
}

/** 对话轨迹中的一个 assistant turn */
export interface ConversationTurn {
  /** Agent 的推理文本 */
  text: string;
  /** Agent 调用的工具 */
  toolCalls: ToolCallTrace[];
}

/** 本项目封装的 Claude Code 执行结果 */
export interface ClaudeResult {
  /** 是否执行成功 */
  success: boolean;
  /** 输出文本 (Claude 的最终回复) */
  output: string;
  /** 错误信息 */
  error?: string;
  /** Claude Code 会话 ID (用于 resume 续接) */
  sessionId?: string;
  /** 执行耗时 (ms) */
  durationMs: number;
  /** API 耗时 (ms) */
  durationApiMs?: number;
  /** 总花费 (USD) */
  costUsd?: number;
  /** 总轮数 */
  numTurns?: number;
  /** System prompt 结构性哈希（不含 historySummaries），用于诊断日志追踪 prompt 变化 */
  systemPromptHash?: string;
  /** 是否需要重启 (workspace 变更后) */
  needsRestart?: boolean;
  /** 重启目标工作目录 */
  newWorkingDir?: string;
  /** 对话轨迹（restart 时传递给第二次 query 的上下文） */
  conversationTrace?: ConversationTurn[];
}

/** executor.execute() 的可选参数 */
export interface ExecuteOptions {
  /** 覆盖默认 maxTurns (默认 50) */
  maxTurns?: number;
  /** 覆盖默认 maxBudgetUsd (默认 5) */
  maxBudgetUsd?: number;
  /** 不注入 setup_workspace MCP tool (restart 时使用) */
  disableWorkspaceTool?: boolean;
  /** 覆盖模型 (路由 agent 使用 Sonnet) */
  model?: string;
  /** 覆盖 settingSources (路由 agent 使用 [] 避免加载项目 CLAUDE.md) */
  settingSources?: Array<'user' | 'project' | 'local'>;
  /** 只读模式：禁止 Edit/Write/Bash 等修改工具 */
  readOnly?: boolean;
}

/** 工具调用信息 */
export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
}

/** 单轮 assistant turn 信息 */
export interface TurnInfo {
  turnIndex: number;
  textContent: string;
  toolCalls: ToolCallInfo[];
}

/** 执行进度回调 — 接收 SDK 的 SDKMessage */
export type ProgressCallback = (message: import('@anthropic-ai/claude-agent-sdk').SDKMessage) => void;

/** 图片附件 (从飞书消息下载) */
export interface ImageAttachment {
  /** base64 编码的图片数据 */
  data: string;
  /** MIME 类型 */
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

/** 文档附件 (从飞书消息下载的 PDF 等) */
export interface DocumentAttachment {
  /** base64 编码的文档数据 */
  data: string;
  /** MIME 类型 */
  mediaType: 'application/pdf';
  /** 原始文件名 */
  fileName: string;
}

/** 图片消息的默认 prompt（用户发送纯图片时） */
export const DEFAULT_IMAGE_PROMPT = '请分析这张图片';

/** 文件消息的默认 prompt（用户发送纯文件时） */
export const DEFAULT_DOCUMENT_PROMPT = '请分析这个文档';

/**
 * 多模态 content block 类型（匹配 Anthropic API MessageParam.content 结构）
 * @anthropic-ai/sdk 的 MessageParam 未被 agent SDK 导出，故定义兼容类型
 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageAttachment['mediaType'];
    data: string;
  };
}

export interface DocumentContentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: DocumentAttachment['mediaType'];
    data: string;
  };
}

export type MultimodalContentBlock = TextContentBlock | ImageContentBlock | DocumentContentBlock;

/** Claude 活动状态（用于管道进度卡片展示） */
export interface ActivityStatus {
  /** 当前活动类型 */
  state: 'thinking' | 'tool_call';
  /** 累计工具调用次数 */
  toolCallCount: number;
}
