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

interface HistoryResult {
  text?: string;
  newestMsgId?: string;
}

/**
 * Extracted from event-handler.ts buildDirectTaskHistory for testability.
 * Supports afterMsgId for incremental dedup on resume.
 */
async function buildDirectTaskHistory(
  chatId: string,
  threadId?: string,
  currentMessageId?: string,
  afterMsgId?: string,
): Promise<HistoryResult> {
  const { feishuClient } = await import('../feishu/client.js');

  try {
    let messages: SimpleMessage[];

    if (!threadId) {
      messages = await feishuClient.fetchRecentMessages(chatId, 'chat', 10);
      if (currentMessageId) {
        messages = messages.filter((m: SimpleMessage) => m.messageId !== currentMessageId);
      }
    } else {
      const threadMsgs: SimpleMessage[] = await feishuClient.fetchRecentMessages(threadId, 'thread', 50);
      const filtered = currentMessageId
        ? threadMsgs.filter(m => m.messageId !== currentMessageId)
        : threadMsgs;

      if (filtered.length === 0) {
        messages = await feishuClient.fetchRecentMessages(chatId, 'chat', 10);
      } else if (filtered.length <= HISTORY_MAX_COUNT) {
        const remaining = HISTORY_MAX_COUNT - filtered.length;
        if (remaining > 0) {
          const parentMsgs = await feishuClient.fetchRecentMessages(chatId, 'chat', remaining);
          messages = [...parentMsgs, ...filtered];
        } else {
          messages = filtered;
        }
      } else {
        const first = filtered[0];
        const latest = filtered.slice(-(HISTORY_MAX_COUNT - 1));
        messages = [first, ...latest];
      }
    }

    const newestMsgId = messages.length > 0 ? messages[messages.length - 1].messageId : undefined;

    // Incremental dedup: only keep messages after afterMsgId
    if (afterMsgId && messages.length > 0) {
      const idx = messages.findIndex(m => m.messageId === afterMsgId);
      if (idx >= 0) {
        messages = messages.slice(idx + 1);
      }
    }

    const text = formatHistory(messages);
    return { text: text ?? undefined, newestMsgId };
  } catch {
    return {};
  }
}

/** Match the production formatHistoryMessages logic (with total budget guard) */
const TOTAL_BUDGET = 8000; // matches default CHAT_HISTORY_MAX_CHARS
const PER_MSG_MAX = 500;

