import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { CronStore, computeNextRunAtMs } from '../store.js';
import type { CronSchedule } from '../types.js';

describe('CronStore', () => {
  let store: CronStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cron-store-test-'));
    store = new CronStore(join(tempDir, 'test-cron.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── CRUD ──

  it('should add a cron job and retrieve it', () => {
    const job = store.add({
      name: 'test-job',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'do something',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe('test-job');
    expect(job.chatId).toBe('chat1');
    expect(job.userId).toBe('user1');
    expect(job.prompt).toBe('do something');
    expect(job.schedule.kind).toBe('every');
    expect(job.schedule.everyMs).toBe(60_000);
    expect(job.enabled).toBe(true);
    expect(job.agentId).toBe('dev');
    expect(job.state.consecutiveErrors).toBe(0);

    const retrieved = store.get(job.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(job.id);
  });

  it('should add a cron expression job', () => {
    const job = store.add({
      name: 'daily-9am',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'check status',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    });

    expect(job.schedule.kind).toBe('cron');
    expect(job.schedule.expr).toBe('0 9 * * *');
    expect(job.schedule.tz).toBe('Asia/Shanghai');
    expect(job.state.nextRunAtMs).toBeDefined();
  });

  it('should add a one-shot (at) job with deleteAfterRun', () => {
    const futureTime = new Date(Date.now() + 3600_000).toISOString();
    const job = store.add({
      name: 'one-shot',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'do once',
      schedule: { kind: 'at', atTime: futureTime },
    });

    expect(job.schedule.kind).toBe('at');
    expect(job.deleteAfterRun).toBe(true); // auto-set for 'at' kind
    expect(job.state.nextRunAtMs).toBeDefined();
  });

  it('should update a job', () => {
    const job = store.add({
      name: 'original',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'old prompt',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    const updated = store.update(job.id, {
      name: 'updated-name',
      prompt: 'new prompt',
    });

    expect(updated).toBeDefined();
    expect(updated!.name).toBe('updated-name');
    expect(updated!.prompt).toBe('new prompt');
  });

  it('should return undefined when updating non-existent job', () => {
    const result = store.update('non-existent', { name: 'foo' });
    expect(result).toBeUndefined();
  });

  it('should remove a job', () => {
    const job = store.add({
      name: 'to-delete',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'delete me',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    const removed = store.remove(job.id);
    expect(removed).toBe(true);
    expect(store.get(job.id)).toBeUndefined();
  });

  it('should return false when removing non-existent job', () => {
    expect(store.remove('non-existent')).toBe(false);
  });

  // ── List / filter ──

  it('should list all jobs', () => {
    store.add({ name: 'job1', chatId: 'chat1', userId: 'user1', prompt: 'a', schedule: { kind: 'every', everyMs: 1000 } });
    store.add({ name: 'job2', chatId: 'chat2', userId: 'user2', prompt: 'b', schedule: { kind: 'every', everyMs: 1000 } });

    const all = store.list();
    expect(all.length).toBe(2);
  });

  it('should list jobs filtered by chatId', () => {
    store.add({ name: 'job1', chatId: 'chat1', userId: 'user1', prompt: 'a', schedule: { kind: 'every', everyMs: 1000 } });
    store.add({ name: 'job2', chatId: 'chat2', userId: 'user2', prompt: 'b', schedule: { kind: 'every', everyMs: 1000 } });

    const chat1Jobs = store.list({ chatId: 'chat1' });
    expect(chat1Jobs.length).toBe(1);
    expect(chat1Jobs[0].chatId).toBe('chat1');
  });

  it('should list only enabled jobs', () => {
    store.add({ name: 'enabled', chatId: 'chat1', userId: 'user1', prompt: 'a', schedule: { kind: 'every', everyMs: 1000 } });
    store.add({ name: 'disabled', chatId: 'chat1', userId: 'user1', prompt: 'b', schedule: { kind: 'every', everyMs: 1000 }, enabled: false });

    const enabled = store.listEnabled();
    expect(enabled.length).toBe(1);
    expect(enabled[0].name).toBe('enabled');
  });

  // ── Scheduling ──

  it('should get due jobs', () => {
    const job = store.add({
      name: 'due-job',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'run me',
      schedule: { kind: 'every', everyMs: 1000 },
    });

    // The job should have nextRunAtMs = now + 1000
    // Simulate time passing
    store.updateJobState(job.id, { nextRunAtMs: Date.now() - 1000 });

    const due = store.getDueJobs(Date.now());
    expect(due.length).toBe(1);
    expect(due[0].id).toBe(job.id);
  });

  it('should not return future jobs as due', () => {
    store.add({
      name: 'future-job',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'not yet',
      schedule: { kind: 'every', everyMs: 3600_000 },
    });

    const due = store.getDueJobs(Date.now());
    expect(due.length).toBe(0);
  });

  it('should get next wake time', () => {
    store.add({
      name: 'job1',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'a',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    const nextWake = store.getNextWakeAtMs();
    expect(nextWake).toBeDefined();
    expect(nextWake!).toBeGreaterThan(Date.now() - 1000);
  });

  it('should return undefined for next wake when no jobs', () => {
    expect(store.getNextWakeAtMs()).toBeUndefined();
  });

  // ── Job state ──

  it('should update job state', () => {
    const job = store.add({
      name: 'state-test',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'test',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    const nowMs = Date.now();
    store.updateJobState(job.id, {
      lastRunAtMs: nowMs,
      lastStatus: 'ok',
      consecutiveErrors: 0,
      nextRunAtMs: nowMs + 60_000,
    });

    const updated = store.get(job.id);
    expect(updated!.state.lastRunAtMs).toBe(nowMs);
    expect(updated!.state.lastStatus).toBe('ok');
    expect(updated!.state.nextRunAtMs).toBe(nowMs + 60_000);
  });

  // ── Run history ──

  it('should insert and update runs', () => {
    const job = store.add({
      name: 'run-test',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'test',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    const startMs = Date.now();
    const runId = store.insertRun({
      jobId: job.id,
      startedAtMs: startMs,
      status: 'running',
    });

    expect(runId).toBeGreaterThan(0);

    const endMs = Date.now();
    store.updateRun(runId, {
      status: 'ok',
      endedAtMs: endMs,
      durationMs: endMs - startMs,
    });

    const runs = store.getRecentRuns(job.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('ok');
  });

  it('should clean old runs', () => {
    const job = store.add({
      name: 'clean-test',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'test',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    store.insertRun({
      jobId: job.id,
      startedAtMs: Date.now(),
      status: 'running',
    });

    // cleanOldRuns uses created_at < cutoff (strict), so use -1 days
    // to push the cutoff into the future and catch the just-created record
    store.cleanOldRuns(-1);
    expect(store.getRecentRuns(job.id).length).toBe(0);
  });

  // ── Thread binding ──

  it('persists skipHolidays and skipWeekends flags', () => {
    const job = store.add({
      name: 'skip-job',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'test',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      skipHolidays: true,
      skipWeekends: true,
    });

    expect(job.skipHolidays).toBe(true);
    expect(job.skipWeekends).toBe(true);

    const retrieved = store.get(job.id);
    expect(retrieved!.skipHolidays).toBe(true);
    expect(retrieved!.skipWeekends).toBe(true);
  });

  it('defaults skipHolidays and skipWeekends to false', () => {
    const job = store.add({
      name: 'default-job',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'test',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    expect(job.skipHolidays).toBe(false);
    expect(job.skipWeekends).toBe(false);
  });

  it('updates skipHolidays/skipWeekends via patch', () => {
    const job = store.add({
      name: 'patchable',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'test',
      schedule: { kind: 'every', everyMs: 60_000 },
    });
    expect(job.skipHolidays).toBe(false);

    const updated = store.update(job.id, { skipHolidays: true, skipWeekends: true });
    expect(updated!.skipHolidays).toBe(true);
    expect(updated!.skipWeekends).toBe(true);
  });

  it('should store thread binding fields', () => {
    const job = store.add({
      name: 'thread-job',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'thread test',
      schedule: { kind: 'every', everyMs: 60_000 },
      threadId: 'thread-123',
      threadRootMessageId: 'msg-456',
      contextSnapshot: 'repo: taptap/maker, branch: main',
    });

    expect(job.threadId).toBe('thread-123');
    expect(job.threadRootMessageId).toBe('msg-456');
    expect(job.contextSnapshot).toBe('repo: taptap/maker, branch: main');
  });

  // ── max_budget_usd 死字段移除的回归 ──
  //
  // 该字段曾存在于 cron_jobs 表和 CronJob 类型上，但 scheduler 从未把它传给
  // executor（预算实际由 agent 级配置决定），属于「设了以为生效」的死字段。
  // 移除后必须保证：① 不再出现在读出的 job 上；② 老库遗留的物理列不阻塞写入。

  it('should not expose maxBudgetUsd on jobs', () => {
    const job = store.add({
      name: 'no-budget-job',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'budget is agent-level',
      schedule: { kind: 'every', everyMs: 60_000 },
    });

    expect(job).not.toHaveProperty('maxBudgetUsd');
    expect(store.get(job.id)).not.toHaveProperty('maxBudgetUsd');
  });

  it('should add and update jobs on a legacy db that still has max_budget_usd', () => {
    // 模拟升级前的库：补回遗留列，并用最严格的 NOT NULL 形式
    const legacyPath = join(tempDir, 'legacy-cron.db');
    const seed = new CronStore(legacyPath);
    seed.close();
    const raw = new Database(legacyPath);
    raw.exec('ALTER TABLE cron_jobs ADD COLUMN max_budget_usd REAL NOT NULL DEFAULT 5');
    raw.close();

    const legacy = new CronStore(legacyPath);
    try {
      // INSERT 省略 max_budget_usd —— 应走列默认值而非报约束错误
      const job = legacy.add({
        name: 'legacy-job',
        chatId: 'chat1',
        userId: 'user1',
        prompt: 'still works',
        schedule: { kind: 'every', everyMs: 60_000 },
      });
      expect(job.name).toBe('legacy-job');
      expect(job).not.toHaveProperty('maxBudgetUsd');

      // UPDATE 同样不再触碰该列
      const updated = legacy.update(job.id, { name: 'legacy-job-renamed' });
      expect(updated!.name).toBe('legacy-job-renamed');

      // 遗留列仍在，值为默认 5，但对上层不可见
      const rawCheck = new Database(legacyPath, { readonly: true });
      const row = rawCheck.prepare('SELECT max_budget_usd FROM cron_jobs WHERE id = ?').get(job.id) as
        | { max_budget_usd: number }
        | undefined;
      rawCheck.close();
      expect(row!.max_budget_usd).toBe(5);
    } finally {
      legacy.close();
    }
  });
});

// ── computeNextRunAtMs ──

describe('computeNextRunAtMs', () => {
  it('should compute next run for cron expression', () => {
    const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' };
    const next = computeNextRunAtMs(schedule);
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThan(Date.now());
  });

  it('should return undefined for invalid cron expression', () => {
    const schedule: CronSchedule = { kind: 'cron', expr: 'invalid' };
    const next = computeNextRunAtMs(schedule);
    expect(next).toBeUndefined();
  });

  it('should compute next run for every schedule', () => {
    const nowMs = Date.now();
    const schedule: CronSchedule = { kind: 'every', everyMs: 60_000 };
    const next = computeNextRunAtMs(schedule, nowMs);
    expect(next).toBe(nowMs + 60_000);
  });

  it('should return undefined for zero interval', () => {
    const schedule: CronSchedule = { kind: 'every', everyMs: 0 };
    expect(computeNextRunAtMs(schedule)).toBeUndefined();
  });

  it('should compute next run for future at schedule', () => {
    const futureMs = Date.now() + 3600_000;
    const schedule: CronSchedule = { kind: 'at', atTime: new Date(futureMs).toISOString() };
    const next = computeNextRunAtMs(schedule);
    expect(next).toBeDefined();
    // Should be approximately futureMs (within 1s tolerance)
    expect(Math.abs(next! - futureMs)).toBeLessThan(1000);
  });

  it('should return undefined for past at schedule', () => {
    const pastMs = Date.now() - 3600_000;
    const schedule: CronSchedule = { kind: 'at', atTime: new Date(pastMs).toISOString() };
    expect(computeNextRunAtMs(schedule)).toBeUndefined();
  });
});
