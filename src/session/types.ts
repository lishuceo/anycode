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
  /** 创建 conversationId 时的 system prompt hash（用于自动失效检测） */
  systemPromptHash?: string;
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

/** 路由状态（need_clarification 时存储上下文） */
export interface RoutingState {
  status: 'pending_clarification';
  /** 用户原始请求 */
  originalPrompt: string;
  /** 路由 agent 的提问 */
  question: string;
  /** 已追问次数（防止无限循环） */
  retryCount: number;
  /** 是否为 /dev pipeline 模式（clarification 恢复后需要走 pipeline 而非普通执行） */
  pipelineMode?: boolean;
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
  /** 创建 conversationId 时的 system prompt hash（用于自动失效检测） */
  systemPromptHash?: string;
  /** 路由是否已完成（首条消息路由后设为 true） */
  routingCompleted?: boolean;
  /** 路由状态（need_clarification 时非空） */
  routingState?: RoutingState;
  /** Pipeline 上下文（pipeline 完成后保存，供后续普通消息注入历史） */
  pipelineContext?: PipelineContext;
  /** 该 thread 是否已被 owner 审批通过（非 owner 用户需要审批） */
  approved?: boolean;
  /** 该 thread 是否为原地编辑模式（/edit 命令触发，跳过源仓库保护） */
  inplaceEdit?: boolean;
  /** 创建时间 */
  createdAt: Date;
  /** 最后更新时间 */
  updatedAt: Date;
}

/** Pipeline 上下文（存储在 thread_sessions 中，供后续消息使用） */
export interface PipelineContext {
  /** 用户原始开发需求 */
  prompt: string;
  /** Pipeline 执行摘要 */
  summary: string;
  /** Pipeline 工作目录 */
  workingDir: string;
}

/** 队列中的任务 */
export interface QueueTask {
  id: string;
  chatId: string;
  userId: string;
  message: string;
  messageId: string;
  rootId?: string;
  /** 飞书话题 ID (message.thread_id)，用于话题标识 */
  threadId?: string;
  /** 图片附件列表 (用户发送图片消息时) */
  images?: import('../claude/types.js').ImageAttachment[];
  /** 文档附件列表 (用户发送 PDF 等文件时) */
  documents?: import('../claude/types.js').DocumentAttachment[];
  /** 原始消息类型（text/image/file 等），用于 resume 时区分"新文件上传"与"引用父消息文件" */
  messageType?: string;
  /** 消息创建时间（毫秒级时间戳字符串，来自飞书 message.create_time） */
  createTime?: string;
  /** 强制使用话题模式（/t 命令触发） */
  forceThread?: boolean;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  createdAt: Date;
}