function formatHistory(messages: SimpleMessage[]): string | undefined {
  if (messages.length === 0) return undefined;

  const header = [
    '## 飞书聊天近期上下文',
    '以下是用户 @bot 之前的聊天记录，帮助你理解当前对话的背景：',
    '',
  ].join('\n');

  const lines = messages.map(m => {
    const role = m.senderType === 'app' ? '[Bot]' : '[用户]';
    const text = m.content.length > PER_MSG_MAX
      ? m.content.slice(0, PER_MSG_MAX) + '...'
      : m.content;
    return `${role}: ${text}`;
  });

  // Total budget guard: drop oldest messages first
  let totalLen = header.length;
  let keepFrom = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    totalLen += lines[i].length + 1;
    if (totalLen > TOTAL_BUDGET) {
      keepFrom = i + 1;
      break;
    }
  }

  const kept = keepFrom > 0 ? lines.slice(keepFrom) : lines;
  if (kept.length === 0) return undefined;

  const parts = [header];
  if (keepFrom > 0) {
    parts.push(`_(已省略 ${keepFrom} 条较早消息)_`);
  }
  parts.push(...kept);
  return parts.join('\n');
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

    const { text } = await buildDirectTaskHistory('chat1', undefined, 'current-msg');

    expect(mockFetchRecentMessages).toHaveBeenCalledWith('chat1', 'chat', 10);
    expect(mockFetchRecentMessages).toHaveBeenCalledTimes(1);
    expect(text).toContain('[用户]: hello');
    expect(text).toContain('[用户]: world');
  });

  it('empty thread → fork from parent chat', async () => {
    // Thread returns empty (or only current message)
    mockFetchRecentMessages.mockResolvedValueOnce([makeMsg('current-msg', 'hi')]);
    // Parent chat fallback
    const parentMsgs = [makeMsg('p1', 'parent msg 1'), makeMsg('p2', 'parent msg 2')];
    mockFetchRecentMessages.mockResolvedValueOnce(parentMsgs);

    const { text } = await buildDirectTaskHistory('chat1', 'thread1', 'current-msg');

    // First call: thread messages
    expect(mockFetchRecentMessages).toHaveBeenNthCalledWith(1, 'thread1', 'thread', 50);
    // Second call: parent chat fallback
    expect(mockFetchRecentMessages).toHaveBeenNthCalledWith(2, 'chat1', 'chat', 10);
    expect(text).toContain('parent msg 1');
    expect(text).toContain('parent msg 2');
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

    const { text } = await buildDirectTaskHistory('chat1', 'thread1', 'other-msg');

    expect(mockFetchRecentMessages).toHaveBeenNthCalledWith(2, 'chat1', 'chat', 7);
    // Parent messages come first, then thread messages
    expect(text).toContain('parent 0');
    expect(text).toContain('thread first');
    expect(text).toContain('thread third');
  });

  it('thread with 15 messages (> max) → first + last 9', async () => {
    const threadMsgs = Array.from({ length: 15 }, (_, i) =>
      makeMsg(`t${i}`, `thread msg ${i}`),
    );
    mockFetchRecentMessages.mockResolvedValueOnce(threadMsgs);

    const { text } = await buildDirectTaskHistory('chat1', 'thread1');

    // Should NOT call parent chat
    expect(mockFetchRecentMessages).toHaveBeenCalledTimes(1);
    // Should include first message
    expect(text).toContain('thread msg 0');
    // Should include last 9 messages (indices 6-14)
    expect(text).toContain('thread msg 6');
    expect(text).toContain('thread msg 14');
    // Should NOT include middle messages (e.g., index 1-5)
    expect(text).not.toContain('[用户]: thread msg 1\n');
    expect(text).not.toContain('[用户]: thread msg 5\n');
  });

  it('thread with exactly 10 messages → no padding needed', async () => {
    const threadMsgs = Array.from({ length: 10 }, (_, i) =>
      makeMsg(`t${i}`, `msg ${i}`),
    );
    mockFetchRecentMessages.mockResolvedValueOnce(threadMsgs);

    const { text } = await buildDirectTaskHistory('chat1', 'thread1');

    // No parent chat fetch needed
    expect(mockFetchRecentMessages).toHaveBeenCalledTimes(1);
    // All 10 messages included
    expect(text).toContain('msg 0');
    expect(text).toContain('msg 9');
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

    const { text } = await buildDirectTaskHistory('chat1', 'thread1', 'current');

    expect(text).toContain('old msg');
    expect(text).not.toContain('current msg');
    expect(mockFetchRecentMessages).toHaveBeenNthCalledWith(2, 'chat1', 'chat', 9);
  });

  it('returns no text when no messages at all', async () => {
    mockFetchRecentMessages.mockResolvedValueOnce([]);

    const { text } = await buildDirectTaskHistory('chat1', undefined);
    expect(text).toBeUndefined();
  });

  it('returns empty result on fetch error', async () => {
    mockFetchRecentMessages.mockRejectedValueOnce(new Error('network error'));

    const result = await buildDirectTaskHistory('chat1', 'thread1');
    expect(result.text).toBeUndefined();
  });

  it('includes bot messages with [Bot] prefix', async () => {
    const msgs = [
      makeMsg('t1', 'user question', 'user'),
      makeMsg('t2', 'bot answer', 'app'),
    ];
    mockFetchRecentMessages.mockResolvedValueOnce(msgs);
    mockFetchRecentMessages.mockResolvedValueOnce([]); // parent padding

    const { text } = await buildDirectTaskHistory('chat1', 'thread1');

    expect(text).toContain('[用户]: user question');
    expect(text).toContain('[Bot]: bot answer');
  });

  it('returns newestMsgId for dedup tracking', async () => {
    const msgs = [makeMsg('m1', 'first'), makeMsg('m2', 'second'), makeMsg('m3', 'third')];
    mockFetchRecentMessages.mockResolvedValueOnce(msgs);

    const { newestMsgId } = await buildDirectTaskHistory('chat1', undefined);
    expect(newestMsgId).toBe('m3');
  });

  it('afterMsgId dedup: only returns new messages', async () => {
    const msgs = [makeMsg('m1', 'old'), makeMsg('m2', 'seen'), makeMsg('m3', 'new msg')];
    mockFetchRecentMessages.mockResolvedValueOnce(msgs);

    const { text, newestMsgId } = await buildDirectTaskHistory('chat1', undefined, undefined, 'm2');

    expect(text).toContain('new msg');
    expect(text).not.toContain('[用户]: old');
    expect(text).not.toContain('[用户]: seen');
    expect(newestMsgId).toBe('m3'); // newestMsgId is from pre-filter list
  });

  it('afterMsgId dedup: returns no text when no new messages', async () => {
    const msgs = [makeMsg('m1', 'old'), makeMsg('m2', 'latest')];
    mockFetchRecentMessages.mockResolvedValueOnce(msgs);

    const { text, newestMsgId } = await buildDirectTaskHistory('chat1', undefined, undefined, 'm2');

    expect(text).toBeUndefined(); // no messages after m2
    expect(newestMsgId).toBe('m2');
  });

  it('afterMsgId not found → inject all (messages may have scrolled)', async () => {
    const msgs = [makeMsg('m5', 'msg 5'), makeMsg('m6', 'msg 6')];
    mockFetchRecentMessages.mockResolvedValueOnce(msgs);

    const { text } = await buildDirectTaskHistory('chat1', undefined, undefined, 'm1');

    // m1 not in list → all messages injected
    expect(text).toContain('msg 5');
    expect(text).toContain('msg 6');
  });
});

