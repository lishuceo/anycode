/**
 * Tests for buildChatHistoryContext fork semantics.
 *
 * buildChatHistoryContext now mirrors buildDirectTaskHistory's fork logic:
 * - No threadId → fetch from parent chat only
 * - Thread empty → fork from parent chat
 * - Thread messages < max → supplement with parent chat messages
 * - Thread messages ≥ max → first + latest (max - 1)
 * - Structured sections (parentMsgCount) passed to formatHistoryMessages
 */
// @ts-nocheck — test file
import { describe, it, expect, vi } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockFetchRecentMessages = vi.fn();

vi.mock('../client.js', () => ({
  feishuClient: {
    fetchRecentMessages: (...args: unknown[]) => mockFetchRecentMessages(...args),
    getUserName: vi.fn().mockResolvedValue(null),
    replyText: vi.fn(),
    replyInThread: vi.fn(),
    sendCard: vi.fn(),
    updateCard: vi.fn(),
    replyCardInThread: vi.fn(),
    sendText: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    feishu: { encryptKey: '', verifyToken: '' },
    security: { allowedUserIds: [] },
    claude: { defaultWorkDir: '/tmp/work' },
    workspace: { baseDir: '/tmp/workspaces', branchPrefix: 'feat/test' },
    db: { pipelineDbPath: ':memory:' },
    agent: { bindings: [], groupConfigs: {} },
    chat: { historyMaxCount: 10, historyMaxChars: 8000 },
    memory: { enabled: false },
  },
  isMultiBotMode: vi.fn(() => false),
}));

// event-handler.ts dependency chain mocks
vi.mock('../../claude/executor.js', () => ({
  claudeExecutor: { execute: vi.fn(), killSession: vi.fn() },
}));
vi.mock('../../session/manager.js', () => ({
  sessionManager: {
    get: vi.fn(), getOrCreate: vi.fn(), setWorkingDir: vi.fn(),
    setStatus: vi.fn(), setConversationId: vi.fn(), setThread: vi.fn(),
    getThreadSession: vi.fn(), upsertThreadSession: vi.fn(),
    setThreadConversationId: vi.fn(), setThreadWorkingDir: vi.fn(),
    getRecentSummaries: vi.fn(() => []), saveSummary: vi.fn(), reset: vi.fn(),
  },
}));
vi.mock('../../session/queue.js', () => ({
  taskQueue: { enqueue: vi.fn(), dequeue: vi.fn(), complete: vi.fn(), pendingCount: vi.fn(() => 0), cancelPending: vi.fn(() => 0), isBusy: vi.fn(() => false) },
}));
vi.mock('../message-builder.js', () => ({
  buildProgressCard: vi.fn(), buildResultCard: vi.fn(), buildStatusCard: vi.fn(),
}));
vi.mock('../../utils/security.js', () => ({
  isUserAllowed: vi.fn(() => true), containsDangerousCommand: vi.fn(() => false),
}));
vi.mock('../../pipeline/store.js', () => ({
  pipelineStore: { get: vi.fn(), findPendingByChat: vi.fn(), tryStart: vi.fn() },
}));
vi.mock('../../pipeline/runner.js', () => ({
  createPendingPipeline: vi.fn(), startPipeline: vi.fn(),
  abortPipeline: vi.fn(), cancelPipeline: vi.fn(), retryPipeline: vi.fn(),
}));
vi.mock('../../agent/router.js', () => ({
  resolveAgent: vi.fn(() => 'dev'), shouldRespond: vi.fn(() => true),
}));
vi.mock('../../agent/registry.js', () => ({
  agentRegistry: { get: vi.fn(), getOrThrow: vi.fn(), allIds: vi.fn(() => []) },
}));
vi.mock('../multi-account.js', () => ({
  accountManager: { getAllBotOpenIds: vi.fn(() => new Set()), getBotOpenId: vi.fn() },
}));
vi.mock('../bot-registry.js', () => ({
  chatBotRegistry: { getBots: vi.fn(() => []), addBot: vi.fn(), removeBot: vi.fn(), clearChat: vi.fn() },
}));
vi.mock('../approval.js', () => ({
  checkAndRequestApproval: vi.fn(() => true), handleApprovalTextCommand: vi.fn(() => false), handleApprovalCardAction: vi.fn(), setOnApproved: vi.fn(),
}));
vi.mock('../thread-context.js', () => ({ resolveThreadContext: vi.fn() }));
vi.mock('../../agent/config-loader.js', () => ({ readPersonaFile: vi.fn(), loadKnowledgeContent: vi.fn() }));
vi.mock('../../agent/tools/discussion.js', () => ({ createDiscussionMcpServer: vi.fn() }));
vi.mock('../oauth.js', () => ({ generateAuthUrl: vi.fn(), hasCallbackUrl: vi.fn(), handleManualCode: vi.fn() }));
vi.mock('../../memory/injector.js', () => ({ injectMemories: vi.fn(() => '') }));
vi.mock('../../memory/extractor.js', () => ({ extractMemories: vi.fn() }));
vi.mock('../../memory/commands.js', () => ({ handleMemoryCommand: vi.fn(), handleMemoryCardAction: vi.fn() }));
vi.mock('../../workspace/identity.js', () => ({ getRepoIdentity: vi.fn((p: string) => p) }));
vi.mock('../../utils/quick-ack.js', () => ({ generateQuickAck: vi.fn() }));
vi.mock('../../utils/thread-relevance.js', () => ({ checkThreadRelevance: vi.fn() }));
vi.mock('../../workspace/manager.js', () => ({ setupWorkspace: vi.fn() }));

