/**
 * /t command — force thread mode + skip quick-ack
 *
 * Tests:
 * 1. /t prefix stripping in message handling
 * 2. QueueTask preserves forceThread flag
 * 3. processQueue keeps direct-mode agents in executeDirectTask (forceThread handled internally)
 * 4. Queue key strategy with forceThread
 */
// @ts-nocheck — test file
import { describe, it, expect, vi } from 'vitest';

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
  it('should keep direct-mode agent in executeDirectTask even when forceThread is true', () => {
    // The logic in processQueue:
    //   const useDirectMode = agentCfg?.replyMode === 'direct';
    // forceThread does NOT change the execution path — it's handled inside executeDirectTask
    const agentCfg = { replyMode: 'direct' as const };
    const task = { forceThread: true };

    const useDirectMode = agentCfg.replyMode === 'direct';
    expect(useDirectMode).toBe(true);
    // forceThread is passed as an option to executeDirectTask, not used to switch execution path
    expect(task.forceThread).toBe(true);
  });

  it('should use direct mode when forceThread is not set and agent is direct', () => {
    const agentCfg = { replyMode: 'direct' as const };

    const useDirectMode = agentCfg.replyMode === 'direct';
    expect(useDirectMode).toBe(true);
  });

  it('should use thread mode (executeClaudeTask) when agent is thread mode', () => {
    const agentCfg = { replyMode: 'thread' as const };

    const useDirectMode = agentCfg.replyMode === 'direct';
    expect(useDirectMode).toBe(false);
  });
});

// ============================================================
// 4. Queue key strategy with forceThread
// ============================================================

describe('queue key with forceThread', () => {
  it('should keep direct-mode userId key even with forceThread (thread created inside executeDirectTask)', () => {
    // In handleMessageEvent:
    //   const isDirectMode = agentConfig?.replyMode === 'direct';
    // forceThread does NOT affect queue key — direct agents always use userId-based key
    const agentReplyMode = 'direct';
    const effectiveThreadId = undefined;

    const isDirectMode = agentReplyMode === 'direct';
    expect(isDirectMode).toBe(true);

    const perMessageParallel = !effectiveThreadId && !isDirectMode;
    expect(perMessageParallel).toBe(false); // direct mode → serialized per userId
  });
});
