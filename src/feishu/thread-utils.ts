import { logger } from '../utils/logger.js';
import { sessionManager } from '../session/manager.js';
import { feishuClient } from './client.js';
import { buildGreetingCard } from './message-builder.js';

/** ensureThread 的返回结果 */
export interface EnsureThreadResult {
  /** 话题锚点消息 ID（用于后续 reply_in_thread） */
  threadRootMsgId?: string;
  /** 问候卡片消息 ID（仅新建话题时有值，用于后续更新卡片） */
  greetingMsgId?: string;
}

/**
 * 确保会话有话题，如果没有则创建一个
 * 返回 threadRootMessageId (用于后续 reply_in_thread) 和 greetingMsgId (用于更新问候卡片)
 */
export async function ensureThread(
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
  /** 飞书事件中的 thread_id（可靠的话题标识，优先于 root_id） */
  threadId?: string,
  /** agent 角色标识（多 agent 模式，默认 'dev'） */
  agentId: string = 'dev',
): Promise<EnsureThreadResult> {
  sessionManager.getOrCreate(chatId, userId, agentId);

  // 1. 用户在话题内发消息（有 threadId）— 直接复用该话题，无需发送问候
  //    注意：rootId 在主面板引用回复时也会有值，不能用来判断是否在话题内
  if (threadId) {
    // threadId (omt_xxx) 做话题标识，rootId (om_xxx) 做回复目标
    // rootId 在飞书实际场景中 threadId 存在时一定存在，但防御性处理避免 undefined 入库
    const replyTarget = rootId ?? messageId;
    sessionManager.setThread(chatId, userId, threadId, replyTarget, agentId);
    return { threadRootMsgId: replyTarget };
  }

  // 2. 用户在主聊天区发消息（无 rootId）— 新会话意图
  //    如果想继续旧话题，用户应在话题内回复；在主区发消息 = 新对话
  //    发送卡片作为首条消息，后续可原地更新显示话题和工作目录信息
  const card = buildGreetingCard();
  const { messageId: botMsgId, threadId: newThreadId } = await feishuClient.createThreadWithCard(
    messageId,
    card,
  );

  if (newThreadId && botMsgId) {
    // 新话题创建成功，保存话题信息
    // 不清空全局 conversationId——各 thread 通过 thread_sessions 表独立管理自己的 conversationId
    sessionManager.setThread(chatId, userId, newThreadId, messageId, agentId);
    return { threadRootMsgId: messageId, greetingMsgId: botMsgId };
  }

  logger.warn({ chatId, userId }, 'Failed to create thread, falling back to main chat');
  return {};
}
