import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import type { Session, SessionStatus } from './types.js';

interface SessionRow {
  key: string;
  chat_id: string;
  user_id: string;
  working_dir: string;
  conversation_id: string | null;
  conversation_cwd: string | null;
  thread_id: string | null;
  thread_root_message_id: string | null;
  status: string;
  created_at: string;
  last_active_at: string;
}

const VALID_STATUSES = new Set<string>(['idle', 'busy', 'error']);
function validStatus(s: string): SessionStatus {
  return VALID_STATUSES.has(s) ? (s as SessionStatus) : 'idle';
}

export class SessionDatabase {
  private db: Database.Database;
  private stmtUpsert: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtDeleteExpired: Database.Statement;
  private stmtUpdateWorkingDir: Database.Statement;
  private stmtUpdateStatus: Database.Statement;
  private stmtUpdateConversationId: Database.Statement;
  private stmtUpdateThread: Database.Statement;
  private stmtUpdateLastActive: Database.Statement;
  private stmtResetBusy: Database.Statement;
  private stmtTryAcquire: Database.Statement;
  private stmtInsertSummary: Database.Statement;
  private stmtGetRecentSummaries: Database.Statement;
  private stmtCleanOldSummaries: Database.Statement;

  constructor(dbPath: string) {
    dbPath = resolve(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT OR IGNORE INTO schema_version VALUES (1)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key                     TEXT PRIMARY KEY,
        chat_id                 TEXT NOT NULL,
        user_id                 TEXT NOT NULL,
        working_dir             TEXT NOT NULL,
        conversation_id         TEXT,
        conversation_cwd        TEXT,
        thread_id               TEXT,
        thread_root_message_id  TEXT,
        status                  TEXT NOT NULL DEFAULT 'idle',
        created_at              TEXT NOT NULL,
        last_active_at          TEXT NOT NULL
      )
    `);

    // Migration v1 → v2: add conversation_cwd column
    const version = (this.db.prepare('SELECT version FROM schema_version').get() as { version: number })?.version ?? 1;
    if (version < 2) {
      const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'conversation_cwd')) {
        this.db.exec('ALTER TABLE sessions ADD COLUMN conversation_cwd TEXT');
      }
      this.db.exec('UPDATE schema_version SET version = 2');
    }

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO sessions (key, chat_id, user_id, working_dir, conversation_id, conversation_cwd, thread_id, thread_root_message_id, status, created_at, last_active_at)
      VALUES (@key, @chat_id, @user_id, @working_dir, @conversation_id, @conversation_cwd, @thread_id, @thread_root_message_id, @status, @created_at, @last_active_at)
      ON CONFLICT(key) DO UPDATE SET
        working_dir = @working_dir,
        conversation_id = @conversation_id,
        conversation_cwd = @conversation_cwd,
        thread_id = @thread_id,
        thread_root_message_id = @thread_root_message_id,
        status = @status,
        last_active_at = @last_active_at
    `);

    this.stmtGet = this.db.prepare('SELECT * FROM sessions WHERE key = ?');
    this.stmtDelete = this.db.prepare('DELETE FROM sessions WHERE key = ?');

    this.stmtDeleteExpired = this.db.prepare(`
      DELETE FROM sessions
      WHERE status != 'busy'
        AND last_active_at < ?
    `);

    this.stmtUpdateWorkingDir = this.db.prepare(
      'UPDATE sessions SET working_dir = ?, last_active_at = ? WHERE key = ?',
    );

    this.stmtUpdateStatus = this.db.prepare(
      'UPDATE sessions SET status = ?, last_active_at = ? WHERE key = ?',
    );

    this.stmtUpdateConversationId = this.db.prepare(
      'UPDATE sessions SET conversation_id = ?, conversation_cwd = ?, last_active_at = ? WHERE key = ?',
    );

    this.stmtUpdateThread = this.db.prepare(
      'UPDATE sessions SET thread_id = ?, thread_root_message_id = ?, last_active_at = ? WHERE key = ?',
    );

    this.stmtUpdateLastActive = this.db.prepare(
      'UPDATE sessions SET last_active_at = ? WHERE key = ?',
    );

    this.stmtResetBusy = this.db.prepare(
      "UPDATE sessions SET status = 'idle', conversation_id = NULL WHERE status = 'busy'",
    );

