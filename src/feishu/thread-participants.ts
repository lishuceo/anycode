// ============================================================
// Thread Participants — 飞书话题"是否要响应"的统一判定
//
// 两层 API:
//  - threadHasOtherHumanParticipant(): 拉历史 + 判定是否多人话题
//  - evaluateThreadBypass(): 完整的 bypass 判定（session 创建者 + 多人话题保守）
//
// 单 bot 和多 bot 模式的外层"@ 路由"分支不同，但内层 bypass 判定一致，
// 都通过 evaluateThreadBypass 共享，避免一边漏改导致策略不一致。
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

// ============================================================
// 完整 bypass 判定
// ============================================================

/** thread session 接口的最小子集（依赖注入便于测试） */
export interface ThreadSessionLike {
  userId: string;
}

/** evaluateThreadBypass 依赖的外部能力，全部通过参数注入 */
export interface ThreadBypassDeps {
  client: Pick<typeof FeishuClient, 'fetchRecentMessages'>;
  getThreadSession: (threadId: string, agentId?: string) => ThreadSessionLike | undefined;
  isOwner: (userId: string) => boolean;
}

export type ThreadBypassReason =
  | 'no_session'    // 话题没有 session 记录（陌生话题 / 已清理）
  | 'not_creator'   // 发送者不是 session 创建者也不是 owner
  | 'multi_user'    // 话题里已有非 session 创建者的人类参与过 → 保守要求 @
  | 'solo';         // 单人话题 + session 创建者 → 放行

export interface ThreadBypassResult {
  allow: boolean;
  reason: ThreadBypassReason;
  /** session 创建者的 user id；no_session 时为 undefined */
  sessionUserId?: string;
}

/**
 * 判断当前话题消息是否应该 bypass @mention 要求。
 *
 * 适用于"无 @bot 的话题内消息要不要响应"——单 bot/多 bot 模式共享这套判定。
 * 注意：本函数不关心 @mention 状态，调用方自己决定什么时候才进入 bypass 流程。
 *
 * 决策顺序：
 *   1. 拿不到 thread session → not_session
 *   2. 发送者不是 session 创建者也不是 owner → not_creator
 *   3. 拉话题历史看有没有第三人 → multi_user / solo
 */
export async function evaluateThreadBypass(
  deps: ThreadBypassDeps,
  params: {
    threadId: string;
    chatId: string;
    /** 多 bot 模式传 agentId 隔离 session；单 bot 模式可不传，走默认 */
    agentId?: string;
    senderUserId: string;
    messageId: string;
  },
): Promise<ThreadBypassResult> {
  const { threadId, chatId, agentId, senderUserId, messageId } = params;

  const ts = deps.getThreadSession(threadId, agentId);
  if (!ts) return { allow: false, reason: 'no_session' };

  if (!deps.isOwner(senderUserId) && ts.userId !== senderUserId) {
    return { allow: false, reason: 'not_creator', sessionUserId: ts.userId };
  }

  const otherHuman = await threadHasOtherHumanParticipant(
    deps.client, threadId, chatId, ts.userId, messageId,
  );
  if (otherHuman) {
    return { allow: false, reason: 'multi_user', sessionUserId: ts.userId };
  }

  return { allow: true, reason: 'solo', sessionUserId: ts.userId };
}
