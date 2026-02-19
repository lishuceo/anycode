import { logger } from '../utils/logger.js';
import { sessionManager } from '../session/manager.js';
import { feishuClient } from './client.js';

/**
 * 确保会话有话题，如果没有则创建一个
 * 返回 threadRootMessageId (用于后续 reply_in_thread)，失败返回 undefined
 */
export async function ensureThread(
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
): Promise<string | undefined> {
  sessionManager.getOrCreate(chatId, userId);

  // 1. 用户在已有话题内发消息 — 直接复用该话题，无需发送问候
  if (rootId) {
    // 更新 session 的话题信息，确保后续回复也发到这个话题
    sessionManager.setThread(chatId, userId, rootId, rootId);
    return rootId;
  }

  // 2. 用户在主聊天区发消息（无 rootId）— 新会话意图
  //    如果想继续旧话题，用户应在话题内回复；在主区发消息 = 新对话
  const greeting = '🤖 新会话已创建';
  const { messageId: botMsgId, threadId } = await feishuClient.replyInThread(
    messageId,
    greeting,
  );

  if (threadId && botMsgId) {
    // 新话题创建成功，保存话题信息
    // 不清空全局 conversationId——各 thread 通过 thread_sessions 表独立管理自己的 conversationId
    sessionManager.setThread(chatId, userId, threadId, messageId);
    return messageId;
  }

  logger.warn({ chatId, userId }, 'Failed to create thread, falling back to main chat');
  return undefined;
}
