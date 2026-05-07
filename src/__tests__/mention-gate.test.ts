import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    constructor() {}
    request = vi.fn().mockResolvedValue({ code: 0, bot: { open_id: 'ou_self_bot', app_name: 'TestBot' } });
    im = {
      message: { create: vi.fn(), reply: vi.fn(), patch: vi.fn() },
      chatMembers: {},
    };
    contact = { user: { get: vi.fn() } };
  }
  return {
    Client: MockClient,
    WSClient: class { start = vi.fn() },
    EventDispatcher: class { register = vi.fn() },
    CardActionHandler: class {},
  };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockIsMultiBotMode = vi.fn(() => false);
vi.mock('../config.js', () => ({
  config: {
    feishu: { encryptKey: '', verifyToken: '', tools: { doc: false, wiki: false, drive: false, bitable: false, chat: false } },
    claude: { defaultWorkDir: '/tmp' },
    agent: { bindings: [], botAccounts: [], groupConfigs: {} as Record<string, { commander?: string }> },
    chat: { historyMaxCount: 10, historyMaxChars: 4000 },
    db: { sessionDbPath: ':memory:' },
    quickAck: { enabled: false },
    security: {},
  },
  isMultiBotMode: () => mockIsMultiBotMode(),
}));

const mockGetBotOpenId = vi.fn((_id: string) => 'ou_dev_bot');
const mockGetAllBotOpenIds = vi.fn(() => new Set<string>(['ou_dev_bot', 'ou_pm_bot']));
vi.mock('../feishu/multi-account.js', () => ({
  accountManager: {
    getAllBotOpenIds: () => mockGetAllBotOpenIds(),
    getBotOpenId: (id: string) => mockGetBotOpenId(id),
    getClient: vi.fn(),
    getDefaultClient: vi.fn(),
    allAccounts: vi.fn(() => []),
    initializeSingleBot: vi.fn(),
  },
}));

vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    botOpenId: 'ou_self_bot',
    replyText: vi.fn(), replyTextInThread: vi.fn(), sendCard: vi.fn(),
    replyCardInThread: vi.fn(), updateCard: vi.fn(), downloadMessageImage: vi.fn(),
    fetchRecentMessages: vi.fn().mockResolvedValue([]), getUserName: vi.fn(),
    getChatMembers: vi.fn().mockResolvedValue([]), fetchBotInfo: vi.fn(),
  },
  runWithAccountId: vi.fn((_: string, fn: () => any) => fn()),
}));

const mockGetThreadSession = vi.fn((_threadId: string, _agentId?: string) => undefined as any);
vi.mock('../session/manager.js', () => ({
  sessionManager: {
    get: vi.fn(), getOrCreate: vi.fn(() => ({ workingDir: '/tmp', status: 'idle' })),
    setWorkingDir: vi.fn(), setStatus: vi.fn(), setConversationId: vi.fn(),
    getThreadSession: (...args: any[]) => mockGetThreadSession(args[0], args[1]),
    upsertThreadSession: vi.fn(), setThreadConversationId: vi.fn(),
    setThreadWorkingDir: vi.fn(), resetThreadConversation: vi.fn(),
    reset: vi.fn(), cleanup: vi.fn(), close: vi.fn(),
  },
}));

