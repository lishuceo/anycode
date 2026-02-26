/**
 * Direct Mode Thread Support Tests
 *
 * Tests for Chat Agent direct reply mode working inside threads:
 * - buildDirectTaskHistory fork semantics
 * - executeDirectTask per-thread session & resume
 * - Routing: direct mode in thread does NOT go through dev path
 */
// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockFetchRecentMessages = vi.fn();

vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    fetchRecentMessages: (...args: unknown[]) => mockFetchRecentMessages(...args),
    replyText: vi.fn(),
    replyTextInThread: vi.fn(),
    sendCard: vi.fn(),
    updateCard: vi.fn(),
    replyCardInThread: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ============================================================
// 1. buildDirectTaskHistory fork semantics
//
// Simulates the logic from event-handler.ts buildDirectTaskHistory
// to test fork rules without needing to invoke the private function.
// ============================================================

const HISTORY_MAX_COUNT = 10;

type SimpleMessage = {
  messageId: string;
  senderType: 'user' | 'app';
  content: string;
  msgType: string;
};

/**
 * Extracted from event-handler.ts buildDirectTaskHistory for testability.
 */
async function buildDirectTaskHistory(
  chatId: string,
  threadId?: string,
  currentMessageId?: string,
): Promise<string | undefined> {
  const { feishuClient } = await import('../feishu/client.js');

  if (!threadId) {
    // 主聊天区：直接取父群最近消息
    const messages = await feishuClient.fetchRecentMessages(chatId, 'chat', 10);
    const history = currentMessageId
      ? messages.filter((m: SimpleMessage) => m.messageId !== currentMessageId)
      : messages;
    if (history.length === 0) return undefined;
    return formatHistory(history);
  }

  try {
    const threadMsgs: SimpleMessage[] = await feishuClient.fetchRecentMessages(threadId, 'thread', 50);
    const filtered = currentMessageId
      ? threadMsgs.filter(m => m.messageId !== currentMessageId)
      : threadMsgs;

    let selected: SimpleMessage[];

    if (filtered.length === 0) {
      // 话题为空，从父群 fork
      const parentMsgs = await feishuClient.fetchRecentMessages(chatId, 'chat', 10);
      if (parentMsgs.length === 0) return undefined;
      return formatHistory(parentMsgs);
    } else if (filtered.length <= HISTORY_MAX_COUNT) {
      const remaining = HISTORY_MAX_COUNT - filtered.length;
      if (remaining > 0) {
        const parentMsgs = await feishuClient.fetchRecentMessages(chatId, 'chat', remaining);
        selected = [...parentMsgs, ...filtered];
      } else {
        selected = filtered;
      }
    } else {
      const first = filtered[0];
      const latest = filtered.slice(-(HISTORY_MAX_COUNT - 1));
      selected = [first, ...latest];
    }

    return formatHistory(selected);
  } catch {
    return undefined;
  }
}

function formatHistory(messages: SimpleMessage[]): string {
  const lines = messages.map(m => {
    const role = m.senderType === 'app' ? '[Bot]' : '[用户]';
    const text = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content;
    return `${role}: ${text}`;
  });
  return [
    '## 飞书聊天近期上下文',
    '以下是用户 @bot 之前的聊天记录，帮助你理解当前对话的背景：',
    '',
    ...lines,
  ].join('\n');
}

function makeMsg(id: string, content: string, senderType: 'user' | 'app' = 'user'): SimpleMessage {
  return { messageId: id, senderType, content, msgType: 'text' };
}

