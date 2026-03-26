import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    constructor() {}
    request = vi.fn().mockResolvedValue({ code: 0, bot: { open_id: 'bot_mock', app_name: 'TestBot' } });
    im = { message: { create: vi.fn(), reply: vi.fn(), patch: vi.fn() }, chatMembers: {} };
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

// isMultiBotMode — will be overridden per test
const mockIsMultiBotMode = vi.fn(() => false);
vi.mock('../config.js', () => ({
  config: {
    feishu: {
      appId: 'app1', appSecret: 'secret',
      encryptKey: '', verifyToken: '',
      tools: { doc: false, wiki: false, drive: false, bitable: false, chat: false },
    },
    claude: { defaultWorkDir: '/tmp' },
    agent: { bindings: [], botAccounts: [], groupConfigs: {} },
    chat: { historyMaxCount: 10, historyMaxChars: 4000 },
    db: { sessionDbPath: ':memory:' },
  },
  isMultiBotMode: () => mockIsMultiBotMode(),
}));

// accountManager mock
interface MockAccount { accountId: string; botName: string; botOpenId?: string }
interface MockBot { openId: string; name?: string; source: string; discoveredAt: number }
const mockGetAccount = vi.fn<(id: string) => MockAccount | undefined>();
const mockGetAllBotOpenIds = vi.fn(() => new Set<string>());
const mockAllAccounts = vi.fn<() => MockAccount[]>(() => []);
vi.mock('../feishu/multi-account.js', () => ({
  accountManager: {
    getAllBotOpenIds: () => mockGetAllBotOpenIds(),
    getBotOpenId: vi.fn(),
    getClient: vi.fn(),
    getDefaultClient: vi.fn(),
    getAccount: (id: string) => mockGetAccount(id),
    allAccounts: () => mockAllAccounts(),
    initializeSingleBot: vi.fn(),
  },
}));

// chatBotRegistry mock
const mockGetBots = vi.fn<(chatId: string) => MockBot[]>(() => []);
vi.mock('../feishu/bot-registry.js', () => ({
  chatBotRegistry: {
    getBots: (chatId: string) => mockGetBots(chatId),
    addBot: vi.fn(),
    removeBot: vi.fn(),
    clearChat: vi.fn(),
  },
}));

// feishuClientContext mock (AsyncLocalStorage)
const mockGetStore = vi.fn();
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    botOpenId: 'ou_self',
    replyText: vi.fn(), replyTextInThread: vi.fn(),
    sendCard: vi.fn(), replyCardInThread: vi.fn(), updateCard: vi.fn(),
    downloadMessageImage: vi.fn(), fetchRecentMessages: vi.fn().mockResolvedValue([]),
    getUserName: vi.fn(), getChatMembers: vi.fn().mockResolvedValue([]),
    fetchBotInfo: vi.fn(), sendText: vi.fn(),
  },
  feishuClientContext: { getStore: () => mockGetStore() },
  runWithAccountId: vi.fn((_id: string, fn: () => any) => fn()),
}));

