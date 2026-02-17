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
      queue.enqueue('chat1', 'user1', 'msg1', 'mid1');
      queue.enqueue('chat1', 'user1', 'msg2', 'mid2');
      queue.enqueue('chat1', 'user1', 'msg3', 'mid3');

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

    it('should isolate queues per chatId', () => {
      queue.enqueue('chat1', 'user1', 'msg-a', 'mid1');
      queue.enqueue('chat2', 'user2', 'msg-b', 'mid2');

      const t1 = queue.dequeue('chat1');
      const t2 = queue.dequeue('chat2');
      expect(t1!.message).toBe('msg-a');
      expect(t2!.message).toBe('msg-b');
    });
  });

  describe('serial execution per chat', () => {
    it('should block dequeue while a task is running', () => {
      queue.enqueue('chat1', 'user1', 'msg1', 'mid1');
      queue.enqueue('chat1', 'user1', 'msg2', 'mid2');

      queue.dequeue('chat1'); // start msg1
      expect(queue.dequeue('chat1')).toBeUndefined(); // blocked
    });
  });

  describe('isBusy', () => {
    it('should return false when no task is running', () => {
      expect(queue.isBusy('chat1')).toBe(false);
    });

    it('should return true when a task is running', () => {
      queue.enqueue('chat1', 'user1', 'msg1', 'mid1');
      queue.dequeue('chat1');
      expect(queue.isBusy('chat1')).toBe(true);
    });

    it('should return false after task completes', () => {
      queue.enqueue('chat1', 'user1', 'msg1', 'mid1');
      queue.dequeue('chat1');
      queue.complete('chat1');
      expect(queue.isBusy('chat1')).toBe(false);
    });
  });

  describe('pendingCount', () => {
    it('should return 0 for unknown chat', () => {
      expect(queue.pendingCount('chat1')).toBe(0);
    });

    it('should return count of queued tasks', () => {
      queue.enqueue('chat1', 'user1', 'msg1', 'mid1');
      queue.enqueue('chat1', 'user1', 'msg2', 'mid2');
      expect(queue.pendingCount('chat1')).toBe(2);
    });

    it('should decrease after dequeue', () => {
      queue.enqueue('chat1', 'user1', 'msg1', 'mid1');
      queue.enqueue('chat1', 'user1', 'msg2', 'mid2');
      queue.dequeue('chat1');
      expect(queue.pendingCount('chat1')).toBe(1);
    });
  });

  describe('cancelPending', () => {
    it('should cancel all pending tasks and reject their promises', async () => {
      const p1 = queue.enqueue('chat1', 'user1', 'msg1', 'mid1');
      const p2 = queue.enqueue('chat1', 'user1', 'msg2', 'mid2');

      const cancelled = queue.cancelPending('chat1');
      expect(cancelled).toBe(2);
      expect(queue.pendingCount('chat1')).toBe(0);

      await expect(p1).rejects.toThrow('Task cancelled');
      await expect(p2).rejects.toThrow('Task cancelled');
    });

    it('should return 0 for unknown chat', () => {
      expect(queue.cancelPending('unknown')).toBe(0);
    });
  });
});
