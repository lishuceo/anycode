import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock lark SDK
vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    constructor() {}
    request = vi.fn().mockResolvedValue({ code: 0, bot: { open_id: 'bot_open_id_mock', app_name: 'TestBot' } });
    im = {
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: 'msg1' } }),
        reply: vi.fn().mockResolvedValue({ data: { message_id: 'msg1' } }),
        patch: vi.fn().mockResolvedValue({}),
      },
      chatMembers: {},
    };
    contact = { user: { get: vi.fn() } };
  }
  class MockWSClient {
    constructor() {}
    start = vi.fn().mockResolvedValue(undefined);
  }
  class MockEventDispatcher {
    constructor() {}
    register = vi.fn();
  }
  class MockCardActionHandler {
    constructor() {}
  }
  return {
    Client: MockClient,
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
    CardActionHandler: MockCardActionHandler,
  };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  config: {
    feishu: {
      appId: 'default_app',
      appSecret: 'default_secret',
      encryptKey: '',
      verifyToken: '',
      tools: { doc: false, wiki: false, drive: false, bitable: false, chat: false },
    },
    claude: { defaultWorkDir: '/tmp' },
    agent: { bindings: [], botAccounts: [], groupConfigs: {} },
    chat: { historyMaxCount: 10, historyMaxChars: 4000 },
    db: { sessionDbPath: ':memory:' },
  },
  isMultiBotMode: () => false,
}));

// Mock accountManager — controls what getAllBotOpenIds returns
const mockGetAllBotOpenIds = vi.fn(() => new Set<string>(['ou_self_bot']));
vi.mock('../feishu/multi-account.js', () => ({
  accountManager: {
    getAllBotOpenIds: () => mockGetAllBotOpenIds(),
    getBotOpenId: vi.fn(),
    getClient: vi.fn(),
    getDefaultClient: vi.fn(),
    allAccounts: vi.fn(() => []),
    initializeSingleBot: vi.fn(),
  },
}));

// Mock feishu client
vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    botOpenId: 'ou_self_bot',
    replyText: vi.fn().mockResolvedValue(undefined),
    replyTextInThread: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    replyCardInThread: vi.fn().mockResolvedValue(undefined),
    updateCard: vi.fn().mockResolvedValue(undefined),
    downloadMessageImage: vi.fn(),
    fetchRecentMessages: vi.fn().mockResolvedValue([]),
    getUserName: vi.fn(),
    getChatMembers: vi.fn().mockResolvedValue([]),
    fetchBotInfo: vi.fn().mockResolvedValue(undefined),
  },
  runWithAccountId: vi.fn((_accountId: string, fn: () => any) => fn()),
}));

