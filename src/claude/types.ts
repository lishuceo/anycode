// ============================================================
// Claude Code stream-json 协议类型定义
// 参考: claude --help 中 --output-format stream-json 描述
// ============================================================

/** Claude Code 单次任务执行结果 */
export interface ClaudeResult {
  /** 是否执行成功 */
  success: boolean;
  /** 输出文本 */
  output: string;
  /** 错误信息 */
  error?: string;
  /** Claude Code 会话 ID (用于 --resume 续接) */
  sessionId?: string;
  /** 执行耗时 (ms) */
  durationMs: number;
  /** 是否被超时终止 */
  timedOut?: boolean;
}

// ---------- stream-json 输出事件 ----------

/**
 * Claude Code stream-json 输出的事件类型
 * 每行一个 JSON 对象
 */
export type StreamEvent =
  | SystemEvent
  | AssistantEvent
  | ToolUseEvent
  | ToolResultEvent
  | ResultEvent;

export interface SystemEvent {
  type: 'system';
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface AssistantEvent {
  type: 'assistant';
  subtype?: 'text' | 'partial';
  content?: string | ContentBlock[];
  session_id?: string;
  [key: string]: unknown;
}

export interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ToolUseEvent {
  type: 'tool_use';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  [key: string]: unknown;
}

export interface ToolResultEvent {
  type: 'tool_result';
  tool_name?: string;
  content?: string;
  is_error?: boolean;
  session_id?: string;
  [key: string]: unknown;
}

export interface ResultEvent {
  type: 'result';
  result?: string | Record<string, unknown>;
  session_id?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  cost_usd?: number;
  [key: string]: unknown;
}

// ---------- stream-json 输入消息 ----------

/**
 * 双向流式模式 (--input-format stream-json) 中
 * 可以通过 stdin 发送的消息类型
 */
export interface StreamInputMessage {
  type: 'user_message';
  content: string;
}

// ---------- 回调 ----------

/** 执行进度回调 */
export type ProgressCallback = (event: StreamEvent) => void;
