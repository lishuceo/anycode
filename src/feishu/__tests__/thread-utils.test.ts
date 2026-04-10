// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockSessionGetOrCreate = vi.fn(() => ({
  chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
}));
const mockSessionSetThread = vi.fn();

vi.mock('../../session/manager.js', () => ({
  sessionManager: {
    getOrCreate: (...args: unknown[]) => mockSessionGetOrCreate(...args),
    setThread: (...args: unknown[]) => mockSessionSetThread(...args),
  },
}));

const mockCreateThreadWithCard = vi.fn(() => Promise.resolve({
  messageId: 'bot-card-msg-1',
  threadId: 'omt_new_thread',
}));

vi.mock('../client.js', () => ({
  feishuClient: {
    createThreadWithCard: (...args: unknown[]) => mockCreateThreadWithCard(...args),
  },
}));

vi.mock('../message-builder.js', () => ({
  buildGreetingCard: vi.fn(() => ({ type: 'greeting' })),
  buildCombinedProgressCard: vi.fn(() => ({ type: 'combined_progress' })),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Import after mocks
const { ensureThread } = await import('../thread-utils.js');

// ============================================================
// Tests
// ============================================================

describe('ensureThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('with rootId (user replies in existing thread)', () => {
    it('should use threadId over rootId for session thread identification', async () => {
      const result = await ensureThread(
        'chat1', 'user1', 'msg-1',
        'om_root_msg_id',      // rootId (message ID)
        'omt_real_thread_id',  // threadId (actual thread ID)
      );

      // setThread should use threadId for identification, rootId for reply target
      expect(mockSessionSetThread).toHaveBeenCalledWith(
        'chat1', 'user1',
        'omt_real_thread_id',  // threadId — used as session thread identifier
        'om_root_msg_id',      // rootId — used as threadRootMessageId for replies
        'dev',                 // agentId — default
      );
      // Reply target should be rootId (message_id for reply_in_thread)
      expect(result.threadReplyMsgId).toBe('om_root_msg_id');
      expect(result.greetingMsgId).toBeUndefined();
    });

    it('should treat rootId without threadId as main chat quote-reply (not a thread)', async () => {
      // rootId without threadId = user used "quote reply" in main chat, not a thread message
      // Should create a new thread, not throw
      const result = await ensureThread('chat1', 'user1', 'msg-1', 'om_root_msg_id', undefined);

      expect(mockCreateThreadWithCard).toHaveBeenCalledWith('msg-1', { type: 'combined_progress' });
      expect(result.greetingMsgId).toBe('bot-card-msg-1');
    });

    it('should not create a new thread when rootId is present', async () => {
      await ensureThread('chat1', 'user1', 'msg-1', 'om_root', 'omt_thread');

      expect(mockCreateThreadWithCard).not.toHaveBeenCalled();
    });
  });

  describe('without rootId (new message in main chat)', () => {
    it('should create a new thread and return greeting message ID', async () => {
      const result = await ensureThread('chat1', 'user1', 'msg-new');

      expect(mockCreateThreadWithCard).toHaveBeenCalledWith('msg-new', { type: 'combined_progress' });
      expect(mockSessionSetThread).toHaveBeenCalledWith(
        'chat1', 'user1',
        'omt_new_thread',  // threadId from createThreadWithCard
        'msg-new',         // original user message as rootMessageId
        'dev',             // agentId — default
      );
      expect(result.threadReplyMsgId).toBe('msg-new');
      expect(result.greetingMsgId).toBe('bot-card-msg-1');
    });

    it('should reuse thread when threadId is present even without rootId', async () => {
      // threadId is the authoritative indicator of "in a thread"
      // rootId undefined → fallback to messageId for reply target
      const result = await ensureThread('chat1', 'user1', 'msg-new', undefined, 'omt_stale');

      expect(mockSessionSetThread).toHaveBeenCalledWith(
        'chat1', 'user1', 'omt_stale', 'msg-new', 'dev',
      );
      expect(mockCreateThreadWithCard).not.toHaveBeenCalled();
      expect(result.threadReplyMsgId).toBe('msg-new');
    });

    it('should fallback gracefully when thread creation fails', async () => {
      mockCreateThreadWithCard.mockResolvedValue({
        messageId: undefined,
        threadId: undefined,
      });

      const result = await ensureThread('chat1', 'user1', 'msg-new');

      expect(result.threadReplyMsgId).toBeUndefined();
      expect(result.greetingMsgId).toBeUndefined();
      expect(mockSessionSetThread).not.toHaveBeenCalled();
    });
  });
});
