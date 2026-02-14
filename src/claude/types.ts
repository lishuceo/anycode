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
}

/** 执行进度回调 — 接收 SDK 的 SDKMessage */
export type ProgressCallback = (message: import('@anthropic-ai/claude-agent-sdk').SDKMessage) => void;
