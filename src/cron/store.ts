import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Cron } from 'croner';
import { logger } from '../utils/logger.js';
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronJobState,
  CronRun,
  CronRunCreate,
  CronRunResult,
  CronSchedule,
} from './types.js';

function nanoid(): string {
  return randomBytes(10).toString('hex');
}

// ── Row types ──

interface CronJobRow {
  id: string;
  name: string;
  chat_id: string;
  user_id: string;
  prompt: string;
  working_dir: string | null;
  repo_url: string | null;
  schedule_kind: string;
  schedule_expr: string | null;
  schedule_tz: string | null;
  every_ms: number | null;
  at_time: string | null;
  enabled: number;
  delete_after_run: number;
  next_run_at_ms: number | null;
  last_run_at_ms: number | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  consecutive_errors: number;
  timeout_seconds: number;
  model: string | null;
  max_budget_usd: number;
  agent_id: string;
  thread_id: string | null;
  thread_root_message_id: string | null;
  context_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

interface CronRunRow {
  id: number;
  job_id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  status: string;
  output: string | null;
  error: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
}

// ── Helpers ──

function rowToJob(row: CronJobRow): CronJob {
  return {
    id: row.id,
    name: row.name,
    chatId: row.chat_id,
    userId: row.user_id,
    prompt: row.prompt,
    workingDir: row.working_dir ?? undefined,
    repoUrl: row.repo_url ?? undefined,
    schedule: {
      kind: row.schedule_kind as CronSchedule['kind'],
      expr: row.schedule_expr ?? undefined,
      tz: row.schedule_tz ?? undefined,
      everyMs: row.every_ms ?? undefined,
      atTime: row.at_time ?? undefined,
    },
    enabled: !!row.enabled,
    deleteAfterRun: !!row.delete_after_run,
    timeoutSeconds: row.timeout_seconds,
    model: row.model ?? undefined,
    maxBudgetUsd: row.max_budget_usd,
    agentId: row.agent_id,
    threadId: row.thread_id ?? undefined,
    threadRootMessageId: row.thread_root_message_id ?? undefined,
    contextSnapshot: row.context_snapshot ?? undefined,
    state: {
      nextRunAtMs: row.next_run_at_ms ?? undefined,
      lastRunAtMs: row.last_run_at_ms ?? undefined,
      lastStatus: (row.last_status as CronJobState['lastStatus']) ?? undefined,
      lastError: row.last_error ?? undefined,
      lastDurationMs: row.last_duration_ms ?? undefined,
      consecutiveErrors: row.consecutive_errors,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: CronRunRow): CronRun {
  return {
    id: row.id,
    jobId: row.job_id,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms ?? undefined,
    status: row.status as CronRun['status'],
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    createdAt: row.created_at,
  };
}

/** 计算 CronJob 下次执行时间 */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number = Date.now()): number | undefined {
  switch (schedule.kind) {
    case 'cron': {
      if (!schedule.expr) return undefined;
      try {
        const job = new Cron(schedule.expr, { timezone: schedule.tz || 'Asia/Shanghai' });
        const next = job.nextRun(new Date(nowMs));
        return next ? next.getTime() : undefined;
      } catch {
        return undefined;
      }
    }
    case 'every': {
      if (!schedule.everyMs || schedule.everyMs <= 0) return undefined;
      return nowMs + schedule.everyMs;
    }
    case 'at': {
      if (!schedule.atTime) return undefined;
      const atMs = new Date(schedule.atTime).getTime();
      return atMs > nowMs ? atMs : undefined;
    }
    default:
      return undefined;
  }
}

// ── CronStore ──

export class CronStore {
  private db: Database.Database;

  // Prepared statements
  private stmtInsertJob: Database.Statement;
  private stmtGetJob: Database.Statement;
  private stmtDeleteJob: Database.Statement;
  private stmtListJobs: Database.Statement;
  private stmtListJobsByChat: Database.Statement;
  private stmtListEnabledJobs: Database.Statement;
  private stmtGetDueJobs: Database.Statement;
  private stmtGetNextWake: Database.Statement;
  private stmtUpdateJobState: Database.Statement;
  private stmtUpdateJob: Database.Statement;
  private stmtInsertRun: Database.Statement;
  private stmtUpdateRun: Database.Statement;
  private stmtGetRecentRuns: Database.Statement;
  private stmtCleanOldRuns: Database.Statement;

  constructor(dbPath: string) {
    dbPath = resolve(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id                      TEXT PRIMARY KEY,
        name                    TEXT NOT NULL,
        chat_id                 TEXT NOT NULL,
        user_id                 TEXT NOT NULL,
        prompt                  TEXT NOT NULL,
        working_dir             TEXT,
        repo_url                TEXT,
        schedule_kind           TEXT NOT NULL,
        schedule_expr           TEXT,
        schedule_tz             TEXT DEFAULT 'Asia/Shanghai',
        every_ms                INTEGER,
        at_time                 TEXT,
        enabled                 INTEGER NOT NULL DEFAULT 1,
        delete_after_run        INTEGER NOT NULL DEFAULT 0,
        next_run_at_ms          INTEGER,
        last_run_at_ms          INTEGER,
        last_status             TEXT,
        last_error              TEXT,
        last_duration_ms        INTEGER,
        consecutive_errors      INTEGER DEFAULT 0,
        timeout_seconds         INTEGER DEFAULT 300,
        model                   TEXT,
        max_budget_usd          REAL DEFAULT 5,
        agent_id                TEXT DEFAULT 'dev',
        thread_id               TEXT,
        thread_root_message_id  TEXT,
        context_snapshot        TEXT,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
        ON cron_jobs(next_run_at_ms) WHERE enabled = 1
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_chat
        ON cron_jobs(chat_id)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id          TEXT NOT NULL,
        started_at_ms   INTEGER NOT NULL,
        ended_at_ms     INTEGER,
        status          TEXT NOT NULL,
        output          TEXT,
        error           TEXT,
        cost_usd        REAL,
        duration_ms     INTEGER,
        created_at      TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cron_runs_job
        ON cron_runs(job_id, started_at_ms DESC)
    `);

    // ── Prepared statements ──

    this.stmtInsertJob = this.db.prepare(`
      INSERT INTO cron_jobs (
        id, name, chat_id, user_id, prompt, working_dir, repo_url,
        schedule_kind, schedule_expr, schedule_tz, every_ms, at_time,
        enabled, delete_after_run, next_run_at_ms,
        timeout_seconds, model, max_budget_usd, agent_id,
        thread_id, thread_root_message_id, context_snapshot,
        created_at, updated_at
      ) VALUES (
        @id, @name, @chat_id, @user_id, @prompt, @working_dir, @repo_url,
        @schedule_kind, @schedule_expr, @schedule_tz, @every_ms, @at_time,
        @enabled, @delete_after_run, @next_run_at_ms,
        @timeout_seconds, @model, @max_budget_usd, @agent_id,
        @thread_id, @thread_root_message_id, @context_snapshot,
        @created_at, @updated_at
      )
    `);

    this.stmtGetJob = this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?');
    this.stmtDeleteJob = this.db.prepare('DELETE FROM cron_jobs WHERE id = ?');
    this.stmtListJobs = this.db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC');
    this.stmtListJobsByChat = this.db.prepare('SELECT * FROM cron_jobs WHERE chat_id = ? ORDER BY created_at DESC');
    this.stmtListEnabledJobs = this.db.prepare('SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY next_run_at_ms ASC');

    this.stmtGetDueJobs = this.db.prepare(
      'SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at_ms IS NOT NULL AND next_run_at_ms <= ? ORDER BY next_run_at_ms ASC',
    );

    this.stmtGetNextWake = this.db.prepare(
      'SELECT MIN(next_run_at_ms) as next FROM cron_jobs WHERE enabled = 1 AND next_run_at_ms IS NOT NULL',
    );

    this.stmtUpdateJobState = this.db.prepare(`
      UPDATE cron_jobs SET
        next_run_at_ms = @next_run_at_ms,
        last_run_at_ms = @last_run_at_ms,
        last_status = @last_status,
        last_error = @last_error,
        last_duration_ms = @last_duration_ms,
        consecutive_errors = @consecutive_errors,
        updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtUpdateJob = this.db.prepare(`
      UPDATE cron_jobs SET
        name = @name,
        prompt = @prompt,
        schedule_kind = @schedule_kind,
        schedule_expr = @schedule_expr,
        schedule_tz = @schedule_tz,
        every_ms = @every_ms,
        at_time = @at_time,
        enabled = @enabled,
        timeout_seconds = @timeout_seconds,
        model = @model,
        max_budget_usd = @max_budget_usd,
        next_run_at_ms = @next_run_at_ms,
        thread_id = @thread_id,
        thread_root_message_id = @thread_root_message_id,
        context_snapshot = @context_snapshot,
        updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtInsertRun = this.db.prepare(`
      INSERT INTO cron_runs (job_id, started_at_ms, status, created_at)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtUpdateRun = this.db.prepare(`
      UPDATE cron_runs SET
        ended_at_ms = @ended_at_ms,
        status = @status,
        output = @output,
        error = @error,
        cost_usd = @cost_usd,
        duration_ms = @duration_ms
      WHERE id = @id
    `);

    this.stmtGetRecentRuns = this.db.prepare(
      'SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at_ms DESC LIMIT ?',
    );

    this.stmtCleanOldRuns = this.db.prepare(
      'DELETE FROM cron_runs WHERE created_at < ?',
    );

    logger.info({ dbPath }, 'Cron store initialized');
  }

  // ── Job CRUD ──

  add(input: CronJobCreate): CronJob {
    const now = new Date().toISOString();
    const id = nanoid();
    const enabled = input.enabled !== false;
    const deleteAfterRun = input.deleteAfterRun ?? (input.schedule.kind === 'at');
    const nextRunAtMs = enabled ? computeNextRunAtMs(input.schedule) : undefined;

    this.stmtInsertJob.run({
      id,
      name: input.name,
      chat_id: input.chatId,
      user_id: input.userId,
      prompt: input.prompt,
      working_dir: input.workingDir ?? null,
      repo_url: input.repoUrl ?? null,
      schedule_kind: input.schedule.kind,
      schedule_expr: input.schedule.expr ?? null,
      schedule_tz: input.schedule.tz ?? 'Asia/Shanghai',
      every_ms: input.schedule.everyMs ?? null,
      at_time: input.schedule.atTime ?? null,
      enabled: enabled ? 1 : 0,
      delete_after_run: deleteAfterRun ? 1 : 0,
      next_run_at_ms: nextRunAtMs ?? null,
      timeout_seconds: input.timeoutSeconds ?? 300,
      model: input.model ?? null,
      max_budget_usd: input.maxBudgetUsd ?? 5,
      agent_id: input.agentId ?? 'dev',
      thread_id: input.threadId ?? null,
      thread_root_message_id: input.threadRootMessageId ?? null,
      context_snapshot: input.contextSnapshot ?? null,
      created_at: now,
      updated_at: now,
    });

    return this.get(id)!;
  }

  get(id: string): CronJob | undefined {
    const row = this.stmtGetJob.get(id) as CronJobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  update(id: string, patch: CronJobPatch): CronJob | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const schedule = patch.schedule ?? existing.schedule;
    const enabled = patch.enabled ?? existing.enabled;
    const nextRunAtMs = enabled ? computeNextRunAtMs(schedule) : undefined;

    this.stmtUpdateJob.run({
      id,
      name: patch.name ?? existing.name,
      prompt: patch.prompt ?? existing.prompt,
      schedule_kind: schedule.kind,
      schedule_expr: schedule.expr ?? null,
      schedule_tz: schedule.tz ?? 'Asia/Shanghai',
      every_ms: schedule.everyMs ?? null,
      at_time: schedule.atTime ?? null,
      enabled: enabled ? 1 : 0,
      timeout_seconds: patch.timeoutSeconds ?? existing.timeoutSeconds,
      model: patch.model !== undefined ? (patch.model ?? null) : (existing.model ?? null),
      max_budget_usd: patch.maxBudgetUsd ?? existing.maxBudgetUsd,
      next_run_at_ms: nextRunAtMs ?? null,
      thread_id: patch.threadId !== undefined ? (patch.threadId ?? null) : (existing.threadId ?? null),
      thread_root_message_id: patch.threadRootMessageId !== undefined
        ? (patch.threadRootMessageId ?? null)
        : (existing.threadRootMessageId ?? null),
      context_snapshot: patch.contextSnapshot !== undefined
        ? (patch.contextSnapshot ?? null)
        : (existing.contextSnapshot ?? null),
      updated_at: now,
    });

    return this.get(id);
  }

  remove(id: string): boolean {
    const result = this.stmtDeleteJob.run(id);
    return result.changes > 0;
  }

  list(opts?: { chatId?: string }): CronJob[] {
    const rows = opts?.chatId
      ? (this.stmtListJobsByChat.all(opts.chatId) as CronJobRow[])
      : (this.stmtListJobs.all() as CronJobRow[]);
    return rows.map(rowToJob);
  }

  listEnabled(): CronJob[] {
    return (this.stmtListEnabledJobs.all() as CronJobRow[]).map(rowToJob);
  }

  // ── Scheduling queries ──

  getDueJobs(nowMs: number): CronJob[] {
    return (this.stmtGetDueJobs.all(nowMs) as CronJobRow[]).map(rowToJob);
  }

  getNextWakeAtMs(): number | undefined {
    const row = this.stmtGetNextWake.get() as { next: number | null } | undefined;
    return row?.next ?? undefined;
  }

  updateJobState(id: string, state: Partial<CronJobState>): void {
    const existing = this.get(id);
    if (!existing) return;

    this.stmtUpdateJobState.run({
      id,
      next_run_at_ms: state.nextRunAtMs !== undefined ? (state.nextRunAtMs ?? null) : (existing.state.nextRunAtMs ?? null),
      last_run_at_ms: state.lastRunAtMs !== undefined ? (state.lastRunAtMs ?? null) : (existing.state.lastRunAtMs ?? null),
      last_status: state.lastStatus !== undefined ? (state.lastStatus ?? null) : (existing.state.lastStatus ?? null),
      last_error: state.lastError !== undefined ? (state.lastError ?? null) : (existing.state.lastError ?? null),
      last_duration_ms: state.lastDurationMs !== undefined ? (state.lastDurationMs ?? null) : (existing.state.lastDurationMs ?? null),
      consecutive_errors: state.consecutiveErrors ?? existing.state.consecutiveErrors,
      updated_at: new Date().toISOString(),
    });
  }

  // ── Run history ──

  insertRun(input: CronRunCreate): number {
    const result = this.stmtInsertRun.run(
      input.jobId,
      input.startedAtMs,
      input.status,
      new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  updateRun(id: number, result: CronRunResult): void {
    this.stmtUpdateRun.run({
      id,
      ended_at_ms: result.endedAtMs,
      status: result.status,
      output: result.output ?? null,
      error: result.error ?? null,
      cost_usd: result.costUsd ?? null,
      duration_ms: result.durationMs ?? null,
    });
  }

  getRecentRuns(jobId: string, limit: number = 10): CronRun[] {
    return (this.stmtGetRecentRuns.all(jobId, limit) as CronRunRow[]).map(rowToRun);
  }

  cleanOldRuns(maxAgeDays: number): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.stmtCleanOldRuns.run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
    logger.info('Cron store closed');
  }
}
