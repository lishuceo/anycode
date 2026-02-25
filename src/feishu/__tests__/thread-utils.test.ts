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
      expect(result.threadRootMsgId).toBe('om_root_msg_id');
      expect(result.greetingMsgId).toBeUndefined();
    });

    it('should throw when rootId is present but threadId is missing', async () => {
      await expect(
        ensureThread('chat1', 'user1', 'msg-1', 'om_root_msg_id', undefined),
      ).rejects.toThrow('threadId missing');

      expect(mockSessionSetThread).not.toHaveBeenCalled();
    });

    it('should not create a new thread when rootId is present', async () => {
      await ensureThread('chat1', 'user1', 'msg-1', 'om_root', 'omt_thread');

      expect(mockCreateThreadWithCard).not.toHaveBeenCalled();
    });
  });

  describe('without rootId (new message in main chat)', () => {
    it('should create a new thread and return greeting message ID', async () => {
      const result = await ensureThread('chat1', 'user1', 'msg-new');

      expect(mockCreateThreadWithCard).toHaveBeenCalledWith('msg-new', { type: 'greeting' });
      expect(mockSessionSetThread).toHaveBeenCalledWith(
        'chat1', 'user1',
        'omt_new_thread',  // threadId from createThreadWithCard
        'msg-new',         // original user message as rootMessageId
        'dev',             // agentId — default
      );
      expect(result.threadRootMsgId).toBe('msg-new');
      expect(result.greetingMsgId).toBe('bot-card-msg-1');
    });

    it('should ignore threadId param when no rootId (new thread creation)', async () => {
      // threadId without rootId shouldn't happen, but if it does, still create new thread
      await ensureThread('chat1', 'user1', 'msg-new', undefined, 'omt_stale');

      expect(mockCreateThreadWithCard).toHaveBeenCalled();
    });

    it('should fallback gracefully when thread creation fails', async () => {
      mockCreateThreadWithCard.mockResolvedValue({
        messageId: undefined,
        threadId: undefined,
      });

      const result = await ensureThread('chat1', 'user1', 'msg-new');

      expect(result.threadRootMsgId).toBeUndefined();
      expect(result.greetingMsgId).toBeUndefined();
      expect(mockSessionSetThread).not.toHaveBeenCalled();
    });
  });
});