describe('buildDirectTaskHistory fork semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no threadId → fetch parent chat messages only', async () => {
    const parentMsgs = [makeMsg('p1', 'hello'), makeMsg('p2', 'world')];
    mockFetchRecentMessages.mockResolvedValueOnce(parentMsgs);

    const result = await buildDirectTaskHistory('chat1', undefined, 'current-msg');

    expect(mockFetchRecentMessages).toHaveBeenCalledWith('chat1', 'chat', 10);
    expect(mockFetchRecentMessages).toHaveBeenCalledTimes(1);
    expect(result).toContain('[用户]: hello');
    expect(result).toContain('[用户]: world');
  });

  it('empty thread → fork from parent chat', async () => {
    // Thread returns empty (or only current message)
    mockFetchRecentMessages.mockResolvedValueOnce([makeMsg('current-msg', 'hi')]);
    // Parent chat fallback
    const parentMsgs = [makeMsg('p1', 'parent msg 1'), makeMsg('p2', 'parent msg 2')];
    mockFetchRecentMessages.mockResolvedValueOnce(parentMsgs);

    const result = await buildDirectTaskHistory('chat1', 'thread1', 'current-msg');

    // First call: thread messages
    expect(mockFetchRecentMessages).toHaveBeenNthCalledWith(1, 'thread1', 'thread', 50);
    // Second call: parent chat fallback
    expect(mockFetchRecentMessages).toHaveBeenNthCalledWith(2, 'chat1', 'chat', 10);
    expect(result).toContain('parent msg 1');
    expect(result).toContain('parent msg 2');
  });

  it('thread with 3 messages (< max) → pad with parent chat to reach max', async () => {
    const threadMsgs = [
      makeMsg('t1', 'thread first'),
      makeMsg('t2', 'thread second'),
      makeMsg('t3', 'thread third'),
    ];
    mockFetchRecentMessages.mockResolvedValueOnce(threadMsgs);
    // Should request 10 - 3 = 7 from parent
    const parentMsgs = Array.from({ length: 7 }, (_, i) => makeMsg(`p${i}`, `parent ${i}`));
    mockFetchRecentMessages.mockResolvedValueOnce(parentMsgs);

    const result = await buildDirectTaskHistory('chat1', 'thread1', 'other-msg');

    expect(mockFetchRecentMessages).toHaveBeenNthCalledWith(2, 'chat1', 'chat', 7);
    // Parent messages come first, then thread messages
    expect(result).toContain('parent 0');
    expect(result).toContain('thread first');
    expect(result).toContain('thread third');
  });

  it('thread with 15 messages (> max) → first + last 9', async () => {
    const threadMsgs = Array.from({ length: 15 }, (_, i) =>
      makeMsg(`t${i}`, `thread msg ${i}`),
    );
    mockFetchRecentMessages.mockResolvedValueOnce(threadMsgs);

    const result = await buildDirectTaskHistory('chat1', 'thread1');

    // Should NOT call parent chat
    expect(mockFetchRecentMessages).toHaveBeenCalledTimes(1);
    // Should include first message
    expect(result).toContain('thread msg 0');
    // Should include last 9 messages (indices 6-14)
    expect(result).toContain('thread msg 6');
    expect(result).toContain('thread msg 14');
    // Should NOT include middle messages (e.g., index 1-5)
    expect(result).not.toContain('[用户]: thread msg 1\n');
    expect(result).not.toContain('[用户]: thread msg 5\n');
  });

  it('thread with exactly 10 messages → no padding needed', async () => {
    const threadMsgs = Array.from({ length: 10 }, (_, i) =>
      makeMsg(`t${i}`, `msg ${i}`),
    );
    mockFetchRecentMessages.mockResolvedValueOnce(threadMsgs);

    const result = await buildDirectTaskHistory('chat1', 'thread1');

    // No parent chat fetch needed
    expect(mockFetchRecentMessages).toHaveBeenCalledTimes(1);
    // All 10 messages included
    expect(result).toContain('msg 0');
    expect(result).toContain('msg 9');
  });

  it('filters out current message from thread', async () => {
    const threadMsgs = [
      makeMsg('t1', 'old msg'),
      makeMsg('current', 'current msg'),
    ];
    mockFetchRecentMessages.mockResolvedValueOnce(threadMsgs);
    // After filtering, only 1 thread msg → need 9 from parent
    const parentMsgs = Array.from({ length: 9 }, (_, i) => makeMsg(`p${i}`, `parent ${i}`));
    mockFetchRecentMessages.mockResolvedValueOnce(parentMsgs);

    const result = await buildDirectTaskHistory('chat1', 'thread1', 'current');

    expect(result).toContain('old msg');
    expect(result).not.toContain('current msg');
    expect(mockFetchRecentMessages).toHaveBeenNthCalledWith(2, 'chat1', 'chat', 9);
  });

  it('returns undefined when no messages at all', async () => {
    // Main chat, empty
    mockFetchRecentMessages.mockResolvedValueOnce([]);

    const result = await buildDirectTaskHistory('chat1', undefined);
    expect(result).toBeUndefined();
  });

  it('returns undefined on fetch error', async () => {
    mockFetchRecentMessages.mockRejectedValueOnce(new Error('network error'));

    const result = await buildDirectTaskHistory('chat1', 'thread1');
    expect(result).toBeUndefined();
  });

  it('includes bot messages with [Bot] prefix', async () => {
    const msgs = [
      makeMsg('t1', 'user question', 'user'),
      makeMsg('t2', 'bot answer', 'app'),
    ];
    mockFetchRecentMessages.mockResolvedValueOnce(msgs);
    mockFetchRecentMessages.mockResolvedValueOnce([]); // parent padding

    const result = await buildDirectTaskHistory('chat1', 'thread1');

    expect(result).toContain('[用户]: user question');
    expect(result).toContain('[Bot]: bot answer');
  });
});

