import { logger } from '../utils/logger.js';
import { CronStore, computeNextRunAtMs } from './store.js';
import type { CronJob, CronJobCreate, CronJobPatch } from './types.js';

/** 错误退避时间表 */
const BACKOFF_MS = [
  30_000,        // 1st → 30s
  60_000,        // 2nd → 1min
  5 * 60_000,    // 3rd → 5min
  15 * 60_000,   // 4th → 15min
  60 * 60_000,   // 5th+ → 1h
];

/** 执行 cron job 的回调类型 (由 event-handler 提供) */
export type CronTaskExecutor = (params: {
  prompt: string;
  chatId: string;
  userId: string;
  messageId: string;
  rootId?: string;
  threadId?: string;
  agentId: string;
}) => Promise<void>;

/** 发占位消息的回调类型 */
export type CronMessageSender = (chatId: string, text: string, rootId?: string) => Promise<string | undefined>;

export interface CronSchedulerDeps {
  store: CronStore;
  executeTask: CronTaskExecutor;
  sendMessage: CronMessageSender;
}

export class CronScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private deps: CronSchedulerDeps;

  constructor(deps: CronSchedulerDeps) {
    this.deps = deps;
  }

  get store(): CronStore {
    return this.deps.store;
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    logger.info('cron: starting scheduler');

    // 补跑重启期间错过的任务
    const nowMs = Date.now();
    const dueJobs = this.deps.store.getDueJobs(nowMs);
    if (dueJobs.length > 0) {
      logger.info({ count: dueJobs.length }, 'cron: running missed jobs after startup');
      for (const job of dueJobs.slice(0, 5)) {
        // 最多补跑 5 个，避免雪崩
        await this.executeJob(job);
      }
      // 多余的只推进 nextRunAtMs 不执行
      for (const job of dueJobs.slice(5)) {
        const nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
        this.deps.store.updateJobState(job.id, { nextRunAtMs });
      }
    }

    this.armTimer();

    const nextWake = this.deps.store.getNextWakeAtMs();
    logger.info(
      { jobs: this.deps.store.listEnabled().length, nextWakeAtMs: nextWake ?? null },
      'cron: scheduler started',
    );
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('cron: scheduler stopped');
  }

  // ── Timer ──

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextAt = this.deps.store.getNextWakeAtMs();
    if (!nextAt) return;

    const delay = Math.min(
      Math.max(nextAt - Date.now(), 2000),  // 最小 2s 防 spin
      60_000,                                // 最大 60s 防 drift
    );

    this.timer = setTimeout(() => {
      this.onTimer().catch((err) => {
        logger.error({ err }, 'cron: timer tick failed');
      });
    }, delay);
  }

  private async onTimer(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const nowMs = Date.now();
      const dueJobs = this.deps.store.getDueJobs(nowMs);

      for (const job of dueJobs) {
        await this.executeJob(job);
      }
    } finally {
      this.running = false;
      this.armTimer();
    }
  }

  // ── Job execution ──

  private async executeJob(job: CronJob): Promise<void> {
    const startMs = Date.now();
    const runId = this.deps.store.insertRun({
      jobId: job.id,
      startedAtMs: startMs,
      status: 'running',
    });

    try {
      // 1. 发占位消息到飞书拿 messageId
      const placeholderText = `⏰ 定时任务「${job.name}」执行中...`;
      const messageId = await this.deps.sendMessage(
        job.chatId,
        placeholderText,
        job.threadRootMessageId,
      );

      if (!messageId) {
        throw new Error('Failed to send placeholder message to Feishu');
      }

      // 2. 构造 prompt
      const contextPrefix = job.contextSnapshot ? `[上下文]\n${job.contextSnapshot}\n\n` : '';
      const prompt = `${contextPrefix}[⏰ 定时任务: ${job.name}]\n\n${job.prompt}`;

      // 3. 注入现有流程 —— 和用户 @bot 完全一样
      await this.deps.executeTask({
        prompt,
        chatId: job.chatId,
        userId: job.userId,
        messageId,
        rootId: job.threadRootMessageId,
        threadId: job.threadId,
        agentId: job.agentId,
      });

      // 4. 成功
      const endMs = Date.now();
      this.deps.store.updateRun(runId, {
        status: 'ok',
        endedAtMs: endMs,
        durationMs: endMs - startMs,
      });

      const nextRunAtMs = computeNextRunAtMs(job.schedule, endMs);
      this.deps.store.updateJobState(job.id, {
        lastRunAtMs: startMs,
        lastStatus: 'ok',
        lastError: undefined,
        lastDurationMs: endMs - startMs,
        consecutiveErrors: 0,
        nextRunAtMs,
      });

      // 一次性任务执行后自动删除
      if (job.deleteAfterRun) {
        this.deps.store.remove(job.id);
        logger.info({ jobId: job.id, jobName: job.name }, 'cron: one-shot job deleted after run');
      }

      logger.info(
        { jobId: job.id, jobName: job.name, durationMs: endMs - startMs, nextRunAtMs },
        'cron: job completed',
      );
    } catch (err) {
      const endMs = Date.now();
      const errorStr = err instanceof Error ? err.message : String(err);

      this.deps.store.updateRun(runId, {
        status: 'error',
        endedAtMs: endMs,
        error: errorStr,
        durationMs: endMs - startMs,
      });

      const consecutiveErrors = job.state.consecutiveErrors + 1;
      const backoffIdx = Math.min(consecutiveErrors - 1, BACKOFF_MS.length - 1);
      const backoffMs = BACKOFF_MS[backoffIdx];
      const nextRunAtMs = job.deleteAfterRun
        ? undefined  // 一次性任务失败不重试（TODO: 可配置）
        : (computeNextRunAtMs(job.schedule, endMs) ?? endMs + backoffMs);

      this.deps.store.updateJobState(job.id, {
        lastRunAtMs: startMs,
        lastStatus: 'error',
        lastError: errorStr,
        lastDurationMs: endMs - startMs,
        consecutiveErrors,
        nextRunAtMs,
      });

      if (job.deleteAfterRun) {
        this.deps.store.remove(job.id);
      }

      logger.error(
        { jobId: job.id, jobName: job.name, err: errorStr, consecutiveErrors, nextBackoffMs: backoffMs },
        'cron: job failed',
      );
    }
  }

  // ── Public API (for MCP tool) ──

  async addJob(input: CronJobCreate): Promise<CronJob> {
    const job = this.deps.store.add(input);
    this.armTimer();
    logger.info({ jobId: job.id, jobName: job.name, nextRunAtMs: job.state.nextRunAtMs }, 'cron: job added');
    return job;
  }

  async updateJob(id: string, patch: CronJobPatch): Promise<CronJob | undefined> {
    const job = this.deps.store.update(id, patch);
    if (job) {
      this.armTimer();
      logger.info({ jobId: id, nextRunAtMs: job.state.nextRunAtMs }, 'cron: job updated');
    }
    return job;
  }

  async removeJob(id: string): Promise<boolean> {
    const removed = this.deps.store.remove(id);
    if (removed) {
      this.armTimer();
      logger.info({ jobId: id }, 'cron: job removed');
    }
    return removed;
  }

  listJobs(opts?: { chatId?: string }): CronJob[] {
    return this.deps.store.list(opts);
  }

  async triggerJob(id: string): Promise<void> {
    const job = this.deps.store.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    await this.executeJob(job);
    this.armTimer();
  }
}
