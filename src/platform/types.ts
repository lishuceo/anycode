/**
 * 平台消息接口 — 抽象消息发送操作
 *
 * 当前实现: Feishu (src/feishu/client.ts)
 * 未来: Slack, 企业微信, Discord 等
 *
 * 设计原则:
 * - 接口定义平台无关的消息操作（发送、回复、话题、更新）
 * - 内容格式暂时保持平台相关（卡片 JSON），后续可抽象为结构化内容
 * - 新代码优先使用 MessagePort，存量代码逐步迁移
 */

// ─── 消息内容 ──────────────────────────────────────────────

/** 消息内容（暂时允许平台特定格式，后续可抽象为结构化内容） */
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'card'; card: Record<string, unknown> };

// ─── 消息端口 ──────────────────────────────────────────────

/**
 * 平台消息端口 — 一次消息交互的上下文
 *
 * 由平台 Adapter 根据入站消息创建，绑定 chatId/messageId 等上下文。
 * 调用方无需关心具体平台的 API 细节。
 */
export interface MessagePort {
  /** 引用回复用户消息（quote reply） */
  replyToMessage(content: MessageContent): Promise<string | undefined>;

  /** 在聊天中发送新消息（不引用） */
  sendToChat(content: MessageContent): Promise<string | undefined>;

  /** 更新已发送的消息（如进度卡片原地更新） */
  updateMessage(messageId: string, content: MessageContent): Promise<boolean>;

  /** 创建话题/线程 */
  createThread(content: MessageContent): Promise<{
    messageId?: string;
    threadId?: string;
  }>;

  /** 在话题内回复 */
  replyInThread(threadRootMsgId: string, content: MessageContent): Promise<string | undefined>;
}

// ─── 入站消息 ──────────────────────────────────────────────

/** 平台无关的入站消息 */
export interface InboundMessage {
  /** 平台标识 */
  platform: 'feishu' | 'slack' | 'wechat';
  /** 消息 ID */
  messageId: string;
  /** 聊天/频道 ID */
  chatId: string;
  /** 发送者 ID */
  userId: string;
  /** 聊天类型 */
  chatType: 'group' | 'direct';
  /** 消息文本 */
  text: string;
  /** 话题 ID（如果在话题中） */
  threadId?: string;
  /** 回复目标消息 ID（话题内回复时为话题根消息 ID） */
  replyToMessageId?: string;
  /** 图片附件 */
  images?: Array<{ url?: string; base64?: string; mediaType: string }>;
  /** @mention 列表 */
  mentions?: Array<{ id: string; name?: string }>;
}
