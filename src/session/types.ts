/** 会话状态 */
export type SessionStatus = 'idle' | 'busy' | 'error';

/** 会话信息 */
export interface Session {
  /** 飞书会话 ID (chat_id) */
  chatId: string;
  /** 飞书用户 open_id */
  userId: string;
  /** 工作目录 */
  workingDir: string;
  /** Claude Code 会话 ID (用于 --resume 续接) */
  conversationId?: string;
  /** conversationId 对应的工作目录（resume 时需 cwd 匹配） */
  conversationCwd?: string;
  /** 飞书话题 ID (thread_id) - 每个新会话创建一个话题 */
  threadId?: string;
  /** 话题根消息 ID (创建话题时的第一条消息) */
  threadRootMessageId?: string;
  /** 状态 */
  status: SessionStatus;
  /** 创建时间 */
  createdAt: Date;
  /** 最后活跃时间 */
  lastActiveAt: Date;
}

/** Thread 级别的 Claude Code 会话（threadId → conversationId 映射） */
export interface ThreadSession {
  /** 飞书 thread ID */
  threadId: string;
  /** 飞书 chat ID */
  chatId: string;
  /** 飞书 user ID */
  userId: string;
  /** 该 thread 绑定的工作目录（由首条消息确定后永久绑定） */
  workingDir: string;
  /** Claude Code session_id（resume 用） */
  conversationId?: string;
  /** 创建 conversationId 时的 cwd（用于 cwd 匹配校验） */
  conversationCwd?: string;
  /** 创建时间 */
  createdAt: Date;
  /** 最后更新时间 */
  updatedAt: Date;
}

/** 队列中的任务 */
export interface QueueTask {
  id: string;
  chatId: string;
  userId: string;
  message: string;
  messageId: string;
  rootId?: string;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  createdAt: Date;
}
