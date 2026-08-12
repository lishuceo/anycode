import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { CronStore } from '../store.js';
import { CronScheduler } from '../scheduler.js';
import type { CronTaskExecutor, CronMessageSender } from '../scheduler.js';

describe('CronScheduler', () => {
  let store: CronStore;
  let scheduler: CronScheduler;
  let tempDir: string;
  let executeTask: CronTaskExecutor;
  let sendMessage: CronMessageSender;
  let executedPrompts: string[];
  let sentMessages: Array<{ chatId: string; text: string; rootId?: string }>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cron-scheduler-test-'));
    store = new CronStore(join(tempDir, 'test-cron.db'));

    executedPrompts = [];
    sentMessages = [];

    executeTask = vi.fn(async (params) => {
      executedPrompts.push(params.prompt);
    }) as unknown as CronTaskExecutor;

    sendMessage = vi.fn(async (chatId, text, rootId) => {
      sentMessages.push({ chatId, text, rootId });
      return 'mock-msg-id';
    }) as unknown as CronMessageSender;

    scheduler = new CronScheduler({
      store,
      executeTask,
      sendMessage,
    });
  });

  afterEach(() => {
    scheduler.stop();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Public API ──

  it('should add a job via scheduler', async () => {
    const job = await scheduler.addJob({
      name: 'test',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'hello',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe('test');
  });

  it('should list jobs filtered by chatId', async () => {
    await scheduler.addJob({
      name: 'job1',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'a',
      schedule: { kind: 'every', everyMs: 60_000 },
    });
    await scheduler.addJob({
      name: 'job2',
      chatId: 'chat2',
      userId: 'user1',
      prompt: 'b',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    const chat1Jobs = scheduler.listJobs({ chatId: 'chat1' });
    expect(chat1Jobs.length).toBe(1);
    expect(chat1Jobs[0].name).toBe('job1');
  });

  it('should update a job', async () => {
    const job = await scheduler.addJob({
      name: 'original',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'old',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    const updated = await scheduler.updateJob(job.id, { name: 'updated' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('updated');
  });

  it('should remove a job', async () => {
    const job = await scheduler.addJob({
      name: 'to-remove',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'delete',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    const removed = await scheduler.removeJob(job.id);
    expect(removed).toBe(true);
    expect(scheduler.listJobs().length).toBe(0);
  });

  // ── Trigger ──

  it('should trigger a job immediately', async () => {
    const job = await scheduler.addJob({
      name: 'trigger-test',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'run now',
      schedule: { kind: 'every', everyMs: 3600_000 },
    });

    await scheduler.triggerJob(job.id);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sentMessages[0].chatId).toBe('chat1');
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(executedPrompts[0]).toContain('run now');
  });

  it('should throw when triggering non-existent job', async () => {
    await expect(scheduler.triggerJob('non-existent')).rejects.toThrow('Job not found');
  });

  it('should include context snapshot in prompt when triggering', async () => {
    const job = await scheduler.addJob({
      name: 'ctx-test',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'check PR',
      schedule: { kind: 'every', everyMs: 3600_000 },
      contextSnapshot: 'repo: taptap/maker, PR: #42',
    });

    await scheduler.triggerJob(job.id);

    expect(executedPrompts[0]).toContain('repo: taptap/maker, PR: #42');
    expect(executedPrompts[0]).toContain('check PR');
  });

  it('should send message in thread when threadRootMessageId is set', async () => {
    const job = await scheduler.addJob({
      name: 'thread-test',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'thread run',
      schedule: { kind: 'every', everyMs: 3600_000 },
      threadRootMessageId: 'root-msg-123',
    });

    await scheduler.triggerJob(job.id);

    expect(sentMessages[0].rootId).toBe('root-msg-123');
  });

  // ── Error handling ──

  it('should handle execution failure gracefully', async () => {
    const failingExecutor = vi.fn(async () => {
      throw new Error('execution failed');
    }) as unknown as CronTaskExecutor;

    const failScheduler = new CronScheduler({
      store,
      executeTask: failingExecutor,
      sendMessage,
    });

    const job = await failScheduler.addJob({
      name: 'fail-test',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'will fail',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    await failScheduler.triggerJob(job.id);

    const updated = store.get(job.id);
    expect(updated!.state.lastStatus).toBe('error');
    expect(updated!.state.consecutiveErrors).toBe(1);
    expect(updated!.state.lastError).toBe('execution failed');

    failScheduler.stop();
  });

  it('should handle sendMessage failure', async () => {
    const failingSender = vi.fn(async () => {
      return undefined; // Failed to get messageId
    }) as unknown as CronMessageSender;

    const failScheduler = new CronScheduler({
      store,
      executeTask,
      sendMessage: failingSender,
    });

    const job = await failScheduler.addJob({
      name: 'msg-fail',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'will fail',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    await failScheduler.triggerJob(job.id);

    const updated = store.get(job.id);
    expect(updated!.state.lastStatus).toBe('error');
    expect(updated!.state.lastError).toContain('placeholder message');
    expect(executeTask).not.toHaveBeenCalled();

    failScheduler.stop();
  });

  // ── Startup ──

  it('should start without errors when no jobs exist', async () => {
    await expect(scheduler.start()).resolves.not.toThrow();
  });

  it('should run missed jobs on startup', async () => {
    // Add a job with nextRunAtMs in the past (simulating missed during downtime)
    const job = store.add({
      name: 'missed',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'missed job',
      schedule: { kind: 'every', everyMs: 60_000 },
    });
    store.updateJobState(job.id, { nextRunAtMs: Date.now() - 5000 });

    await scheduler.start();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  // ── One-shot jobs ──

  it('should delete one-shot job after successful execution', async () => {
    const futureTime = new Date(Date.now() + 3600_000).toISOString();
    const job = await scheduler.addJob({
      name: 'one-shot',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'run once',
      schedule: { kind: 'at', atTime: futureTime },
    });

    expect(job.deleteAfterRun).toBe(true);

    await scheduler.triggerJob(job.id);

    // Job should be deleted after successful run
    expect(store.get(job.id)).toBeUndefined();
  });

  // ── Holiday / weekend skip ──

  /** UTC ms for Shanghai-local date (UTC+8). */
  function shanghaiMs(dateStr: string, hour = 10): number {
    return new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`).getTime() - 8 * 3600 * 1000;
  }

  it('skips execution on legal holiday when skipHolidays=true', async () => {
    const job = await scheduler.addJob({
      name: 'daily-report',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'send daily',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      skipHolidays: true,
    });

    vi.useFakeTimers();
    vi.setSystemTime(shanghaiMs('2026-10-01')); // 国庆节

    try {
      await scheduler.triggerJob(job.id);
    } finally {
      vi.useRealTimers();
    }

    expect(executeTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const updated = store.get(job.id);
    expect(updated!.state.consecutiveErrors).toBe(0);
    expect(updated!.state.lastStatus).toBeUndefined();
    expect(updated!.state.nextRunAtMs).toBeDefined();
  });

  it('still executes on 调休补班 weekend when skipHolidays=true only', async () => {
    const job = await scheduler.addJob({
      name: 'workday-task',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'work',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      skipHolidays: true,
    });

    vi.useFakeTimers();
    vi.setSystemTime(shanghaiMs('2026-02-28')); // Saturday 调休补班

    try {
      await scheduler.triggerJob(job.id);
    } finally {
      vi.useRealTimers();
    }

    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it('skips execution on ordinary weekend when skipWeekends=true', async () => {
    const job = await scheduler.addJob({
      name: 'weekday-task',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'work',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      skipWeekends: true,
    });

    vi.useFakeTimers();
    vi.setSystemTime(shanghaiMs('2026-03-08')); // Sunday

    try {
      await scheduler.triggerJob(job.id);
    } finally {
      vi.useRealTimers();
    }

    expect(executeTask).not.toHaveBeenCalled();
  });

  it('executes on ordinary workday when both skip flags are true', async () => {
    const job = await scheduler.addJob({
      name: 'task',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'work',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      skipHolidays: true,
      skipWeekends: true,
    });

    vi.useFakeTimers();
    vi.setSystemTime(shanghaiMs('2026-03-10')); // Tuesday, ordinary day

    try {
      await scheduler.triggerJob(job.id);
    } finally {
      vi.useRealTimers();
    }

    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it('drops one-shot `at` job that hits a holiday (no spin loop)', async () => {
    // 注：addJob 内的 computeNextRunAtMs 用真实时间计算，所以 atTime 设为未来
    // 然后用 fake timer 把"当前时间"拨到节假日触发 skip 路径
    const job = await scheduler.addJob({
      name: 'one-shot-holiday',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'once',
      schedule: { kind: 'at', atTime: '2099-01-01T09:00:00+08:00' },
      skipHolidays: true,
    });
    expect(job.deleteAfterRun).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(shanghaiMs('2026-10-01')); // 国庆 + atTime 早已"过去"（相对 setSystemTime 也未必，但 computeNextRunAtMs 在 skip 后会以 2026 年视角重算）

    try {
      // 把 atTime 改为过去，模拟 atTime 已到（直接改 DB 而非用 patch，避免 update 重算 nextRunAtMs）
      store.update(job.id, { schedule: { kind: 'at', atTime: '2026-09-01T09:00:00+08:00' } });
      await scheduler.triggerJob(job.id);
    } finally {
      vi.useRealTimers();
    }

    expect(executeTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    // 关键：job 已被删除，下次 tick 不会再被命中
    expect(store.get(job.id)).toBeUndefined();
  });

  it('does not skip when both flags are false (default)', async () => {
    const job = await scheduler.addJob({
      name: 'always-run',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'work',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    });

    vi.useFakeTimers();
    vi.setSystemTime(shanghaiMs('2026-10-01')); // 国庆节 — but no skip flags

    try {
      await scheduler.triggerJob(job.id);
    } finally {
      vi.useRealTimers();
    }

    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  // ── 执行结果记账与静默失败 ──
  //
  // 回归背景：executeTask 原先返回 void，scheduler 只能靠「有没有抛异常」判断成败。
  // SDK 因会话累计花费超 maxBudgetUsd 而拒绝执行时并不抛异常（实测 numTurns=1、
  // 零 token、18 秒返回，一个 turn 都没跑），于是 run 被记成 ok 且 cost_usd 为空——
  // 定时任务连续多天空跑，而记录显示一切正常。

  it('records cost_usd on a successful run', async () => {
    executeTask = vi.fn(async () => ({ success: true, costUsd: 1.2345, numTurns: 12 })) as unknown as CronTaskExecutor;
    scheduler = new CronScheduler({ store, executeTask, sendMessage });

    const job = await scheduler.addJob({
      name: 'billed',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'work',
      schedule: { kind: 'every', everyMs: 60_000 },
    });
    await scheduler.triggerJob(job.id);

    const [run] = store.getRecentRuns(job.id, 1);
    expect(run!.status).toBe('ok');
    expect(run!.costUsd).toBeCloseTo(1.2345, 4);
    expect(store.get(job.id)!.state.lastStatus).toBe('ok');
  });

  it('treats a failed outcome as an error and still records its cost', async () => {
    // 复现 08-02 那次：SDK 拒绝执行，不抛异常，但已经花掉 $18.61
    executeTask = vi.fn(async () => ({
      success: false,
      costUsd: 18.606643,
      error: 'Query ended with: error_max_budget_usd',
      numTurns: 1,
    })) as unknown as CronTaskExecutor;
    scheduler = new CronScheduler({ store, executeTask, sendMessage });

    const job = await scheduler.addJob({
      name: 'over-budget',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'work',
      schedule: { kind: 'every', everyMs: 60_000 },
    });
    await scheduler.triggerJob(job.id);

    const [run] = store.getRecentRuns(job.id, 1);
    expect(run!.status).toBe('error');                        // 不再静默记 ok
    expect(run!.costUsd).toBeCloseTo(18.606643, 4);           // 钱要记上
    expect(run!.error).toContain('error_max_budget_usd');

    const state = store.get(job.id)!.state;
    expect(state.lastStatus).toBe('error');
    expect(state.consecutiveErrors).toBe(1);                  // 触发退避
    // 零轮执行要给出可诊断的提示，而不是只丢一个 subtype
    expect(state.lastError).toContain('maxBudgetUsd');
  });

  it('keeps legacy behaviour when the executor returns nothing', async () => {
    // 老实现（返回 void）不应被判为失败
    executeTask = vi.fn(async () => undefined) as unknown as CronTaskExecutor;
    scheduler = new CronScheduler({ store, executeTask, sendMessage });

    const job = await scheduler.addJob({
      name: 'void-executor',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'work',
      schedule: { kind: 'every', everyMs: 60_000 },
    });
    await scheduler.triggerJob(job.id);

    const [run] = store.getRecentRuns(job.id, 1);
    expect(run!.status).toBe('ok');
    expect(run!.costUsd).toBeUndefined();
  });
});