// Remaining required mocks
vi.mock('../session/manager.js', () => ({
  sessionManager: {
    get: vi.fn(), getOrCreate: vi.fn(() => ({ workingDir: '/tmp', status: 'idle' })),
    setWorkingDir: vi.fn(), setStatus: vi.fn(), setConversationId: vi.fn(),
    getThreadSession: vi.fn(), upsertThreadSession: vi.fn(),
    setThreadConversationId: vi.fn(), setThreadWorkingDir: vi.fn(),
    resetThreadConversation: vi.fn(), reset: vi.fn(), cleanup: vi.fn(), close: vi.fn(),
  },
}));
vi.mock('../session/queue.js', () => ({
  taskQueue: { enqueue: vi.fn(), dequeue: vi.fn(), complete: vi.fn(), cancelAllForChat: vi.fn(), pendingCountForChat: vi.fn(() => 0) },
}));
vi.mock('../claude/executor.js', () => ({
  claudeExecutor: { execute: vi.fn(), killSessionsForChat: vi.fn(), killAll: vi.fn(), cleanup: vi.fn() },
}));
vi.mock('../feishu/approval.js', () => ({
  checkAndRequestApproval: vi.fn().mockResolvedValue(true),
  handleApprovalTextCommand: vi.fn(() => false),
  handleApprovalCardAction: vi.fn(),
  setOnApproved: vi.fn(),
  cleanupExpiredApprovals: vi.fn(),
}));
vi.mock('../feishu/thread-context.js', () => ({ resolveThreadContext: vi.fn() }));
vi.mock('../pipeline/store.js', () => ({
  pipelineStore: { get: vi.fn(), findPendingByChat: vi.fn(), tryStart: vi.fn(), markRunningAsInterrupted: vi.fn(), cleanExpired: vi.fn(), close: vi.fn() },
}));
vi.mock('../pipeline/runner.js', () => ({
  createPendingPipeline: vi.fn(), startPipeline: vi.fn(), abortPipeline: vi.fn(),
  cancelPipeline: vi.fn(), retryPipeline: vi.fn(), recoverInterruptedPipelines: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../agent/router.js', () => ({ resolveAgent: vi.fn(() => 'dev'), shouldRespond: vi.fn(() => true) }));
vi.mock('../agent/registry.js', () => ({
  agentRegistry: { get: vi.fn(() => undefined), getOrThrow: vi.fn(), allIds: vi.fn(() => ['dev']) },
}));
vi.mock('../agent/config-loader.js', () => ({
  readPersonaFile: vi.fn(), loadKnowledgeContent: vi.fn(),
  loadAgentConfig: vi.fn(() => ({})), startConfigWatcher: vi.fn(), stopConfigWatcher: vi.fn(), reloadAgentConfig: vi.fn(),
}));
vi.mock('../agent/tools/discussion.js', () => ({ createDiscussionMcpServer: vi.fn() }));
vi.mock('../feishu/message-builder.js', () => ({
  buildResultCard: vi.fn(), buildStatusCard: vi.fn(), buildCancelledCard: vi.fn(),
  buildPipelineCard: vi.fn(), buildPipelineConfirmCard: vi.fn(), buildProgressCard: vi.fn(),
  buildToolProgressCard: vi.fn(), buildTextContentCard: vi.fn(), buildSimpleResultCard: vi.fn(),
}));
vi.mock('../feishu/message-parser.js', () => ({ formatMergeForwardSubMessage: vi.fn() }));
vi.mock('../feishu/mention-resolver.js', () => ({ resolveMentions: vi.fn() }));
vi.mock('../feishu/oauth.js', () => ({
  generateAuthUrl: vi.fn(), hasCallbackUrl: vi.fn(() => false), handleManualCode: vi.fn(),
}));
vi.mock('../memory/injector.js', () => ({ injectMemories: vi.fn().mockResolvedValue('') }));
vi.mock('../memory/extractor.js', () => ({ extractMemories: vi.fn() }));
vi.mock('../memory/commands.js', () => ({ handleMemoryCommand: vi.fn(), handleMemoryCardAction: vi.fn() }));
vi.mock('../workspace/identity.js', () => ({ getRepoIdentity: vi.fn(() => '/tmp') }));
vi.mock('../utils/quick-ack.js', () => ({ generateQuickAck: vi.fn() }));
vi.mock('../utils/thread-relevance.js', () => ({ checkThreadRelevance: vi.fn() }));
vi.mock('../utils/image-compress.js', () => ({ compressImage: vi.fn(), compressImageForHistory: vi.fn() }));

// ── Tests ────────────────────────────────────────────────────

describe('buildBotIdentityContext', () => {
  let buildBotIdentityContext: typeof import('../feishu/event-handler.js').buildBotIdentityContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../feishu/event-handler.js');
    buildBotIdentityContext = mod.buildBotIdentityContext;
  });

  it('returns undefined in single-bot mode', () => {
    mockIsMultiBotMode.mockReturnValue(false);
    expect(buildBotIdentityContext('chat1')).toBeUndefined();
  });

  it('returns undefined when no accountId in context', () => {
    mockIsMultiBotMode.mockReturnValue(true);
    mockGetStore.mockReturnValue(undefined);
    expect(buildBotIdentityContext('chat1')).toBeUndefined();
  });

  it('returns undefined when account not found', () => {
    mockIsMultiBotMode.mockReturnValue(true);
    mockGetStore.mockReturnValue('unknown_account');
    mockGetAccount.mockReturnValue(undefined);
    expect(buildBotIdentityContext('chat1')).toBeUndefined();
  });

  it('includes self bot name in identity context', () => {
    mockIsMultiBotMode.mockReturnValue(true);
    mockGetStore.mockReturnValue('dev');
    mockGetAccount.mockReturnValue({
      accountId: 'dev',
      botName: '张全栈',
      botOpenId: 'ou_dev',
    });
    mockGetAllBotOpenIds.mockReturnValue(new Set(['ou_dev']));
    mockGetBots.mockReturnValue([]);
    mockAllAccounts.mockReturnValue([
      { accountId: 'dev', botName: '张全栈', botOpenId: 'ou_dev' },
    ]);

    const result = buildBotIdentityContext('chat1');
    expect(result).toContain('张全栈');
    expect(result).toContain('你的身份');
  });

  it('lists other bots from registry (excluding self)', () => {
    mockIsMultiBotMode.mockReturnValue(true);
    mockGetStore.mockReturnValue('dev');
    mockGetAccount.mockReturnValue({
      accountId: 'dev',
      botName: '张全栈',
      botOpenId: 'ou_dev',
    });
    mockGetAllBotOpenIds.mockReturnValue(new Set(['ou_dev', 'ou_pm']));
    mockGetBots.mockReturnValue([
      { openId: 'ou_pm_cross', name: '土豆儿', source: 'message_sender', discoveredAt: Date.now() },
    ]);
    mockAllAccounts.mockReturnValue([
      { accountId: 'dev', botName: '张全栈', botOpenId: 'ou_dev' },
      { accountId: 'pm', botName: '土豆儿', botOpenId: 'ou_pm' },
    ]);

    const result = buildBotIdentityContext('chat1');
    expect(result).toContain('张全栈');
    expect(result).toContain('土豆儿');
    expect(result).toContain('群内其他机器人');
    expect(result).toContain('@土豆儿');
    expect(result).toContain('不要使用 feishu_send_to_chat');
  });

  it('deduplicates bots from registry and managed accounts', () => {
    mockIsMultiBotMode.mockReturnValue(true);
    mockGetStore.mockReturnValue('dev');
    mockGetAccount.mockReturnValue({
      accountId: 'dev',
      botName: '张全栈',
      botOpenId: 'ou_dev',
    });
    mockGetAllBotOpenIds.mockReturnValue(new Set(['ou_dev', 'ou_pm']));
    // Registry already has 土豆儿
    mockGetBots.mockReturnValue([
      { openId: 'ou_pm_cross', name: '土豆儿', source: 'message_sender', discoveredAt: Date.now() },
    ]);
    // Managed accounts also has 土豆儿
    mockAllAccounts.mockReturnValue([
      { accountId: 'dev', botName: '张全栈', botOpenId: 'ou_dev' },
      { accountId: 'pm', botName: '土豆儿', botOpenId: 'ou_pm' },
    ]);

    const result = buildBotIdentityContext('chat1')!;
    // 土豆儿 should appear exactly once in the bot list
    const matches = result.match(/土豆儿/g);
    // 3 occurrences: once in the list, once in the @example, and it's deduplicated from managed
    // Actually: "- 土豆儿" in list + "@土豆儿" in instruction = at least 2
    expect(matches).toBeTruthy();
    // No duplicate "- 土豆儿" entries
    const listEntries = result.match(/^- 土豆儿$/gm);
    expect(listEntries).toHaveLength(1);
  });

  it('excludes self openId from registry bots', () => {
    mockIsMultiBotMode.mockReturnValue(true);
    mockGetStore.mockReturnValue('dev');
    mockGetAccount.mockReturnValue({
      accountId: 'dev',
      botName: '张全栈',
      botOpenId: 'ou_dev',
    });
    mockGetAllBotOpenIds.mockReturnValue(new Set(['ou_dev']));
    // Registry has self bot (cross-app perspective might use different open_id)
    mockGetBots.mockReturnValue([
      { openId: 'ou_dev', name: '张全栈', source: 'message_sender', discoveredAt: Date.now() },
      { openId: 'ou_other', name: '大师', source: 'event_added', discoveredAt: Date.now() },
    ]);
    mockAllAccounts.mockReturnValue([
      { accountId: 'dev', botName: '张全栈', botOpenId: 'ou_dev' },
    ]);

    const result = buildBotIdentityContext('chat1')!;
    expect(result).toContain('大师');
    // 张全栈 appears in self identity but not in other bots list
    const otherBotSection = result.split('群内其他机器人')[1];
    expect(otherBotSection).not.toContain('- 张全栈');
  });

  it('omits other bots section when no other bots exist', () => {
    mockIsMultiBotMode.mockReturnValue(true);
    mockGetStore.mockReturnValue('dev');
    mockGetAccount.mockReturnValue({
      accountId: 'dev',
      botName: '张全栈',
      botOpenId: 'ou_dev',
    });
    mockGetAllBotOpenIds.mockReturnValue(new Set(['ou_dev']));
    mockGetBots.mockReturnValue([]);
    mockAllAccounts.mockReturnValue([
      { accountId: 'dev', botName: '张全栈', botOpenId: 'ou_dev' },
    ]);

    const result = buildBotIdentityContext('chat1')!;
    expect(result).toContain('张全栈');
    expect(result).not.toContain('群内其他机器人');
    expect(result).not.toContain('feishu_send_to_chat');
  });
});
