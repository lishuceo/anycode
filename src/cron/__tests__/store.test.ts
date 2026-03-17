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

  it('should store thread binding fields', () => {
    const job = store.add({
      name: 'thread-job',
      chatId: 'chat1',
      userId: 'user1',
      prompt: 'thread test',
      schedule: { kind: 'every', everyMs: 60_000 },
      threadId: 'thread-123',
      threadRootMessageId: 'msg-456',
      contextSnapshot: 'repo: taptap/code, branch: main',
    });

    expect(job.threadId).toBe('thread-123');
    expect(job.threadRootMessageId).toBe('msg-456');
    expect(job.contextSnapshot).toBe('repo: taptap/code, branch: main');
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
