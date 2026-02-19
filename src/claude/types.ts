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
  /** 是否需要重启 (workspace 变更后) */
  needsRestart?: boolean;
  /** 重启目标工作目录 */
  newWorkingDir?: string;
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
