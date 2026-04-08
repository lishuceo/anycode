/**
 * Emoji Reaction Tests
 *
 * Tests for the emoji reaction feedback feature:
 * - Thread messages: always add reaction as immediate feedback
 * - Main chat with quick-ack disabled: fallback to emoji reaction
 * - Main chat with quick-ack enabled: no emoji reaction (quick-ack handles feedback)
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
 * Simulates the emoji reaction add/remove flow from executeDirectTask.
 * Mirrors the logic: useEmojiFallback = !!threadId || (!quickAckEnabled && !skipQuickAck)
 */
async function simulateThreadReactionFlow(params: {
  messageId: string;
  eventThreadId?: string;
  quickAckEnabled?: boolean;
  skipQuickAck?: boolean;
  shouldError?: boolean;
}) {
  const { feishuClient } = await import('../feishu/client.js');
  const { messageId, eventThreadId, quickAckEnabled = true, skipQuickAck = false, shouldError } = params;

  // Same logic as executeDirectTask
  let pendingReactionId: string | undefined;
  const useEmojiFallback = !!eventThreadId || (!quickAckEnabled && !skipQuickAck);
  if (useEmojiFallback) {
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

  it('does NOT add reaction in main chat when quick-ack is enabled', async () => {
    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: undefined,
      quickAckEnabled: true,
    });

    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it('adds fallback reaction in main chat when quick-ack is disabled', async () => {
    mockAddReaction.mockResolvedValue('reaction-fallback');

    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: undefined,
      quickAckEnabled: false,
    });

    expect(mockAddReaction).toHaveBeenCalledWith('msg-1', 'OnIt');
    expect(mockAddReaction).toHaveBeenCalledTimes(1);
  });

  it('does NOT add fallback reaction when skipQuickAck is true (even if quick-ack disabled)', async () => {
    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: undefined,
      quickAckEnabled: false,
      skipQuickAck: true,
    });

    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it('removes fallback reaction after reply in main chat', async () => {
    mockAddReaction.mockResolvedValue('reaction-fallback-2');

    await simulateThreadReactionFlow({
      messageId: 'msg-1',
      eventThreadId: undefined,
      quickAckEnabled: false,
    });

    expect(mockRemoveReaction).toHaveBeenCalledWith('msg-1', 'reaction-fallback-2');
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
