// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  hasOtherHumanInMessages,
  threadHasOtherHumanParticipant,
  type ParticipantMessage,
} from '../thread-participants.js';

// ============================================================
// hasOtherHumanInMessages — 纯函数过滤逻辑
// ============================================================
describe('hasOtherHumanInMessages', () => {
  const SESSION_USER = 'ou_session_creator';
  const CURRENT_MSG = 'om_current';

  it('returns false for empty list', () => {
    expect(hasOtherHumanInMessages([], SESSION_USER, CURRENT_MSG)).toBe(false);
  });

  it('returns false when only session creator messages exist', () => {
    const msgs: ParticipantMessage[] = [
      { messageId: 'om_1', senderId: SESSION_USER, senderType: 'user' },
      { messageId: 'om_2', senderId: SESSION_USER, senderType: 'user' },
    ];
    expect(hasOtherHumanInMessages(msgs, SESSION_USER, CURRENT_MSG)).toBe(false);
  });

  it('returns false when only bot (app) messages besides session creator', () => {
    // bot 自己历史发的消息不算第三方
    const msgs: ParticipantMessage[] = [
      { messageId: 'om_1', senderId: SESSION_USER, senderType: 'user' },
      { messageId: 'om_2', senderId: 'ou_bot_a', senderType: 'app' },
      { messageId: 'om_3', senderId: 'ou_bot_b', senderType: 'app' },
    ];
    expect(hasOtherHumanInMessages(msgs, SESSION_USER, CURRENT_MSG)).toBe(false);
  });

  it('returns true when another human user has spoken in thread', () => {
    // 黎叔的场景：话题里出现过 ou_other 这个人类用户
    const msgs: ParticipantMessage[] = [
      { messageId: 'om_1', senderId: SESSION_USER, senderType: 'user' },
      { messageId: 'om_2', senderId: 'ou_bot', senderType: 'app' },
      { messageId: 'om_3', senderId: 'ou_other', senderType: 'user' },
      { messageId: 'om_4', senderId: SESSION_USER, senderType: 'user' },
    ];
    expect(hasOtherHumanInMessages(msgs, SESSION_USER, CURRENT_MSG)).toBe(true);
  });

  it('excludes the current message itself from the check', () => {
    // 当前消息混入历史时不应误判（即使它的 senderId 是 session creator 也别让它影响判断）
    const msgs: ParticipantMessage[] = [
      { messageId: CURRENT_MSG, senderId: 'ou_unrelated', senderType: 'user' },
      { messageId: 'om_2', senderId: SESSION_USER, senderType: 'user' },
    ];
    expect(hasOtherHumanInMessages(msgs, SESSION_USER, CURRENT_MSG)).toBe(false);
  });

  it('ignores messages with empty senderId', () => {
    const msgs: ParticipantMessage[] = [
      { messageId: 'om_1', senderId: '', senderType: 'user' },
      { messageId: 'om_2', senderId: SESSION_USER, senderType: 'user' },
    ];
    expect(hasOtherHumanInMessages(msgs, SESSION_USER, CURRENT_MSG)).toBe(false);
  });
});

// ============================================================
// threadHasOtherHumanParticipant — 集成 feishuClient 的包装
// ============================================================
describe('threadHasOtherHumanParticipant', () => {
  const SESSION_USER = 'ou_session_creator';
  const CURRENT_MSG = 'om_current';

  it('returns false when fetch returns only session creator', async () => {
    const client = {
      fetchRecentMessages: vi.fn().mockResolvedValue([
        { messageId: 'om_1', senderId: SESSION_USER, senderType: 'user' as const },
      ]),
    };
    await expect(
      threadHasOtherHumanParticipant(client, 'thread-1', 'chat-1', SESSION_USER, CURRENT_MSG),
    ).resolves.toBe(false);
    expect(client.fetchRecentMessages).toHaveBeenCalledWith('thread-1', 'thread', 10, 'chat-1');
  });

  it('returns true when another human present in history', async () => {
    const client = {
      fetchRecentMessages: vi.fn().mockResolvedValue([
        { messageId: 'om_1', senderId: 'ou_other', senderType: 'user' as const },
        { messageId: 'om_2', senderId: SESSION_USER, senderType: 'user' as const },
      ]),
    };
    await expect(
      threadHasOtherHumanParticipant(client, 'thread-1', 'chat-1', SESSION_USER, CURRENT_MSG),
    ).resolves.toBe(true);
  });

  it('respects custom limit', async () => {
    const client = {
      fetchRecentMessages: vi.fn().mockResolvedValue([]),
    };
    await threadHasOtherHumanParticipant(
      client, 'thread-1', 'chat-1', SESSION_USER, CURRENT_MSG, 25,
    );
    expect(client.fetchRecentMessages).toHaveBeenCalledWith('thread-1', 'thread', 25, 'chat-1');
  });

  it('returns true on fetch failure (conservative — require @mention)', async () => {
    const client = {
      fetchRecentMessages: vi.fn().mockRejectedValue(new Error('network broken')),
    };
    // 失败时保守默认有第三方，让用户必须 @ bot 才响应
    await expect(
      threadHasOtherHumanParticipant(client, 'thread-1', 'chat-1', SESSION_USER, CURRENT_MSG),
    ).resolves.toBe(true);
  });
});