// Mock other dependencies that event-handler imports
vi.mock('../session/manager.js', () => ({
  sessionManager: {
    get: vi.fn(),
    getOrCreate: vi.fn(() => ({ workingDir: '/tmp', status: 'idle' })),
    setWorkingDir: vi.fn(),
    setStatus: vi.fn(),
    setConversationId: vi.fn(),
    getThreadSession: vi.fn(),
    upsertThreadSession: vi.fn(),
    setThreadConversationId: vi.fn(),
    setThreadWorkingDir: vi.fn(),
    resetThreadConversation: vi.fn(),
    reset: vi.fn(),
    cleanup: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock('../session/queue.js', () => ({
  taskQueue: {
    enqueue: vi.fn().mockResolvedValue(undefined),
    dequeue: vi.fn(),
    complete: vi.fn(),
    cancelAllForChat: vi.fn(),
    pendingCountForChat: vi.fn(() => 0),
  },
}));

vi.mock('../claude/executor.js', () => ({
  claudeExecutor: {
    execute: vi.fn(),
    killSessionsForChat: vi.fn(),
    killAll: vi.fn(),
    cleanup: vi.fn(),
  },
}));

vi.mock('../feishu/approval.js', () => ({
  checkAndRequestApproval: vi.fn().mockResolvedValue(true),
  handleApprovalTextCommand: vi.fn(() => false),
  handleApprovalCardAction: vi.fn(),
  setOnApproved: vi.fn(),
  cleanupExpiredApprovals: vi.fn(),
}));

vi.mock('../feishu/thread-context.js', () => ({
  resolveThreadContext: vi.fn(),
}));

vi.mock('../pipeline/store.js', () => ({
  pipelineStore: {
    get: vi.fn(),
    findPendingByChat: vi.fn(),
    tryStart: vi.fn(),
    markRunningAsInterrupted: vi.fn(),
    cleanExpired: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock('../pipeline/runner.js', () => ({
  createPendingPipeline: vi.fn(),
  startPipeline: vi.fn(),
  abortPipeline: vi.fn(),
  cancelPipeline: vi.fn(),
  retryPipeline: vi.fn(),
  recoverInterruptedPipelines: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../agent/router.js', () => ({
  resolveAgent: vi.fn(() => 'dev'),
  shouldRespond: vi.fn(() => true),
}));

vi.mock('../agent/registry.js', () => ({
  agentRegistry: {
    get: vi.fn(() => undefined),
    getOrThrow: vi.fn(() => ({ replyMode: 'thread' })),
    allIds: vi.fn(() => ['dev']),
  },
}));

vi.mock('../agent/config-loader.js', () => ({
  readPersonaFile: vi.fn(),
  loadKnowledgeContent: vi.fn(),
  loadAgentConfig: vi.fn(() => ({})),
  startConfigWatcher: vi.fn(),
  stopConfigWatcher: vi.fn(),
  reloadAgentConfig: vi.fn(),
}));

vi.mock('../agent/tools/discussion.js', () => ({
  createDiscussionMcpServer: vi.fn(),
}));

vi.mock('../workspace/manager.js', () => ({
  setupWorkspace: vi.fn(),
}));

import { chatBotRegistry } from '../feishu/bot-registry.js';

describe('Bot event handlers', () => {
  let handleBotAddedEvent: (data: Record<string, unknown>, accountId: string) => void;
  let handleBotDeletedEvent: (data: Record<string, unknown>, accountId: string) => void;

  beforeEach(async () => {
    // Clear the singleton registry before each test
    chatBotRegistry.clearChat('chat1');
    chatBotRegistry.clearChat('chat2');

    // Reset self bot IDs
    mockGetAllBotOpenIds.mockReturnValue(new Set(['ou_self_bot']));

    // Dynamic import to get the _testing export after mocks are set up
    const mod = await import('../feishu/event-handler.js');
    handleBotAddedEvent = mod._testing.handleBotAddedEvent;
    handleBotDeletedEvent = mod._testing.handleBotDeletedEvent;
  });

  describe('handleBotAddedEvent', () => {
    it('should add bots to registry with source event_added', () => {
      handleBotAddedEvent({
        chat_id: 'chat1',
        users: [
          { user_id: { open_id: 'ou_external_bot' }, name: 'ExternalBot' },
        ],
      }, 'default');

      const bots = chatBotRegistry.getBots('chat1');
      expect(bots).toHaveLength(1);
      expect(bots[0]).toMatchObject({
        openId: 'ou_external_bot',
        name: 'ExternalBot',
        source: 'event_added',
      });
    });

    it('should exclude self bot from registry', () => {
      handleBotAddedEvent({
        chat_id: 'chat1',
        users: [
          { user_id: { open_id: 'ou_self_bot' }, name: 'SelfBot' },
          { user_id: { open_id: 'ou_external_bot' }, name: 'ExternalBot' },
        ],
      }, 'default');

      const bots = chatBotRegistry.getBots('chat1');
      expect(bots).toHaveLength(1);
      expect(bots[0].openId).toBe('ou_external_bot');
    });

    it('should handle missing chatId gracefully', () => {
      expect(() => {
        handleBotAddedEvent({
          users: [{ user_id: { open_id: 'ou_bot' }, name: 'Bot' }],
        }, 'default');
      }).not.toThrow();

      // No crash, no registry entry
    });

    it('should handle missing users gracefully', () => {
      expect(() => {
        handleBotAddedEvent({ chat_id: 'chat1' }, 'default');
      }).not.toThrow();
    });

    it('should skip users without open_id', () => {
      handleBotAddedEvent({
        chat_id: 'chat1',
        users: [
          { user_id: {}, name: 'NoIdBot' },
          { name: 'NoUserIdBot' },
          { user_id: { open_id: 'ou_valid' }, name: 'ValidBot' },
        ],
      }, 'default');

      const bots = chatBotRegistry.getBots('chat1');
      expect(bots).toHaveLength(1);
      expect(bots[0].openId).toBe('ou_valid');
    });

    it('should add multiple bots from a single event', () => {
      handleBotAddedEvent({
        chat_id: 'chat1',
        users: [
          { user_id: { open_id: 'ou_bot1' }, name: 'Bot1' },
          { user_id: { open_id: 'ou_bot2' }, name: 'Bot2' },
        ],
      }, 'default');

      expect(chatBotRegistry.getBots('chat1')).toHaveLength(2);
    });
  });

  describe('handleBotDeletedEvent', () => {
    it('should remove other bot from registry', () => {
      // Pre-populate
      chatBotRegistry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      chatBotRegistry.addBot('chat1', 'ou_bot2', 'Bot2', 'event_added');

      handleBotDeletedEvent({
        chat_id: 'chat1',
        users: [{ user_id: { open_id: 'ou_bot1' } }],
      }, 'default');

      const bots = chatBotRegistry.getBots('chat1');
      expect(bots).toHaveLength(1);
      expect(bots[0].openId).toBe('ou_bot2');
    });

    it('should clearChat when self bot is removed', () => {
      // Pre-populate
      chatBotRegistry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      chatBotRegistry.addBot('chat1', 'ou_bot2', 'Bot2', 'event_added');

      handleBotDeletedEvent({
        chat_id: 'chat1',
        users: [{ user_id: { open_id: 'ou_self_bot' } }],
      }, 'default');

      // All bots cleared for this chat
      expect(chatBotRegistry.getBots('chat1')).toHaveLength(0);
    });

    it('should handle missing data gracefully', () => {
      expect(() => {
        handleBotDeletedEvent({}, 'default');
      }).not.toThrow();

      expect(() => {
        handleBotDeletedEvent({ chat_id: 'chat1' }, 'default');
      }).not.toThrow();
    });
  });

  describe('passive collection (sender_type detection)', () => {
    // The passive collection is tested indirectly through chatBotRegistry.
    // Since handleMessageEvent is a complex async function with many deps,
    // we test the core logic pattern: sender_type === 'app' → addBot.

    it('should add bot when sender_type is app and not self', () => {
      // Simulate what handleMessageEvent does for passive collection
      const senderType = 'app';
      const userId = 'ou_external_bot';
      const chatId = 'chat1';
      const selfBotOpenIds = new Set(['ou_self_bot']);

      if (senderType === 'app' && userId && chatId) {
        if (!selfBotOpenIds.has(userId)) {
          chatBotRegistry.addBot(chatId, userId, undefined, 'message_sender');
        }
      }

      const bots = chatBotRegistry.getBots('chat1');
      expect(bots).toHaveLength(1);
      expect(bots[0]).toMatchObject({
        openId: 'ou_external_bot',
        source: 'message_sender',
      });
      expect(bots[0].name).toBeUndefined();
    });

    it('should NOT add human user when sender_type is user', () => {
      const senderType: string = 'user';
      const userId = 'ou_human';
      const chatId = 'chat1';
      const selfBotOpenIds = new Set(['ou_self_bot']);

      if (senderType === 'app' && userId && chatId) {
        if (!selfBotOpenIds.has(userId)) {
          chatBotRegistry.addBot(chatId, userId, undefined, 'message_sender');
        }
      }

      expect(chatBotRegistry.getBots('chat1')).toHaveLength(0);
    });

    it('should NOT add self bot to registry', () => {
      const senderType = 'app';
      const userId = 'ou_self_bot';
      const chatId = 'chat1';
      const selfBotOpenIds = new Set(['ou_self_bot']);

      if (senderType === 'app' && userId && chatId) {
        if (!selfBotOpenIds.has(userId)) {
          chatBotRegistry.addBot(chatId, userId, undefined, 'message_sender');
        }
      }

      expect(chatBotRegistry.getBots('chat1')).toHaveLength(0);
    });

    it('should upgrade passive detection to event source', () => {
      // First: passive detection (no name)
      chatBotRegistry.addBot('chat1', 'ou_bot1', undefined, 'message_sender');
      expect(chatBotRegistry.getBots('chat1')[0].source).toBe('message_sender');

      // Then: event arrives with name
      chatBotRegistry.addBot('chat1', 'ou_bot1', 'BotName', 'event_added');
      const bots = chatBotRegistry.getBots('chat1');
      expect(bots).toHaveLength(1);
      expect(bots[0].source).toBe('event_added');
      expect(bots[0].name).toBe('BotName');
    });
  });
});
