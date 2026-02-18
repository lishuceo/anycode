import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { PipelineStatus } from './types.js';

// ============================================================
// Pipeline 持久化存储
// ============================================================

export interface PipelineRecord {
  id: string;
  chatId: string;
  userId: string;
  messageId: string;
  threadRootMsgId?: string;
  progressMsgId?: string;
  workingDir: string;
  prompt: string;
  status: PipelineStatus;
  phase: string;
  stateJson: string;
  createdAt: string;
  updatedAt: string;
}

interface PipelineRow {
  id: string;
  chat_id: string;
  user_id: string;
  message_id: string;
  thread_root_msg_id: string | null;
  progress_msg_id: string | null;
  working_dir: string;
  prompt: string;
  status: string;
  phase: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}

const VALID_STATUSES = new Set<string>([
  'pending_confirm', 'running', 'done', 'failed',
  'aborted', 'interrupted', 'cancelled',
]);

function validStatus(s: string): PipelineStatus {
  return VALID_STATUSES.has(s) ? (s as PipelineStatus) : 'failed';
}

export class PipelineStore {
  private db: Database.Database;
  private stmtCreate: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtTryStart: Database.Statement;
  private stmtUpdateState: Database.Statement;
  private stmtUpdateProgressMsgId: Database.Statement;
  private stmtFindByStatus: Database.Statement;
  private stmtMarkRunningAsInterrupted: Database.Statement;
  private stmtCleanExpired: Database.Statement;

  constructor(dbPath: string) {
    dbPath = resolve(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipelines (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_root_msg_id TEXT,
        progress_msg_id TEXT,
        working_dir TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_confirm',
        phase TEXT NOT NULL DEFAULT '',
        state_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.stmtCreate = this.db.prepare(`
      INSERT INTO pipelines (id, chat_id, user_id, message_id, thread_root_msg_id, progress_msg_id, working_dir, prompt, status, phase, state_json, created_at, updated_at)
      VALUES (@id, @chat_id, @user_id, @message_id, @thread_root_msg_id, @progress_msg_id, @working_dir, @prompt, @status, @phase, @state_json, @created_at, @updated_at)
    `);

    this.stmtGet = this.db.prepare('SELECT * FROM pipelines WHERE id = ?');

    // CAS: pending_confirm → running (atomic double-click prevention)
    this.stmtTryStart = this.db.prepare(`
      UPDATE pipelines SET status = 'running', updated_at = ?
      WHERE id = ? AND status = 'pending_confirm'
    `);

    this.stmtUpdateState = this.db.prepare(`
      UPDATE pipelines SET status = ?, phase = ?, state_json = ?, updated_at = ?
      WHERE id = ?
    `);

    this.stmtUpdateProgressMsgId = this.db.prepare(`
      UPDATE pipelines SET progress_msg_id = ?, updated_at = ?
      WHERE id = ?
    `);

    this.stmtFindByStatus = this.db.prepare(
      'SELECT * FROM pipelines WHERE status = ?',
    );

    this.stmtMarkRunningAsInterrupted = this.db.prepare(`
      UPDATE pipelines SET status = 'interrupted', updated_at = ?
      WHERE status = 'running'
    `);

    this.stmtCleanExpired = this.db.prepare(`
      DELETE FROM pipelines WHERE created_at < ?
    `);

    logger.info({ dbPath }, 'Pipeline store initialized');
  }

  create(record: Omit<PipelineRecord, 'createdAt' | 'updatedAt' | 'status' | 'phase' | 'stateJson'>): PipelineRecord {
    const now = new Date().toISOString();
    const full: PipelineRecord = {
      ...record,
      status: 'pending_confirm',
      phase: '',
      stateJson: '{}',
      createdAt: now,
      updatedAt: now,
    };

    this.stmtCreate.run({
      id: full.id,
      chat_id: full.chatId,
      user_id: full.userId,
      message_id: full.messageId,
      thread_root_msg_id: full.threadRootMsgId ?? null,
      progress_msg_id: full.progressMsgId ?? null,
      working_dir: full.workingDir,
      prompt: full.prompt,
      status: full.status,
      phase: full.phase,
      state_json: full.stateJson,
      created_at: full.createdAt,
      updated_at: full.updatedAt,
    });

    return full;
  }

  get(id: string): PipelineRecord | undefined {
    const row = this.stmtGet.get(id) as PipelineRow | undefined;
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  /**
   * Atomic CAS: pending_confirm → running
   * Returns true if transition succeeded, false if already started
   */
  tryStart(id: string): boolean {
    const result = this.stmtTryStart.run(new Date().toISOString(), id);
    return result.changes === 1;
  }

  updateState(id: string, status: PipelineStatus, phase: string, stateJson: string): void {
    this.stmtUpdateState.run(status, phase, stateJson, new Date().toISOString(), id);
  }

  updateProgressMsgId(id: string, msgId: string): void {
    this.stmtUpdateProgressMsgId.run(msgId, new Date().toISOString(), id);
  }

  findByStatus(status: PipelineStatus): PipelineRecord[] {
    const rows = this.stmtFindByStatus.all(status) as PipelineRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * Mark all running pipelines as interrupted (for crash recovery)
   * Returns the number of pipelines marked
   */
  markRunningAsInterrupted(): number {
    const result = this.stmtMarkRunningAsInterrupted.run(new Date().toISOString());
    if (result.changes > 0) {
      logger.info({ count: result.changes }, 'Marked running pipelines as interrupted');
    }
    return result.changes;
  }

  cleanExpired(maxAgeDays: number): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.stmtCleanExpired.run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
    logger.info('Pipeline store closed');
  }

  private rowToRecord(row: PipelineRow): PipelineRecord {
    return {
      id: row.id,
      chatId: row.chat_id,
      userId: row.user_id,
      messageId: row.message_id,
      threadRootMsgId: row.thread_root_msg_id ?? undefined,
      progressMsgId: row.progress_msg_id ?? undefined,
      workingDir: row.working_dir,
      prompt: row.prompt,
      status: validStatus(row.status),
      phase: row.phase,
      stateJson: row.state_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export function generatePipelineId(): string {
  return `pipe_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export const pipelineStore = new PipelineStore(config.db.sessionDbPath);