// ============================================================
// Replicate buildChatHistoryContext fork logic for testing
// (function is private, same approach as direct-thread.test.ts)
// ============================================================

const HISTORY_MAX_COUNT = 10;

type SimpleMessage = {
  messageId: string;
  senderId: string;
  senderType: 'user' | 'app';
  content: string;
  msgType: string;
  createTime?: string;
};

interface ForkResult {
  messages: SimpleMessage[];
  parentMsgCount: number;
}

/**
 * Extracted fork logic from the updated buildChatHistoryContext.
 */
function forkMessages(
  threadId: string | undefined,
  threadMsgs: SimpleMessage[],
  parentMsgs: SimpleMessage[],
  currentMessageId?: string,
): ForkResult {
  let messages: SimpleMessage[];
  let parentMsgCount = 0;

  if (!threadId) {
    messages = currentMessageId
      ? parentMsgs.filter(m => m.messageId !== currentMessageId)
      : parentMsgs;
    return { messages, parentMsgCount: 0 };
  }

  // Thread mode: fork semantics
  const filtered = currentMessageId
    ? threadMsgs.filter(m => m.messageId !== currentMessageId)
    : threadMsgs;

  if (filtered.length === 0) {
    // Thread empty → fork from parent
    messages = parentMsgs;
  } else if (filtered.length <= HISTORY_MAX_COUNT) {
    // Thread < max → supplement with parent
    const remaining = HISTORY_MAX_COUNT - filtered.length;
    if (remaining > 0 && parentMsgs.length > 0) {
      parentMsgCount = parentMsgs.length;
      messages = [...parentMsgs, ...filtered];
    } else {
      messages = filtered;
    }
  } else {
    // Thread > max → first + latest (max - 1)
    const first = filtered[0];
    const latest = filtered.slice(-(HISTORY_MAX_COUNT - 1));
    messages = [first, ...latest];
  }

  return { messages, parentMsgCount };
}

function makeMsg(id: string, content: string, senderType: 'user' | 'app' = 'user'): SimpleMessage {
  return { messageId: id, senderId: `sender_${id}`, senderType, content, msgType: 'text' };
}

// ============================================================
// Tests
// ============================================================

