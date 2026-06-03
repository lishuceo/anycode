/**
 * 测试 task queue 的 AsyncLocalStorage 上下文隔离。
 *
 * 复现 bug：dev bot 任务先执行，pm bot 任务排队；
 * dev 任务 .finally() 触发 pm 任务出队，此时上下文应为 pm 而非 dev。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TaskQueue } from '../session/queue.js';

describe('Queue accountId context isolation', () => {
  const als = new AsyncLocalStorage<string>();
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue();
  });

  it('QueueTask preserves accountId through enqueue/dequeue', () => {
    queue.enqueue('q1', 'chat', 'u1', 'dev-msg', 'mid1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'dev');
    queue.enqueue('q1', 'chat', 'u1', 'pm-msg', 'mid2', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'pm');

    const t1 = queue.dequeue('q1');
    expect(t1!.message).toBe('dev-msg');
    expect(t1!.accountId).toBe('dev');

    queue.complete('q1');

    const t2 = queue.dequeue('q1');
    expect(t2!.message).toBe('pm-msg');
    expect(t2!.accountId).toBe('pm');
  });

  it('accountId defaults to undefined when not provided', () => {
    queue.enqueue('q1', 'chat', 'u1', 'msg', 'mid1');
    const t = queue.dequeue('q1');
    expect(t!.accountId).toBeUndefined();
  });

  it('BUG: .finally() inherits outer AsyncLocalStorage context', async () => {
    const contexts: (string | undefined)[] = [];

    await new Promise<void>((resolve) => {
      als.run('dev', () => {
        Promise.resolve().finally(() => {
          // .finally() 继承了 'dev' 上下文 — 这就是 bug 的根因
          contexts.push(als.getStore());
          resolve();
        });
      });
    });

    expect(contexts[0]).toBe('dev');
  });

  it('FIX: als.run() in .finally() overrides inherited context', async () => {
    const contexts: (string | undefined)[] = [];

    await new Promise<void>((resolve) => {
      als.run('dev', () => {
        Promise.resolve().finally(() => {
          // 不加 als.run：拿到 'dev'（bug）
          contexts.push(als.getStore());

          // 加 als.run：覆盖为 'pm'（fix）
          als.run('pm', () => {
            contexts.push(als.getStore());
          });

          resolve();
        });
      });
    });

    expect(contexts[0]).toBe('dev');   // 未修复时继承的上下文
    expect(contexts[1]).toBe('pm');    // 修复后正确的上下文
  });

  it('FIX: simulates processQueue chaining with correct context per task', async () => {
    // 模拟真实场景：两个不同 bot 的任务在同一队列中依次执行
    queue.enqueue('q1', 'chat', 'u1', 'dev-task', 'mid1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'dev');
    queue.enqueue('q1', 'chat', 'u1', 'pm-task', 'mid2', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'pm');

    const executionContexts: { message: string; accountId: string | undefined }[] = [];

    // 模拟 processQueue 的修复逻辑
    function processQueueFixed() {
      const task = queue.dequeue('q1');
      if (!task) return Promise.resolve();

      const taskAccountId = task.accountId ?? 'default';

      return new Promise<void>((resolve) => {
        als.run(taskAccountId, () => {
          // 任务执行时记录当前上下文
          executionContexts.push({
            message: task.message,
            accountId: als.getStore(),
          });

          // 模拟异步执行完成
          Promise.resolve()
            .then(() => task.resolve('done'))
            .finally(() => {
              queue.complete('q1');
              // 链式处理下一个任务（关键：在 .finally 中）
              processQueueFixed().then(resolve);
            });
        });
      });
    }

    // 在 dev 上下文中启动第一个任务（模拟 handleMessageEvent）
    await als.run('dev', () => processQueueFixed());

    // 验证：dev 任务用 dev 上下文，pm 任务用 pm 上下文
    expect(executionContexts).toEqual([
      { message: 'dev-task', accountId: 'dev' },
      { message: 'pm-task', accountId: 'pm' },
    ]);
  });

  it('WITHOUT FIX: pm task would inherit dev context', async () => {
    // 演示 bug：不用 als.run 包裹时，pm 任务继承 dev 上下文
    queue.enqueue('q1', 'chat', 'u1', 'dev-task', 'mid1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'dev');
    queue.enqueue('q1', 'chat', 'u1', 'pm-task', 'mid2', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'pm');

    const executionContexts: { message: string; accountId: string | undefined }[] = [];

    function processQueueBuggy() {
      const task = queue.dequeue('q1');
      if (!task) return Promise.resolve();

      // BUG: 不用 als.run 包裹，直接执行
      return new Promise<void>((resolve) => {
        executionContexts.push({
          message: task.message,
          accountId: als.getStore(), // 继承外层上下文
        });

        Promise.resolve()
          .then(() => task.resolve('done'))
          .finally(() => {
            queue.complete('q1');
            processQueueBuggy().then(resolve);
          });
      });
    }

    await als.run('dev', () => processQueueBuggy());

    // BUG: pm 任务也看到 'dev' 上下文
    expect(executionContexts).toEqual([
      { message: 'dev-task', accountId: 'dev' },
      { message: 'pm-task', accountId: 'dev' },  // ← 这就是 bug！应该是 'pm'
    ]);
  });
});
