/** Claude Code 执行结果 */
export interface ClaudeResult {
  /** 是否执行成功 */
  success: boolean;
  /** 输出文本 */
  output: string;
  /** 错误信息 */
  error?: string;
  /** Claude Code 会话 ID (用于续接) */
  conversationId?: string;
  /** 执行耗时 (ms) */
  durationMs: number;
  /** 是否被超时终止 */
  timedOut?: boolean;
}

/** Claude Code stream-json 中的事件类型 */
export type StreamEventType =
  | 'system'      // 系统消息
  | 'assistant'   // Claude 的回复文本
  | 'tool_use'    // 工具调用开始
  | 'tool_result' // 工具调用结果
  | 'result';     // 最终结果

/** 流式事件 */
export interface StreamEvent {
  type: StreamEventType;
  subtype?: string;
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
}

/** 执行进度回调 */
export type ProgressCallback = (event: StreamEvent) => void;
