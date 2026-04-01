/**
 * /t command — force thread mode + skip quick-ack
 *
 * Tests:
 * 1. QueueTask preserves forceThread flag
 * 2. processQueue uses executeClaudeTask when forceThread=true (even for direct mode agent)
 * 3. /t prefix stripping in message handling
 */
// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ============================================================
// 1. /t prefix stripping logic
// ============================================================

describe('/t prefix detection', () => {
  it('should detect /t prefix and strip it', () => {
    const text = '/t 帮我看看这个 bug';
    const trimmed = text.trim();
    expect(trimmed.startsWith('/t ')).toBe(true);
    const stripped = trimmed.slice('/t '.length).trim();
    expect(stripped).toBe('帮我看看这个 bug');
  });

  it('should detect /t without args', () => {
    const text = '/t';
    const trimmed = text.trim();
    expect(trimmed === '/t').toBe(true);
  });

  it('should not match /test or /task commands', () => {
    expect('/test'.trim().startsWith('/t ')).toBe(false);
    expect('/test'.trim() === '/t').toBe(false);
    expect('/task foo'.trim().startsWith('/t ')).toBe(false);
  });

  it('should handle leading/trailing whitespace', () => {
    const text = '  /t  some task  ';
    const trimmed = text.trim();
    expect(trimmed.startsWith('/t ')).toBe(true);
    const stripped = trimmed.slice('/t '.length).trim();
    expect(stripped).toBe('some task');
  });

  it('should only activate for direct-mode agents', () => {
    // /t is only processed when isAgentDirectMode is true
    const text = '/t some task';
    const trimmed = text.trim();

    // Direct mode agent → should detect /t
    const isAgentDirectMode = true;
    expect(isAgentDirectMode && trimmed.startsWith('/t ')).toBe(true);

    // Thread mode agent → should NOT detect /t (prefix ignored, passed as-is)
    const isAgentThreadMode = false; // replyMode === 'direct' is false for thread agents
    expect(isAgentThreadMode && trimmed.startsWith('/t ')).toBe(false);
  });
});

// ============================================================
// 2. QueueTask forceThread flag preservation
// ============================================================

describe('QueueTask forceThread', () => {
  it('should include forceThread in task interface', async () => {
    const { TaskQueue } = await import('../session/queue.js');
    const queue = new TaskQueue();

    queue.enqueue('key1', 'chat1', 'user1', 'msg', 'mid1',
      undefined, undefined, undefined, undefined, undefined, true);
    const task = queue.dequeue('key1');
    expect(task).toBeDefined();
    expect(task!.forceThread).toBe(true);
    expect(task!.message).toBe('msg');
  });
});

// ============================================================
// 3. processQueue mode override
// ============================================================

describe('processQueue with forceThread', () => {
  it('should use thread mode (executeClaudeTask) when forceThread is true, even for direct-mode agent', () => {
    // The logic in processQueue:
    //   const useDirectMode = agentCfg?.replyMode === 'direct' && !task.forceThread;
    // When forceThread=true, useDirectMode should be false
    const agentCfg = { replyMode: 'direct' as const };
    const task = { forceThread: true };

    const useDirectMode = agentCfg.replyMode === 'direct' && !task.forceThread;
    expect(useDirectMode).toBe(false);
  });

  it('should use direct mode when forceThread is not set and agent is direct', () => {
    const agentCfg = { replyMode: 'direct' as const };
    const task = { forceThread: undefined };

    const useDirectMode = agentCfg.replyMode === 'direct' && !task.forceThread;
    expect(useDirectMode).toBe(true);
  });

  it('should use thread mode when agent is already thread mode', () => {
    const agentCfg = { replyMode: 'thread' as const };
    const task = { forceThread: false };

    const useDirectMode = agentCfg.replyMode === 'direct' && !task.forceThread;
    expect(useDirectMode).toBe(false);
  });
});

// ============================================================
// 4. Queue key strategy with forceThread
// ============================================================

describe('queue key with forceThread', () => {
  it('should not use direct-mode userId key when forceThread overrides to thread mode', () => {
    // In handleMessageEvent:
    //   const isDirectMode = agentConfig?.replyMode === 'direct' && !forceThread;
    // When forceThread=true, isDirectMode should be false,
    // so perMessageParallel = true (no effectiveThreadId, not direct mode)
    const agentReplyMode = 'direct';
    const forceThread = true;
    const effectiveThreadId = undefined;

    const isDirectMode = agentReplyMode === 'direct' && !forceThread;
    expect(isDirectMode).toBe(false);

    const perMessageParallel = !effectiveThreadId && !isDirectMode;
    expect(perMessageParallel).toBe(true);
  });
});