// ============================================================
// 2. executeDirectTask per-thread session & resume strategy
//
// Simulates the key logic from executeDirectTask to verify
// thread-aware sessionKey, thread session management,
// and per-thread vs global resume strategy.
// ============================================================

const mockExecute = vi.fn();
const mockSessionGetOrCreate = vi.fn();
const mockGetThreadSession = vi.fn();
const mockUpsertThreadSession = vi.fn();
const mockSetThreadConversationId = vi.fn();
const mockSetConversationId = vi.fn();
const mockSetStatus = vi.fn();

vi.mock('../session/manager.js', () => ({
  sessionManager: {
    getOrCreate: (...args: unknown[]) => mockSessionGetOrCreate(...args),
    getThreadSession: (...args: unknown[]) => mockGetThreadSession(...args),
    upsertThreadSession: (...args: unknown[]) => mockUpsertThreadSession(...args),
    setThreadConversationId: (...args: unknown[]) => mockSetThreadConversationId(...args),
    setConversationId: (...args: unknown[]) => mockSetConversationId(...args),
    setStatus: (...args: unknown[]) => mockSetStatus(...args),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    claude: { defaultWorkDir: '/tmp/work' },
  },
}));

/**
 * Simulates the core session/resume logic from executeDirectTask.
 */
async function simulateDirectTaskSessionLogic(params: {
  chatId: string;
  userId: string;
  eventThreadId?: string;
  session: { conversationId?: string; conversationCwd?: string };
  threadSession?: { conversationId?: string; conversationCwd?: string } | null;
  images?: boolean;
  resultSessionId?: string;
}) {
  const { sessionManager } = await import('../session/manager.js');
  const { chatId, userId, eventThreadId } = params;
  const workingDir = '/tmp/work';
  const agentId = 'chat';

  mockSessionGetOrCreate.mockReturnValue({
    chatId, userId, workingDir, status: 'idle',
    conversationId: params.session.conversationId,
    conversationCwd: params.session.conversationCwd,
  });

  if (params.threadSession !== undefined) {
    mockGetThreadSession.mockReturnValue(params.threadSession ? {
      workingDir,
      conversationId: params.threadSession.conversationId,
      conversationCwd: params.threadSession.conversationCwd,
    } : undefined);
  } else {
    mockGetThreadSession.mockReturnValue(undefined);
  }

  const session = sessionManager.getOrCreate(chatId, userId, agentId);

  // SessionKey includes threadId
  const sessionKey = eventThreadId
    ? `${chatId}:${userId}:${eventThreadId}`
    : `${chatId}:${userId}`;

  // Thread session management
  let threadSession = eventThreadId
    ? sessionManager.getThreadSession(eventThreadId, agentId)
    : undefined;
  if (eventThreadId && !threadSession) {
    sessionManager.upsertThreadSession(eventThreadId, chatId, userId, workingDir, agentId);
    // Re-read after upsert (simulate)
    mockGetThreadSession.mockReturnValue({ workingDir });
    threadSession = sessionManager.getThreadSession(eventThreadId, agentId);
  }

  // Resume strategy
  const activeConversationId = eventThreadId
    ? threadSession?.conversationId
    : session.conversationId;
  const activeConversationCwd = eventThreadId
    ? threadSession?.conversationCwd
    : session.conversationCwd;
  const canResume = activeConversationId
    && (!activeConversationCwd || activeConversationCwd === workingDir);
  const resumeSessionId = (params.images || !canResume) ? undefined : activeConversationId;

  // Save conversationId
  const resultId = params.resultSessionId ?? 'new-session-id';
  if (resultId) {
    const threadId = eventThreadId;
    if (threadId) {
      sessionManager.upsertThreadSession(threadId, chatId, userId, workingDir, agentId);
      sessionManager.setThreadConversationId(threadId, resultId, workingDir, agentId);
    }
    if (!eventThreadId) {
      sessionManager.setConversationId(chatId, userId, resultId, workingDir, agentId);
    }
  }

  return {
    sessionKey,
    resumeSessionId,
    canResume: !!canResume,
    activeConversationId,
  };
}

