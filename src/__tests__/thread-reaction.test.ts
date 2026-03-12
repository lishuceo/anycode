/**
 * Thread Reaction Tests
 *
 * Tests for the emoji reaction feature in thread messages:
 * - When user @bot in a thread (no quick-ack), bot adds a reaction as immediate feedback
 * - After formal reply is sent, bot removes the reaction
 * - Reaction cleanup happens in finally block (even on error)
 */
// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock feishuClient
// ============================================================

const mockAddReaction = vi.fn();
const mockRemoveReaction = vi.fn().mockResolvedValue(true);
const mockReplyText = vi.fn();
const mockReplyTextInThread = vi.fn();

vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    addReaction: (...args: unknown[]) => mockAddReaction(...args),
    removeReaction: (...args: unknown[]) => mockRemoveReaction(...args),
    replyText: (...args: unknown[]) => mockReplyText(...args),
    replyTextInThread: (...args: unknown[]) => mockReplyTextInThread(...args),
    fetchRecentMessages: vi.fn().mockResolvedValue([]),
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
// Tests: Thread reaction logic
//
// Simulates the core reaction logic from executeDirectTask
// without needing to invoke the full function.
// ============================================================

/**
 * Simulates the thread reaction add/remove flow from executeDirectTask.
 */
async function simulateThreadReactionFlow(params: {
  messageId: string;
  eventThreadId?: string;
  shouldError?: boolean;
}) {
  const { feishuClient } = await import('../feishu/client.js');
  const { messageId, eventThreadId, shouldError } = params;

  // Same logic as executeDirectTask
  let pendingReactionId: string | undefined;
  if (eventThreadId) {
    pendingReactionId = await feishuClient.addReaction(messageId, 'OnIt').catch(() => undefined);
  }

  try {
    if (shouldError) {
      throw new Error('Simulated execution error');
    }

    // Simulate successful reply
    await feishuClient.replyTextInThread(messageId, 'response');
  } catch {
    // Error handling (reply error message)
  } finally {
    // Cleanup reaction (same as executeDirectTask finally block)
    if (pendingReactionId) {
      feishuClient.removeReaction(messageId, pendingReactionId).catch(() => {});
    }
  }

  return { pendingReactionId };
}

describe('thread reaction: immediate feedback for @bot in threads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds reaction when eventThreadId is present', async () => {
    mockAddReaction.mockResolvedValue('reaction-123');

    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: 'thread-1',
    });

    expect(mockAddReaction).toHaveBeenCalledWith('msg-1', 'OnIt');
    expect(mockAddReaction).toHaveBeenCalledTimes(1);
  });

  it('does NOT add reaction when not in thread (main chat)', async () => {
    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: undefined,
    });

    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it('removes reaction after successful reply', async () => {
    mockAddReaction.mockResolvedValue('reaction-456');

    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: 'thread-1',
    });

    expect(mockRemoveReaction).toHaveBeenCalledWith('msg-1', 'reaction-456');
  });

  it('removes reaction even on execution error (finally block)', async () => {
    mockAddReaction.mockResolvedValue('reaction-789');

    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: 'thread-1',
      shouldError: true,
    });

    // Reaction should still be cleaned up
    expect(mockRemoveReaction).toHaveBeenCalledWith('msg-1', 'reaction-789');
  });

  it('does not attempt removal when addReaction fails', async () => {
    mockAddReaction.mockResolvedValue(undefined);

    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: 'thread-1',
    });

    // pendingReactionId is undefined → no removal attempt
    expect(mockRemoveReaction).not.toHaveBeenCalled();
  });

  it('does not attempt removal when addReaction throws', async () => {
    mockAddReaction.mockRejectedValue(new Error('API error'));

    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: 'thread-1',
    });

    // .catch(() => undefined) swallows the error, pendingReactionId is undefined
    expect(mockRemoveReaction).not.toHaveBeenCalled();
  });

  it('removal failure does not throw (fire-and-forget)', async () => {
    mockAddReaction.mockResolvedValue('reaction-abc');
    mockRemoveReaction.mockRejectedValue(new Error('delete failed'));

    // Should not throw
    await expect(
      simulateThreadReactionFlow({
        messageId: 'msg-1',
        eventThreadId: 'thread-1',
      }),
    ).resolves.not.toThrow();
  });
});