    this.stmtTryAcquire = this.db.prepare(
      "UPDATE sessions SET status = 'busy', last_active_at = ? WHERE key = ? AND status != 'busy'",
    );

    // 会话摘要表（独立于 sessions，不受 cleanup 影响）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        working_dir TEXT,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_summaries_user
        ON session_summaries(chat_id, user_id, created_at DESC)
    `);

    this.stmtInsertSummary = this.db.prepare(
      'INSERT INTO session_summaries (chat_id, user_id, working_dir, summary, created_at) VALUES (?, ?, ?, ?, ?)',
    );

    this.stmtGetRecentSummaries = this.db.prepare(
      'SELECT summary FROM session_summaries WHERE chat_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    );

    this.stmtCleanOldSummaries = this.db.prepare(
      'DELETE FROM session_summaries WHERE created_at < ?',
    );

    logger.info({ dbPath }, 'Session database initialized');
  }

  upsert(key: string, session: Session): void {
    this.stmtUpsert.run({
      key,
      chat_id: session.chatId,
      user_id: session.userId,
      working_dir: session.workingDir,
      conversation_id: session.conversationId ?? null,
      conversation_cwd: session.conversationCwd ?? null,
      thread_id: session.threadId ?? null,
      thread_root_message_id: session.threadRootMessageId ?? null,
      status: session.status,
      created_at: session.createdAt.toISOString(),
      last_active_at: session.lastActiveAt.toISOString(),
    });
  }

  get(key: string): Session | undefined {
    const row = this.stmtGet.get(key) as SessionRow | undefined;
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  delete(key: string): void {
    this.stmtDelete.run(key);
  }

  deleteExpired(maxIdleMs: number): number {
    const cutoff = new Date(Date.now() - maxIdleMs).toISOString();
    const result = this.stmtDeleteExpired.run(cutoff);
    return result.changes;
  }

  updateWorkingDir(key: string, dir: string): void {
    this.stmtUpdateWorkingDir.run(dir, new Date().toISOString(), key);
  }

  updateStatus(key: string, status: SessionStatus): void {
    this.stmtUpdateStatus.run(status, new Date().toISOString(), key);
  }

  updateConversationId(key: string, conversationId: string, cwd?: string): void {
    this.stmtUpdateConversationId.run(conversationId, cwd ?? null, new Date().toISOString(), key);
  }

  updateThread(key: string, threadId: string, rootMessageId: string): void {
    this.stmtUpdateThread.run(threadId, rootMessageId, new Date().toISOString(), key);
  }

  updateLastActive(key: string): void {
    this.stmtUpdateLastActive.run(new Date().toISOString(), key);
  }

  /**
   * 原子地尝试将 session 标记为 busy（CAS: idle → busy）
   * @returns true 如果成功获取锁，false 如果已经 busy
   */
  tryAcquire(key: string): boolean {
    const result = this.stmtTryAcquire.run(new Date().toISOString(), key);
    return result.changes === 1;
  }

  resetBusySessions(): number {
    const result = this.stmtResetBusy.run();
    if (result.changes > 0) {
      logger.info({ count: result.changes }, 'Reset stale busy sessions to idle');
    }
    return result.changes;
  }

  insertSummary(chatId: string, userId: string, workingDir: string, summary: string): void {
    this.stmtInsertSummary.run(chatId, userId, workingDir, summary, new Date().toISOString());
  }

  getRecentSummaries(chatId: string, userId: string, limit: number): string[] {
    const rows = this.stmtGetRecentSummaries.all(chatId, userId, limit) as Array<{ summary: string }>;
    // 返回时间正序（旧 → 新）
    return rows.map((r) => r.summary).reverse();
  }

  cleanOldSummaries(maxAgeDays: number = 30): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.stmtCleanOldSummaries.run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
    logger.info('Session database closed');
  }

  private rowToSession(row: SessionRow): Session {
    return {
      chatId: row.chat_id,
      userId: row.user_id,
      workingDir: row.working_dir,
      conversationId: row.conversation_id ?? undefined,
      conversationCwd: row.conversation_cwd ?? undefined,
      threadId: row.thread_id ?? undefined,
      threadRootMessageId: row.thread_root_message_id ?? undefined,
      status: validStatus(row.status),
      createdAt: new Date(row.created_at),
      lastActiveAt: new Date(row.last_active_at),
    };
  }
}
