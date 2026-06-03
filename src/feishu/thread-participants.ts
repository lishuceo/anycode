// ============================================================
// Thread Participants — 判断飞书话题里是否有非会话创建者的人类参与
//
// 用于单 bot 模式下的"图片/文档防插嘴"过滤：session 创建者在话题里发图，
// 如果近期已有其他人类用户加入讨论，那张图很可能是发给其他人看的，
// bot 不应自作多情响应，要求显式 @ bot 才接。
// ============================================================

import { logger } from '../utils/logger.js';
import type { feishuClient as FeishuClient } from './client.js';

/** 历史消息中用于判断的最小字段集（与 feishuClient.fetchRecentMessages 返回结构兼容） */
export interface ParticipantMessage {
  messageId: string;
  senderId: string;
  senderType: 'user' | 'app';
}

/**
 * 纯函数：判断给定的历史消息列表里是否有"非 session 创建者的人类用户"。
 *
 * - 排除掉 currentMessageId 本身（避免当前消息混入历史导致误判）
 * - 只看 senderType === 'user' 的消息（bot 发的消息不算第三方）
 * - 空 senderId 也跳过
 *
 * 抽成纯函数主要为了好单测，不需要拉真实历史。
 */
export function hasOtherHumanInMessages(
  messages: ReadonlyArray<ParticipantMessage>,
  sessionUserId: string,
  currentMessageId: string,
): boolean {
  return messages.some(m =>
    m.messageId !== currentMessageId &&
    m.senderType === 'user' &&
    !!m.senderId &&
    m.senderId !== sessionUserId
  );
}

/**
 * 拉取话题最近消息并判断是否存在非 session 创建者的人类参与者。
 *
 * @param client    feishuClient 实例（依赖注入便于测试）
 * @param threadId  飞书话题 id
 * @param chatId    所属群 chat_id（fetchRecentMessages 在 thread 模式下用于 bot 被动收集）
 * @param sessionUserId 当前 session 创建者的 open_id
 * @param currentMessageId 当前正在处理的消息 id（从历史里排除掉）
 * @param limit     拉取条数，默认 10
 * @returns true = 话题里有第三方人类；false = 没有 / 拉取为空
 *
 * 注意：拉取失败时保守返回 true，等用户显式 @ bot 再响应，避免误插嘴。
 */
export async function threadHasOtherHumanParticipant(
  client: Pick<typeof FeishuClient, 'fetchRecentMessages'>,
  threadId: string,
  chatId: string,
  sessionUserId: string,
  currentMessageId: string,
  limit: number = 10,
): Promise<boolean> {
  try {
    const recent = await client.fetchRecentMessages(threadId, 'thread', limit, chatId);
    return hasOtherHumanInMessages(recent, sessionUserId, currentMessageId);
  } catch (err) {
    logger.warn(
      { err, threadId, chatId },
      'threadHasOtherHumanParticipant: fetch failed, defaulting to true (require @mention)',
    );
    return true;
  }
}