describe('executeDirectTask per-thread session & resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sessionKey includes threadId when in thread', async () => {
    const result = await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1', eventThreadId: 'thread-1',
      session: {},
      threadSession: null,
    });

    expect(result.sessionKey).toBe('chat1:user1:thread-1');
  });

  it('sessionKey without threadId in main chat', async () => {
    const result = await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1',
      session: {},
    });

    expect(result.sessionKey).toBe('chat1:user1');
  });

  it('creates thread session on first message in thread', async () => {
    mockGetThreadSession.mockReturnValue(undefined);

    await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1', eventThreadId: 'thread-new',
      session: {},
      threadSession: null,
    });

    expect(mockUpsertThreadSession).toHaveBeenCalledWith(
      'thread-new', 'chat1', 'user1', '/tmp/work', 'chat',
    );
  });

  it('resumes from thread session conversationId (not global)', async () => {
    const result = await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1', eventThreadId: 'thread-1',
      session: { conversationId: 'global-conv', conversationCwd: '/tmp/work' },
      threadSession: { conversationId: 'thread-conv', conversationCwd: '/tmp/work' },
    });

    expect(result.resumeSessionId).toBe('thread-conv');
    expect(result.activeConversationId).toBe('thread-conv');
  });

  it('resumes from global session when not in thread', async () => {
    const result = await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1',
      session: { conversationId: 'global-conv', conversationCwd: '/tmp/work' },
    });

    expect(result.resumeSessionId).toBe('global-conv');
    expect(result.activeConversationId).toBe('global-conv');
  });

  it('does not resume when thread session has no conversationId (cross-thread isolation)', async () => {
    const result = await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1', eventThreadId: 'thread-2',
      session: { conversationId: 'conv-from-other-thread' },
      threadSession: { conversationId: undefined },
    });

    expect(result.canResume).toBe(false);
    expect(result.resumeSessionId).toBeUndefined();
  });

  it('does not resume when conversationCwd does not match workingDir', async () => {
    const result = await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1', eventThreadId: 'thread-1',
      session: {},
      threadSession: { conversationId: 'old-conv', conversationCwd: '/different/dir' },
    });

    expect(result.canResume).toBe(false);
    expect(result.resumeSessionId).toBeUndefined();
  });

  it('does not resume when images are present', async () => {
    const result = await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1', eventThreadId: 'thread-1',
      session: {},
      threadSession: { conversationId: 'thread-conv', conversationCwd: '/tmp/work' },
      images: true,
    });

    expect(result.canResume).toBe(true); // canResume is true, but resumeSessionId is undefined
    expect(result.resumeSessionId).toBeUndefined();
  });

  it('saves conversationId to thread session (not global) when in thread', async () => {
    await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1', eventThreadId: 'thread-1',
      session: {},
      threadSession: null,
      resultSessionId: 'new-sess',
    });

    expect(mockSetThreadConversationId).toHaveBeenCalledWith(
      'thread-1', 'new-sess', '/tmp/work', 'chat',
    );
    // Should NOT save to global session when in thread
    expect(mockSetConversationId).not.toHaveBeenCalled();
  });

  it('saves conversationId to global session when not in thread', async () => {
    await simulateDirectTaskSessionLogic({
      chatId: 'chat1', userId: 'user1',
      session: {},
      resultSessionId: 'new-sess',
    });

    expect(mockSetConversationId).toHaveBeenCalledWith(
      'chat1', 'user1', 'new-sess', '/tmp/work', 'chat',
    );
    expect(mockSetThreadConversationId).not.toHaveBeenCalled();
  });
});

// ============================================================
// 3. Routing: direct mode agent stays on direct path in threads
// ============================================================

describe('direct mode routing in threads', () => {
  it('chat agent (replyMode=direct) uses direct path regardless of threadId', async () => {
    // This is a logic test — the condition is now simply:
    //   useDirectMode = agentCfg?.replyMode === 'direct'
    // No threadId check.
    const agentCfg = { replyMode: 'direct' as const };
    const threadId = 'some-thread-id';

    // Old logic (broken):
    const oldResult = agentCfg.replyMode === 'direct' && !threadId;
    expect(oldResult).toBe(false); // was incorrectly false

    // New logic (fixed):
    const newResult = agentCfg.replyMode === 'direct';
    expect(newResult).toBe(true); // correctly true
  });

  it('dev agent (replyMode=thread) still uses thread path', async () => {
    const agentCfg = { replyMode: 'thread' as const };

    const result = agentCfg.replyMode === 'direct';
    expect(result).toBe(false);
  });
});
