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
});
