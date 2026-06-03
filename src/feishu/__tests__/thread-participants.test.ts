// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  hasOtherHumanInMessages,
  threadHasOtherHumanParticipant,
  evaluateThreadBypass,
  type ParticipantMessage,
  type ThreadBypassDeps,
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

  // ============================================================
  // 动态切换：单人话题 → 加入第三人 → 后续消息变成多人话题
  //
  // 重要边界：不能缓存"这个话题是单人/多人"的判定，必须每条消息都
  // 实时拉历史。否则第三人加入后，session 创建者再发的消息仍会被
  // 当作单人话题放行，导致插嘴。
  // ============================================================
  it('transitions from solo to multi-user as third party joins', async () => {
    // 模拟话题历史随时间累积：先只有 session creator，然后第三人加入
    const history: Array<{ messageId: string; senderId: string; senderType: 'user' | 'app' }> = [
      { messageId: 'om_1', senderId: SESSION_USER, senderType: 'user' },
    ];
    const client = {
      fetchRecentMessages: vi.fn().mockImplementation(async () => [...history]),
    };

    // T1: 单人话题，session creator 发消息 → 判定为单人，可 bypass
    await expect(
      threadHasOtherHumanParticipant(client, 'thread-1', 'chat-1', SESSION_USER, 'om_t1'),
    ).resolves.toBe(false);

    // T2: 第三人插话（这条消息本身不会触发 bot，但会进入飞书话题历史）
    history.push({ messageId: 'om_2', senderId: 'ou_third_party', senderType: 'user' });

    // T3: session creator 再发消息 → 实时拉历史能看到第三人 → 切换到保守模式
    await expect(
      threadHasOtherHumanParticipant(client, 'thread-1', 'chat-1', SESSION_USER, 'om_t3'),
    ).resolves.toBe(true);

    // 每次都现拉，没缓存
    expect(client.fetchRecentMessages).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// evaluateThreadBypass — 单 bot / 多 bot 模式共享的完整 bypass 判定
// ============================================================
describe('evaluateThreadBypass', () => {
  const SESSION_USER = 'ou_session_creator';
  const CURRENT_MSG = 'om_current';

  /** 构造一份可复用的 deps，按需覆盖单字段 */
  function makeDeps(overrides: Partial<ThreadBypassDeps> = {}): ThreadBypassDeps {
    return {
      client: { fetchRecentMessages: vi.fn().mockResolvedValue([]) },
      getThreadSession: vi.fn().mockReturnValue({ userId: SESSION_USER }),
      isOwner: vi.fn().mockReturnValue(false),
      ...overrides,
    };
  }

  const baseParams = {
    threadId: 'thread-1',
    chatId: 'chat-1',
    senderUserId: SESSION_USER,
    messageId: CURRENT_MSG,
  };

  it('returns no_session when thread has no session record', async () => {
    const deps = makeDeps({ getThreadSession: vi.fn().mockReturnValue(undefined) });
    const result = await evaluateThreadBypass(deps, baseParams);
    expect(result).toEqual({ allow: false, reason: 'no_session' });
  });

  it('returns not_creator when sender is neither owner nor session creator', async () => {
    const deps = makeDeps();
    const result = await evaluateThreadBypass(deps, {
      ...baseParams,
      senderUserId: 'ou_outsider',
    });
    expect(result).toEqual({
      allow: false,
      reason: 'not_creator',
      sessionUserId: SESSION_USER,
    });
    // 不应走到拉历史
    expect((deps.client.fetchRecentMessages as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('allows owner to bypass even if not session creator', async () => {
    // owner 是平台管理员，话题里发啥都按 session 创建者待遇处理
    const deps = makeDeps({ isOwner: vi.fn().mockReturnValue(true) });
    const result = await evaluateThreadBypass(deps, {
      ...baseParams,
      senderUserId: 'ou_admin',
    });
    expect(result).toEqual({
      allow: true,
      reason: 'solo',
      sessionUserId: SESSION_USER,
    });
  });

  it('returns multi_user when other human present in history', async () => {
    const deps = makeDeps({
      client: {
        fetchRecentMessages: vi.fn().mockResolvedValue([
          { messageId: 'om_old', senderId: 'ou_third_party', senderType: 'user' as const },
        ]),
      },
    });
    const result = await evaluateThreadBypass(deps, baseParams);
    expect(result).toEqual({
      allow: false,
      reason: 'multi_user',
      sessionUserId: SESSION_USER,
    });
  });

  it('returns solo when session creator alone in thread', async () => {
    const deps = makeDeps({
      client: {
        fetchRecentMessages: vi.fn().mockResolvedValue([
          { messageId: 'om_1', senderId: SESSION_USER, senderType: 'user' as const },
        ]),
      },
    });
    const result = await evaluateThreadBypass(deps, baseParams);
    expect(result).toEqual({
      allow: true,
      reason: 'solo',
      sessionUserId: SESSION_USER,
    });
  });

  it('treats fetch failure as multi_user (conservative)', async () => {
    const deps = makeDeps({
      client: {
        fetchRecentMessages: vi.fn().mockRejectedValue(new Error('boom')),
      },
    });
    const result = await evaluateThreadBypass(deps, baseParams);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('multi_user');
  });

  it('passes agentId through to getThreadSession (multi-bot mode)', async () => {
    const getThreadSession = vi.fn().mockReturnValue({ userId: SESSION_USER });
    const deps = makeDeps({ getThreadSession });
    await evaluateThreadBypass(deps, { ...baseParams, agentId: 'pm' });
    expect(getThreadSession).toHaveBeenCalledWith('thread-1', 'pm');
  });

  it('calls getThreadSession with undefined agentId in single-bot mode', async () => {
    const getThreadSession = vi.fn().mockReturnValue({ userId: SESSION_USER });
    const deps = makeDeps({ getThreadSession });
    await evaluateThreadBypass(deps, baseParams);
    expect(getThreadSession).toHaveBeenCalledWith('thread-1', undefined);
  });
});
