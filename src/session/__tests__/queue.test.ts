import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import { TaskQueue } from '../queue.js';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue();
  });

  describe('enqueue / dequeue', () => {
    it('should dequeue tasks in FIFO order', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1');
      queue.enqueue('chat1', 'chat1', 'user1', 'msg2', 'mid2');
      queue.enqueue('chat1', 'chat1', 'user1', 'msg3', 'mid3');

      const t1 = queue.dequeue('chat1');
      expect(t1).toBeDefined();
      expect(t1!.message).toBe('msg1');

      // While t1 is running, dequeue returns undefined
      expect(queue.dequeue('chat1')).toBeUndefined();

      // Complete t1, then dequeue t2
      queue.complete('chat1');
      const t2 = queue.dequeue('chat1');
      expect(t2!.message).toBe('msg2');

      queue.complete('chat1');
      const t3 = queue.dequeue('chat1');
      expect(t3!.message).toBe('msg3');
    });

    it('should return undefined when queue is empty', () => {
      expect(queue.dequeue('chat1')).toBeUndefined();
    });

    it('should isolate queues per queueKey', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg-a', 'mid1');
      queue.enqueue('chat2', 'chat2', 'user2', 'msg-b', 'mid2');

      const t1 = queue.dequeue('chat1');
      const t2 = queue.dequeue('chat2');
      expect(t1!.message).toBe('msg-a');
      expect(t2!.message).toBe('msg-b');
    });
  });

  describe('per-thread isolation', () => {
    it('should allow parallel execution across different threads', () => {
      // Thread A and Thread B in the same chat
      queue.enqueue('chat1:threadA', 'chat1', 'user1', 'msg-a', 'mid1', 'threadA');
      queue.enqueue('chat1:threadB', 'chat1', 'user1', 'msg-b', 'mid2', 'threadB');

      // Both can be dequeued simultaneously
      const tA = queue.dequeue('chat1:threadA');
      const tB = queue.dequeue('chat1:threadB');
      expect(tA!.message).toBe('msg-a');
      expect(tB!.message).toBe('msg-b');
    });

    it('should serialize within the same thread', () => {
      queue.enqueue('chat1:threadA', 'chat1', 'user1', 'msg1', 'mid1', 'threadA');
      queue.enqueue('chat1:threadA', 'chat1', 'user1', 'msg2', 'mid2', 'threadA');

      queue.dequeue('chat1:threadA'); // start msg1
      expect(queue.dequeue('chat1:threadA')).toBeUndefined(); // blocked
    });

    it('should not block main chat when thread is busy', () => {
      queue.enqueue('chat1:threadA', 'chat1', 'user1', 'msg-thread', 'mid1', 'threadA');
      queue.enqueue('chat1', 'chat1', 'user1', 'msg-main', 'mid2');

      queue.dequeue('chat1:threadA'); // start thread msg
      const mainTask = queue.dequeue('chat1'); // main chat should not be blocked
      expect(mainTask!.message).toBe('msg-main');
    });
  });

  describe('serial execution per queue', () => {
    it('should block dequeue while a task is running', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1');
      queue.enqueue('chat1', 'chat1', 'user1', 'msg2', 'mid2');

      queue.dequeue('chat1'); // start msg1
      expect(queue.dequeue('chat1')).toBeUndefined(); // blocked
    });
  });

  describe('isBusy', () => {
    it('should return false when no task is running', () => {
      expect(queue.isBusy('chat1')).toBe(false);
    });

    it('should return true when a task is running', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1');
      queue.dequeue('chat1');
      expect(queue.isBusy('chat1')).toBe(true);
    });

    it('should return false after task completes', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1');
      queue.dequeue('chat1');
      queue.complete('chat1');
      expect(queue.isBusy('chat1')).toBe(false);
    });
  });

  describe('pendingCount', () => {
    it('should return 0 for unknown queue', () => {
      expect(queue.pendingCount('chat1')).toBe(0);
    });

    it('should return count of queued tasks', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1');
      queue.enqueue('chat1', 'chat1', 'user1', 'msg2', 'mid2');
      expect(queue.pendingCount('chat1')).toBe(2);
    });

    it('should decrease after dequeue', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1');
      queue.enqueue('chat1', 'chat1', 'user1', 'msg2', 'mid2');
      queue.dequeue('chat1');
      expect(queue.pendingCount('chat1')).toBe(1);
    });
  });

  describe('pendingCountForChat', () => {
    it('should aggregate pending across all threads for a chat', () => {
      queue.enqueue('chat1:threadA', 'chat1', 'user1', 'msg1', 'mid1', 'threadA');
      queue.enqueue('chat1:threadB', 'chat1', 'user1', 'msg2', 'mid2', 'threadB');
      queue.enqueue('chat1', 'chat1', 'user1', 'msg3', 'mid3');

      expect(queue.pendingCountForChat('chat1')).toBe(3);
    });

    it('should not count tasks from other chats', () => {
      queue.enqueue('chat1:threadA', 'chat1', 'user1', 'msg1', 'mid1', 'threadA');
      queue.enqueue('chat2:threadB', 'chat2', 'user2', 'msg2', 'mid2', 'threadB');

      expect(queue.pendingCountForChat('chat1')).toBe(1);
    });
  });

  describe('cancelPending', () => {
    it('should cancel all pending tasks and reject their promises', async () => {
      const p1 = queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1');
      const p2 = queue.enqueue('chat1', 'chat1', 'user1', 'msg2', 'mid2');

      const cancelled = queue.cancelPending('chat1');
      expect(cancelled).toBe(2);
      expect(queue.pendingCount('chat1')).toBe(0);

      await expect(p1).rejects.toThrow('Task cancelled');
      await expect(p2).rejects.toThrow('Task cancelled');
    });

    it('should return 0 for unknown queue', () => {
      expect(queue.cancelPending('unknown')).toBe(0);
    });
  });

  describe('forceThread flag', () => {
    it('should preserve forceThread flag on dequeued task', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1', undefined, undefined, undefined, undefined, undefined, true);
      const task = queue.dequeue('chat1');
      expect(task).toBeDefined();
      expect(task!.forceThread).toBe(true);
    });

    it('should default forceThread to undefined when not set', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1');
      const task = queue.dequeue('chat1');
      expect(task).toBeDefined();
      expect(task!.forceThread).toBeUndefined();
    });
  });

  describe('markBusy', () => {
    it('should block dequeue on the marked key', () => {
      queue.markBusy('chat1:threadA');
      queue.enqueue('chat1:threadA', 'chat1', 'user1', 'msg1', 'mid1', 'threadA');

      // dequeue blocked because key is marked busy
      expect(queue.dequeue('chat1:threadA')).toBeUndefined();
      expect(queue.isBusy('chat1:threadA')).toBe(true);

      // complete releases the lock, then dequeue works
      queue.complete('chat1:threadA');
      const task = queue.dequeue('chat1:threadA');
      expect(task).toBeDefined();
      expect(task!.message).toBe('msg1');
    });

    it('should not overwrite an existing running task', () => {
      queue.enqueue('chat1', 'chat1', 'user1', 'msg1', 'mid1');
      const task = queue.dequeue('chat1');
      expect(task).toBeDefined();

      // markBusy on already-running key should be a no-op
      queue.markBusy('chat1');
      queue.complete('chat1');
      expect(queue.isBusy('chat1')).toBe(false);
    });

    it('should not affect other queue keys', () => {
      queue.markBusy('chat1:threadA');
      queue.enqueue('chat1:threadB', 'chat1', 'user1', 'msg1', 'mid1', 'threadB');

      // threadB is not blocked
      const task = queue.dequeue('chat1:threadB');
      expect(task).toBeDefined();
      expect(task!.message).toBe('msg1');
    });
  });

  describe('cancelAllForChat', () => {
    it('should cancel pending tasks across all threads for a chat', async () => {
      const p1 = queue.enqueue('chat1:threadA', 'chat1', 'user1', 'msg1', 'mid1', 'threadA');
      const p2 = queue.enqueue('chat1:threadB', 'chat1', 'user1', 'msg2', 'mid2', 'threadB');
      const p3 = queue.enqueue('chat1', 'chat1', 'user1', 'msg3', 'mid3');

      const cancelled = queue.cancelAllForChat('chat1');
      expect(cancelled).toBe(3);

      await expect(p1).rejects.toThrow('Task cancelled');
      await expect(p2).rejects.toThrow('Task cancelled');
      await expect(p3).rejects.toThrow('Task cancelled');
    });

    it('should not cancel tasks from other chats', () => {
      queue.enqueue('chat1:threadA', 'chat1', 'user1', 'msg1', 'mid1', 'threadA').catch(() => {});
      queue.enqueue('chat2:threadB', 'chat2', 'user2', 'msg2', 'mid2', 'threadB').catch(() => {});

      queue.cancelAllForChat('chat1');
      expect(queue.pendingCount('chat2:threadB')).toBe(1);
    });
  });

  describe('accountId', () => {
    it('should store accountId on enqueued task', () => {
      queue.enqueue('q1', 'chat1', 'user1', 'msg', 'mid1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'pm');
      const task = queue.dequeue('q1');
      expect(task).toBeDefined();
      expect(task!.accountId).toBe('pm');
    });

    it('should default accountId to undefined when not provided', () => {
      queue.enqueue('q1', 'chat1', 'user1', 'msg', 'mid1');
      const task = queue.dequeue('q1');
      expect(task).toBeDefined();
      expect(task!.accountId).toBeUndefined();
    });

    it('should preserve different accountIds for sequential tasks in same queue', () => {
      queue.enqueue('q1', 'chat1', 'user1', 'msg1', 'mid1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'dev');
      queue.enqueue('q1', 'chat1', 'user1', 'msg2', 'mid2', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'pm');

      const t1 = queue.dequeue('q1');
      expect(t1!.accountId).toBe('dev');

      queue.complete('q1');
      const t2 = queue.dequeue('q1');
      expect(t2!.accountId).toBe('pm');
    });
  });
});