vi.mock('../session/queue.js', () => ({ taskQueue: { enqueue: vi.fn(), dequeue: vi.fn(), complete: vi.fn(), cancelAllForChat: vi.fn(), pendingCountForChat: vi.fn(() => 0) } }));
vi.mock('../claude/executor.js', () => ({ claudeExecutor: { execute: vi.fn(), killSessionsForChat: vi.fn(), killAll: vi.fn(), cleanup: vi.fn() } }));
vi.mock('../feishu/approval.js', () => ({ checkAndRequestApproval: vi.fn().mockResolvedValue(true), handleApprovalTextCommand: vi.fn(() => false), handleApprovalCardAction: vi.fn(), setOnApproved: vi.fn(), cleanupExpiredApprovals: vi.fn() }));
vi.mock('../feishu/thread-context.js', () => ({ resolveThreadContext: vi.fn() }));
vi.mock('../pipeline/store.js', () => ({ pipelineStore: { get: vi.fn(), findPendingByChat: vi.fn(), tryStart: vi.fn(), markRunningAsInterrupted: vi.fn(), cleanExpired: vi.fn(), close: vi.fn() } }));
vi.mock('../pipeline/runner.js', () => ({ createPendingPipeline: vi.fn(), startPipeline: vi.fn(), abortPipeline: vi.fn(), cancelPipeline: vi.fn(), retryPipeline: vi.fn(), recoverInterruptedPipelines: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../agent/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/router.js')>();
  return {
    resolveAgent: vi.fn(() => 'dev'),
    getRespondReason: actual.getRespondReason,
    shouldRespond: vi.fn(() => true),
  };
});

const mockAgentRegistryGet = vi.fn((_id: string) => undefined as any);
vi.mock('../agent/registry.js', () => ({
  agentRegistry: {
    get: (id: string) => mockAgentRegistryGet(id),
    getOrThrow: vi.fn(() => ({ replyMode: 'thread' })),
    allIds: vi.fn(() => ['dev', 'pm']),
  },
}));
vi.mock('../agent/config-loader.js', () => ({ readPersonaFile: vi.fn(), loadKnowledgeContent: vi.fn(), loadAgentConfig: vi.fn(() => ({})), startConfigWatcher: vi.fn(), stopConfigWatcher: vi.fn(), reloadAgentConfig: vi.fn() }));
vi.mock('../agent/tools/discussion.js', () => ({ createDiscussionMcpServer: vi.fn() }));
vi.mock('../workspace/manager.js', () => ({ setupWorkspace: vi.fn() }));

const mockCheckThreadRelevance = vi.fn(async (_msg?: unknown, _bot?: unknown) => false);
vi.mock('../utils/thread-relevance.js', () => ({
  checkThreadRelevance: (msg: unknown, bot: unknown) => mockCheckThreadRelevance(msg, bot),
}));

const mockIsOwner = vi.fn((_userId: string) => false);
vi.mock('../utils/security.js', () => ({
  isUserAllowed: vi.fn(() => true),
  containsDangerousCommand: vi.fn(() => false),
  isOwner: (userId: string) => mockIsOwner(userId),
  autoDetectOwner: vi.fn(() => false),
}));

// ── Tests ──

describe('resolveMentionGate', () => {
  let resolveMentionGate: (input: any) => Promise<string | undefined>;

  const baseInput = {
    chatType: 'group',
    mentionedBot: false,
    mentions: [] as Array<{ id: { open_id?: string } }>,
    threadId: undefined as string | undefined,
    messageId: 'msg_001',
    text: '拉一下 四季物语 这个游戏的源码',
    userId: 'ou_user_1',
    chatId: 'oc_chat_1',
    agentId: 'dev',
    accountId: 'dev',
    images: undefined as any,
    documents: undefined as any,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsMultiBotMode.mockReturnValue(false);
    mockGetBotOpenId.mockReturnValue('ou_dev_bot');
    mockGetAllBotOpenIds.mockReturnValue(new Set(['ou_dev_bot', 'ou_pm_bot']));
    mockGetThreadSession.mockReturnValue(undefined);
    mockCheckThreadRelevance.mockResolvedValue(false);
    mockIsOwner.mockReturnValue(false);
    mockAgentRegistryGet.mockReturnValue(undefined);

    const mod = await import('../feishu/event-handler.js');
    resolveMentionGate = mod._testing.resolveMentionGate;
  });

  // ── 私聊 ──

  it('allows all p2p messages', async () => {
    expect(await resolveMentionGate({ ...baseInput, chatType: 'p2p' })).toBe('p2p');
  });

  it('allows p2p even without @mention', async () => {
    expect(await resolveMentionGate({ ...baseInput, chatType: 'p2p', mentionedBot: false })).toBe('p2p');
  });

  // ── 单 bot 模式 ──

  describe('single-bot mode', () => {
    beforeEach(() => {
      mockIsMultiBotMode.mockReturnValue(false);
    });

    it('allows group message when bot is @mentioned', async () => {
      expect(await resolveMentionGate({ ...baseInput, mentionedBot: true })).toBe('mentioned');
    });

    it('blocks group message without @mention and no thread session', async () => {
      expect(await resolveMentionGate({ ...baseInput })).toBeUndefined();
    });

    it('blocks group message without @mention even with threadId but no session', async () => {
      expect(await resolveMentionGate({ ...baseInput, threadId: 'omt_123' })).toBeUndefined();
    });

    it('blocks when thread session exists but user is not owner/creator', async () => {
      mockGetThreadSession.mockReturnValue({ userId: 'ou_other_user', createdAt: new Date().toISOString() });
      expect(await resolveMentionGate({ ...baseInput, threadId: 'omt_123' })).toBeUndefined();
    });

    it('allows media from thread session creator', async () => {
      mockGetThreadSession.mockReturnValue({ userId: 'ou_user_1', createdAt: new Date().toISOString() });
      expect(await resolveMentionGate({
        ...baseInput, threadId: 'omt_123', images: [{ key: 'img_key' }],
      })).toBe('thread_session_media');
    });

    it('allows message from thread session creator when only two participants', async () => {
      mockGetThreadSession.mockReturnValue({ userId: 'ou_user_1', createdAt: new Date().toISOString() });
      // fetchRecentMessages returns [] → humanSenders.size=0 → dual-person bypass
      expect(await resolveMentionGate({ ...baseInput, threadId: 'omt_123' })).toBe('thread_session_owner');
    });

    it('uses Qwen when third person present in thread', async () => {
      mockGetThreadSession.mockReturnValue({ userId: 'ou_user_1', createdAt: new Date().toISOString() });
      const { feishuClient: fc } = await import('../feishu/client.js');
      vi.mocked(fc.fetchRecentMessages).mockResolvedValue([
        { messageId: 'm1', senderId: 'ou_user_1', senderType: 'user', content: 'hello', msgType: 'text' },
        { messageId: 'm2', senderId: 'ou_user_2', senderType: 'user', content: 'hi', msgType: 'text' },
      ] as any);
      mockCheckThreadRelevance.mockResolvedValue(false);
      expect(await resolveMentionGate({ ...baseInput, threadId: 'omt_123' })).toBeUndefined();
      vi.mocked(fc.fetchRecentMessages).mockResolvedValue([]);
    });

    it('allows owner in thread even if not session creator', async () => {
      mockGetThreadSession.mockReturnValue({ userId: 'ou_other_user', createdAt: new Date().toISOString() });
      mockIsOwner.mockReturnValue(true);
      mockCheckThreadRelevance.mockResolvedValue(true);
      expect(await resolveMentionGate({ ...baseInput, threadId: 'omt_123' })).toBe('thread_session_owner');
    });

    it('allows non-group chat types without @mention', async () => {
      expect(await resolveMentionGate({ ...baseInput, chatType: 'supergroup' })).toBe('non_group');
    });
  });

  // ── 多 bot 模式 ──

  describe('multi-bot mode', () => {
    beforeEach(() => {
      mockIsMultiBotMode.mockReturnValue(true);
    });

    it('blocks when no bot @mentioned and no commander (the bug scenario)', async () => {
      const humanMention = { id: { open_id: 'ou_human_user' } };
      expect(await resolveMentionGate({
        ...baseInput,
        mentions: [humanMention],
        threadId: 'omt_topic_123',
      })).toBeUndefined();
    });

    it('blocks when no mentions at all in group', async () => {
      expect(await resolveMentionGate({ ...baseInput })).toBeUndefined();
    });

    it('allows when this bot is @mentioned', async () => {
      const botMention = { id: { open_id: 'ou_dev_bot' } };
      expect(await resolveMentionGate({
        ...baseInput, mentions: [botMention],
      })).toBe('mentioned');
    });

    it('blocks when other bot is @mentioned but not this one', async () => {
      const otherBotMention = { id: { open_id: 'ou_pm_bot' } };
      expect(await resolveMentionGate({
        ...baseInput, mentions: [otherBotMention],
      })).toBeUndefined();
    });

    it('allows commander when no bot @mentioned', async () => {
      const { config } = await import('../config.js');
      (config.agent.groupConfigs as any)['oc_chat_1'] = { commander: 'dev' };
      mockGetBotOpenId.mockImplementation((id: string) => id === 'dev' ? 'ou_dev_bot' : '');

      expect(await resolveMentionGate({ ...baseInput })).toBe('commander');

      delete (config.agent.groupConfigs as any)['oc_chat_1'];
    });

    it('does NOT allow thread_bypass without existing thread session', async () => {
      mockGetThreadSession.mockReturnValue(undefined);
      expect(await resolveMentionGate({
        ...baseInput, threadId: 'omt_new_topic',
      })).toBeUndefined();
    });

    it('allows thread_bypass_exclusive when only creator and bot', async () => {
      mockGetThreadSession.mockImplementation((_: string, agentId?: string) => {
        if (agentId === 'dev') return { userId: 'ou_user_1', createdAt: '2026-01-01T00:00:00Z' };
        return undefined;
      });
      // fetchRecentMessages returns [] → only creator + bot → exclusive bypass
      expect(await resolveMentionGate({
        ...baseInput, threadId: 'omt_existing_topic',
      })).toBe('thread_bypass_exclusive');
    });

    it('allows thread_bypass when third person present and Qwen says yes', async () => {
      mockGetThreadSession.mockImplementation((_: string, agentId?: string) => {
        if (agentId === 'dev') return { userId: 'ou_user_1', createdAt: '2026-01-01T00:00:00Z' };
        return undefined;
      });
      const { feishuClient: fc } = await import('../feishu/client.js');
      vi.mocked(fc.fetchRecentMessages).mockResolvedValue([
        { messageId: 'm1', senderId: 'ou_user_1', senderType: 'user', content: 'hi', msgType: 'text' },
        { messageId: 'm2', senderId: 'ou_user_other', senderType: 'user', content: 'yo', msgType: 'text' },
      ] as any);
      mockCheckThreadRelevance.mockResolvedValue(true);

      expect(await resolveMentionGate({
        ...baseInput, threadId: 'omt_existing_topic',
      })).toBe('thread_bypass');
      vi.mocked(fc.fetchRecentMessages).mockResolvedValue([]);
    });

    it('blocks thread_bypass when third person present and Qwen says no', async () => {
      mockGetThreadSession.mockImplementation((_: string, agentId?: string) => {
        if (agentId === 'dev') return { userId: 'ou_user_1', createdAt: '2026-01-01T00:00:00Z' };
        return undefined;
      });
      const { feishuClient: fc } = await import('../feishu/client.js');
      vi.mocked(fc.fetchRecentMessages).mockResolvedValue([
        { messageId: 'm1', senderId: 'ou_user_1', senderType: 'user', content: 'hi', msgType: 'text' },
        { messageId: 'm2', senderId: 'ou_user_other', senderType: 'user', content: 'yo', msgType: 'text' },
      ] as any);
      mockCheckThreadRelevance.mockResolvedValue(false);

      expect(await resolveMentionGate({
        ...baseInput, threadId: 'omt_existing_topic',
      })).toBeUndefined();
      vi.mocked(fc.fetchRecentMessages).mockResolvedValue([]);
    });

    it('blocks thread_bypass when user is not session creator or owner', async () => {
      mockGetThreadSession.mockImplementation((_: string, agentId?: string) => {
        if (agentId === 'dev') return { userId: 'ou_different_user', createdAt: '2026-01-01T00:00:00Z' };
        return undefined;
      });
      mockCheckThreadRelevance.mockResolvedValue(true);

      expect(await resolveMentionGate({
        ...baseInput, threadId: 'omt_existing_topic',
      })).toBeUndefined();
    });

    it('skips thread_bypass when another bot was @mentioned', async () => {
      mockGetThreadSession.mockImplementation((_: string, agentId?: string) => {
        if (agentId === 'dev') return { userId: 'ou_user_1', createdAt: '2026-01-01T00:00:00Z' };
        return undefined;
      });
      const otherBotMention = { id: { open_id: 'ou_pm_bot' } };
      // When a bot is mentioned, thread bypass is skipped; getRespondReason checks mention
      expect(await resolveMentionGate({
        ...baseInput, mentions: [otherBotMention], threadId: 'omt_existing_topic',
      })).toBeUndefined();
    });
  });

  // ── 边界情况 ──

  describe('edge cases', () => {
    it('handles empty text gracefully', async () => {
      expect(await resolveMentionGate({ ...baseInput, text: '' })).toBeUndefined();
    });

    it('handles undefined images/documents', async () => {
      expect(await resolveMentionGate({
        ...baseInput, images: undefined, documents: undefined,
      })).toBeUndefined();
    });

    it('handles mentions with missing open_id', async () => {
      mockIsMultiBotMode.mockReturnValue(true);
      const brokenMention = { id: {} };
      expect(await resolveMentionGate({
        ...baseInput, mentions: [brokenMention],
      })).toBeUndefined();
    });

    it('multi-bot mode with empty botOpenId still blocks', async () => {
      mockIsMultiBotMode.mockReturnValue(true);
      mockGetBotOpenId.mockReturnValue(undefined as any);
      expect(await resolveMentionGate({ ...baseInput })).toBeUndefined();
    });
  });

  // ── Bug 复现场景 ──

  describe('bug reproduction: 话题内 @人类 但 bot 不应响应', () => {
    it('multi-bot: @human in topic without bot session → blocked', async () => {
      mockIsMultiBotMode.mockReturnValue(true);
      const humanMention = { id: { open_id: 'ou_relic_product_xz' } };

      const result = await resolveMentionGate({
        ...baseInput,
        mentions: [humanMention],
        threadId: 'omt_1a9f2e23ad959c95',
        text: '@Relic-产品小赵 拉一下 四季物语 这个游戏的源码',
      });

      expect(result).toBeUndefined();
    });

    it('multi-bot: plain message in topic without bot session → blocked', async () => {
      mockIsMultiBotMode.mockReturnValue(true);

      const result = await resolveMentionGate({
        ...baseInput,
        threadId: 'omt_1a9f2e23ad959c95',
        text: '查个边玩边下和预加载的问题',
      });

      expect(result).toBeUndefined();
    });

    it('multi-bot: @human in topic WITH bot session, third person present, semantic=false → blocked', async () => {
      mockIsMultiBotMode.mockReturnValue(true);
      mockGetThreadSession.mockImplementation((_: string, agentId?: string) => {
        if (agentId === 'dev') return { userId: 'ou_user_1', createdAt: '2026-01-01T00:00:00Z' };
        return undefined;
      });
      const { feishuClient: fc } = await import('../feishu/client.js');
      vi.mocked(fc.fetchRecentMessages).mockResolvedValue([
        { messageId: 'm1', senderId: 'ou_user_1', senderType: 'user', content: 'hi', msgType: 'text' },
        { messageId: 'm2', senderId: 'ou_relic_product_xz', senderType: 'user', content: 'ok', msgType: 'text' },
      ] as any);
      mockCheckThreadRelevance.mockResolvedValue(false);

      const humanMention = { id: { open_id: 'ou_relic_product_xz' } };
      const result = await resolveMentionGate({
        ...baseInput,
        mentions: [humanMention],
        threadId: 'omt_topic',
        text: '@Relic-产品小赵 看一下这个问题',
      });

      expect(result).toBeUndefined();
      vi.mocked(fc.fetchRecentMessages).mockResolvedValue([]);
    });

    it('single-bot: group message without @mention → blocked', async () => {
      mockIsMultiBotMode.mockReturnValue(false);

      const result = await resolveMentionGate({
        ...baseInput,
        text: '查个边玩边下和预加载的问题',
      });

      expect(result).toBeUndefined();
    });
  });
});