// ============================================================
// 1b. formatHistoryMessages total budget guard
// ============================================================

describe('formatHistoryMessages total budget guard', () => {
  it('truncates individual messages > 500 chars', () => {
    const longContent = 'a'.repeat(600);
    const result = formatHistory([makeMsg('m1', longContent)]);

    expect(result).toContain('a'.repeat(500) + '...');
    expect(result).not.toContain('a'.repeat(501));
  });

  it('drops oldest messages when total exceeds budget', () => {
    // Each message ~500 chars (after truncation), 20 of them ≈ 10000+ chars → exceeds 8000 budget
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeMsg(`m${i}`, `msg-${i}-${'x'.repeat(490)}`),
    );

    const result = formatHistory(msgs);
    expect(result).toBeDefined();

    // Should keep most recent messages and drop oldest
    expect(result).toContain('msg-19-');  // most recent kept
    expect(result).toContain('已省略');    // drop indicator present
  });

  it('keeps all messages when within budget', () => {
    const msgs = [
      makeMsg('m1', 'short msg 1'),
      makeMsg('m2', 'short msg 2'),
      makeMsg('m3', 'short msg 3'),
    ];

    const result = formatHistory(msgs);
    expect(result).toContain('short msg 1');
    expect(result).toContain('short msg 3');
    expect(result).not.toContain('已省略');
  });

  it('returns undefined for empty messages', () => {
    expect(formatHistory([])).toBeUndefined();
  });
});

// ============================================================
// 2. executeDirectTask per-thread session & resume strategy
//
// Simulates the key logic from executeDirectTask to verify
// thread-aware sessionKey, thread session management,
// and per-thread vs global resume strategy.
// ============================================================

const _mockExecute = vi.fn();
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
  const agentId = 'pm';

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
      'thread-new', 'chat1', 'user1', '/tmp/work', 'pm',
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
      'thread-1', 'new-sess', '/tmp/work', 'pm',
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
      'chat1', 'user1', 'new-sess', '/tmp/work', 'pm',
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