describe('buildChatHistoryContext fork semantics', () => {
  describe('fork logic (unit)', () => {
    it('no threadId → returns parent chat messages only', () => {
      const parentMsgs = [makeMsg('p1', 'hello'), makeMsg('p2', 'world')];
      const { messages, parentMsgCount } = forkMessages(undefined, [], parentMsgs);
      expect(messages).toHaveLength(2);
      expect(parentMsgCount).toBe(0);
    });

    it('no threadId → filters current message', () => {
      const parentMsgs = [makeMsg('p1', 'hello'), makeMsg('current', 'me')];
      const { messages } = forkMessages(undefined, parentMsgs, parentMsgs, 'current');
      expect(messages).toHaveLength(1);
      expect(messages[0].messageId).toBe('p1');
    });

    it('empty thread → fork from parent chat', () => {
      const parentMsgs = [makeMsg('p1', 'parent msg 1'), makeMsg('p2', 'parent msg 2')];
      const threadMsgs = [makeMsg('current', 'hi')]; // only current message
      const { messages, parentMsgCount } = forkMessages('thread1', threadMsgs, parentMsgs, 'current');
      expect(messages).toEqual(parentMsgs);
      expect(parentMsgCount).toBe(0); // fork mode, not supplement
    });

    it('thread with 3 messages (< max) → supplement with parent', () => {
      const threadMsgs = [
        makeMsg('t1', 'thread first'),
        makeMsg('t2', 'thread second'),
        makeMsg('t3', 'thread third'),
      ];
      const parentMsgs = Array.from({ length: 7 }, (_, i) => makeMsg(`p${i}`, `parent ${i}`));
      const { messages, parentMsgCount } = forkMessages('thread1', threadMsgs, parentMsgs);

      // Parent messages first, then thread messages
      expect(messages).toHaveLength(10);
      expect(messages[0].content).toBe('parent 0');
      expect(messages[7].content).toBe('thread first');
      expect(parentMsgCount).toBe(7);
    });

    it('thread with exactly 10 messages → no supplementing', () => {
      const threadMsgs = Array.from({ length: 10 }, (_, i) => makeMsg(`t${i}`, `msg ${i}`));
      const { messages, parentMsgCount } = forkMessages('thread1', threadMsgs, []);
      expect(messages).toHaveLength(10);
      expect(parentMsgCount).toBe(0);
    });

    it('thread with 15 messages (> max) → first + last 9', () => {
      const threadMsgs = Array.from({ length: 15 }, (_, i) => makeMsg(`t${i}`, `thread msg ${i}`));
      const { messages, parentMsgCount } = forkMessages('thread1', threadMsgs, []);

      expect(messages).toHaveLength(10);
      expect(messages[0].content).toBe('thread msg 0'); // first
      expect(messages[1].content).toBe('thread msg 6'); // latest[0]
      expect(messages[9].content).toBe('thread msg 14'); // latest[8]
      expect(parentMsgCount).toBe(0);
    });

    it('filters current message from thread before fork calculation', () => {
      const threadMsgs = [
        makeMsg('t1', 'old msg'),
        makeMsg('current', 'current msg'),
      ];
      const parentMsgs = Array.from({ length: 9 }, (_, i) => makeMsg(`p${i}`, `parent ${i}`));
      const { messages, parentMsgCount } = forkMessages('thread1', threadMsgs, parentMsgs, 'current');

      // After filtering: 1 thread msg, supplement with 9 parent
      expect(messages).toHaveLength(10);
      expect(messages.find(m => m.content === 'current msg')).toBeUndefined();
      expect(parentMsgCount).toBe(9);
    });
  });

  describe('structured sections via formatHistoryMessages', () => {
    it('renders structured sections when parentMsgCount > 0', async () => {
      const { _testFormatHistoryMessages: formatHistoryMessages } = await import('../event-handler.js');
      const parentMsgs = [
        makeMsg('p1', 'parent context 1'),
        makeMsg('p2', 'parent context 2'),
      ];
      const threadMsgs = [
        makeMsg('t1', 'thread question'),
      ];
      const combined = [...parentMsgs, ...threadMsgs];

      const result = await formatHistoryMessages(combined, 'chat1', undefined, { parentMsgCount: 2 });

      expect(result).toContain('### 群主聊天');
      expect(result).toContain('### 当前话题');
      expect(result).toContain('parent context 1');
      expect(result).toContain('thread question');
    });

    it('renders flat list when no parent supplement (parentMsgCount = 0)', async () => {
      const { _testFormatHistoryMessages: formatHistoryMessages } = await import('../event-handler.js');
      const threadMsgs = [
        makeMsg('t1', 'msg one'),
        makeMsg('t2', 'msg two'),
      ];

      const result = await formatHistoryMessages(threadMsgs, 'chat1');

      expect(result).toContain('以下是用户 @bot 之前的聊天记录');
      expect(result).not.toContain('### 群主聊天');
      expect(result).not.toContain('### 当前话题');
    });
  });
});
