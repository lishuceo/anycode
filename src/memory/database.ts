// ============================================================
// Memory System — SQLite Database (independent DB file)
// ============================================================

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import type { Memory, MemoryType, ConfidenceLevel } from './types.js';

/** Raw row shape from the memories table */
export interface MemoryRow {
  id: string;
  agent_id: string;
  user_id: string | null;
  chat_id: string | null;
  workspace_dir: string | null;
  type: string;
  content: string;
  tags: string;
  metadata: string;
  confidence: number;
  confidence_level: string;
  evidence_count: number;
  valid_at: string;
  invalid_at: string | null;
  superseded_by: string | null;
  ttl: string | null;
  source_chat_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

/** FTS5 search result row */
export interface FtsResultRow extends MemoryRow {
  rank: number;
}

/** vec0 search result row */
export interface VecResultRow {
  memory_id: string;
  distance: number;
}

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Strips FTS5 operators and wraps each token in double quotes for literal matching.
 */
export function sanitizeFtsQuery(raw: string): string {
  // Remove FTS5 special characters: * " ( ) { } ^ :
  const cleaned = raw.replace(/[*"(){}^:]/g, ' ');
  // Split into tokens, wrap each in quotes for literal matching
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(' ');
}

export class MemoryDatabase {
  readonly db: Database.Database;
  readonly vectorEnabled: boolean;

  // Prepared statements
  private stmtInsert: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtUpdate: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtSupersede: Database.Statement;
  private stmtSearchFts: Database.Statement;
  private stmtInsertVec: Database.Statement | null = null;
  private stmtDeleteVec: Database.Statement | null = null;
  private stmtSearchVec: Database.Statement | null = null;
  private stmtUpdateLastAccessed: Database.Statement;
  private stmtUpdateEvidence: Database.Statement;
  private txnUpdateLastAccessedBatch: (ids: string[]) => void;

  private constructor(db: Database.Database, vectorEnabled: boolean) {
    this.db = db;
    this.vectorEnabled = vectorEnabled;

    // ── Prepared statements ──
    this.stmtInsert = db.prepare(`
      INSERT INTO memories (
        id, agent_id, user_id, chat_id, workspace_dir,
        type, content, tags, metadata,
        confidence, confidence_level, evidence_count,
        valid_at, invalid_at, superseded_by, ttl,
        source_chat_id, source_message_id,
        created_at, updated_at, last_accessed_at
      ) VALUES (
        @id, @agent_id, @user_id, @chat_id, @workspace_dir,
        @type, @content, @tags, @metadata,
        @confidence, @confidence_level, @evidence_count,
        @valid_at, @invalid_at, @superseded_by, @ttl,
        @source_chat_id, @source_message_id,
        @created_at, @updated_at, @last_accessed_at
      )
    `);

    this.stmtGet = db.prepare('SELECT * FROM memories WHERE id = ?');

    this.stmtUpdate = db.prepare(`
      UPDATE memories SET
        content = @content, tags = @tags, metadata = @metadata,
        confidence = @confidence, confidence_level = @confidence_level,
        evidence_count = @evidence_count,
        invalid_at = @invalid_at, superseded_by = @superseded_by,
        updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtDelete = db.prepare('DELETE FROM memories WHERE id = ?');

    this.stmtSupersede = db.prepare(`
      UPDATE memories SET
        invalid_at = @invalid_at,
        superseded_by = @superseded_by,
        updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtSearchFts = db.prepare(`
      SELECT m.*, fts.rank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH @query
      ORDER BY fts.rank
      LIMIT @limit
    `);

    this.stmtUpdateLastAccessed = db.prepare(`
      UPDATE memories SET last_accessed_at = @last_accessed_at WHERE id = @id
    `);

    this.stmtUpdateEvidence = db.prepare(`
      UPDATE memories SET
        evidence_count = evidence_count + 1,
        updated_at = @updated_at
      WHERE id = @id
    `);

    // Batch update last_accessed_at in a single transaction
    this.txnUpdateLastAccessedBatch = db.transaction((ids: string[]) => {
      const now = new Date().toISOString();
      for (const id of ids) {
        this.stmtUpdateLastAccessed.run({ id, last_accessed_at: now });
      }
    });

    // vec0 statements (only if enabled)
    if (vectorEnabled) {
      this.stmtInsertVec = db.prepare(`
        INSERT INTO memories_vec (memory_id, embedding)
        VALUES (@memory_id, @embedding)
      `);
      this.stmtDeleteVec = db.prepare('DELETE FROM memories_vec WHERE memory_id = ?');
      this.stmtSearchVec = db.prepare(`
        SELECT memory_id, distance
        FROM memories_vec
        WHERE embedding MATCH @embedding
        ORDER BY distance
        LIMIT @limit
      `);
    }
  }

  /**
   * Async factory method: creates DB, loads sqlite-vec if possible,
   * sets up schema and returns MemoryDatabase instance.
   */
  static async create(dbPath: string, dimension: number = 1536): Promise<MemoryDatabase> {
    if (!Number.isInteger(dimension) || dimension <= 0 || dimension > 65536) {
      throw new Error(`Invalid embedding dimension: ${dimension}`);
    }

    dbPath = resolve(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Try loading sqlite-vec
    let vectorEnabled = false;
    try {
      const sqliteVec = await import('sqlite-vec');
      sqliteVec.load(db);
      vectorEnabled = true;
      logger.info('sqlite-vec loaded successfully');
    } catch (err) {
      logger.warn({ err }, 'sqlite-vec not available, falling back to BM25-only');
    }

    // ── Schema ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT,
        chat_id TEXT,
        workspace_dir TEXT,
        type TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'state', 'decision', 'relation')),
        content TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 1.0,
        confidence_level TEXT NOT NULL DEFAULT 'L0',
        evidence_count INTEGER NOT NULL DEFAULT 1,
        valid_at TEXT NOT NULL,
        invalid_at TEXT,
        superseded_by TEXT,
        ttl TEXT,
        source_chat_id TEXT,
        source_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT
      );

      -- FTS5 external content index
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, tags, content=memories, content_rowid=rowid
      );

      -- FTS5 sync triggers (critical: external content requires manual sync)
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags)
          VALUES (new.rowid, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
          VALUES('delete', old.rowid, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
          VALUES('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags)
          VALUES (new.rowid, new.content, new.tags);
      END;

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_memories_agent_user ON memories(agent_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(invalid_at);
      CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_dir);
    `);

    // vec0 virtual table (conditional, with cosine distance)
    if (vectorEnabled) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${dimension}] distance_metric=cosine
        );
      `);
    }

    // ── One-time data migrations (idempotent, guarded by user_version) ──
    runDataMigrations(db);

    logger.info({ dbPath, vectorEnabled }, 'Memory database initialized');
    return new MemoryDatabase(db, vectorEnabled);
  }

  // ── CRUD Operations ──

  insertMemory(row: MemoryRow): void {
    this.stmtInsert.run(this.rowToParams(row));
  }

  getMemory(id: string): MemoryRow | undefined {
    return this.stmtGet.get(id) as MemoryRow | undefined;
  }

  updateMemory(row: Partial<MemoryRow> & { id: string; updated_at: string }): void {
    const existing = this.getMemory(row.id);
    if (!existing) return;
    this.stmtUpdate.run({
      id: row.id,
      content: row.content ?? existing.content,
      tags: row.tags ?? existing.tags,
      metadata: row.metadata ?? existing.metadata,
      confidence: row.confidence ?? existing.confidence,
      confidence_level: row.confidence_level ?? existing.confidence_level,
      evidence_count: row.evidence_count ?? existing.evidence_count,
      invalid_at: 'invalid_at' in row ? row.invalid_at : existing.invalid_at,
      superseded_by: 'superseded_by' in row ? row.superseded_by : existing.superseded_by,
      updated_at: row.updated_at,
    });
  }

  deleteMemory(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }

  supersedeMemory(oldId: string, newId: string): void {
    const now = new Date().toISOString();
    this.stmtSupersede.run({
      id: oldId,
      invalid_at: now,
      superseded_by: newId,
      updated_at: now,
    });
  }

  updateLastAccessed(id: string): void {
    this.stmtUpdateLastAccessed.run({
      id,
      last_accessed_at: new Date().toISOString(),
    });
  }

  updateLastAccessedBatch(ids: string[]): void {
    if (ids.length === 0) return;
    this.txnUpdateLastAccessedBatch(ids);
  }

  updateEvidence(id: string): void {
    this.stmtUpdateEvidence.run({
      id,
      updated_at: new Date().toISOString(),
    });
  }

  // ── FTS5 Search ──

  searchFts(query: string, limit: number = 20): FtsResultRow[] {
    const sanitized = sanitizeFtsQuery(query);
    return this.stmtSearchFts.all({ query: sanitized, limit }) as FtsResultRow[];
  }

  // ── Vector Operations (conditional) ──

  insertVec(memoryId: string, embedding: Float32Array): void {
    if (!this.stmtInsertVec) return;
    this.stmtInsertVec.run({
      memory_id: memoryId,
      embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    });
  }

  deleteVec(memoryId: string): void {
    if (!this.stmtDeleteVec) return;
    this.stmtDeleteVec.run(memoryId);
  }

  searchVec(embedding: Float32Array, limit: number = 20): VecResultRow[] {
    if (!this.stmtSearchVec) return [];
    return this.stmtSearchVec.all({
      embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
      limit,
    }) as VecResultRow[];
  }

  // ── List & Count ──

  /**
   * List valid memories for an agent+user, with optional type filter and pagination.
   * Returns rows ordered by updated_at DESC and the total count.
   */
  listMemories(
    agentId: string,
    userId: string,
    opts?: { type?: MemoryType; limit?: number; offset?: number },
  ): { rows: MemoryRow[]; total: number } {
    const limit = opts?.limit ?? 10;
    const offset = opts?.offset ?? 0;

    const baseWhere = `
      (agent_id = @agentId OR agent_id = '*')
      AND (user_id = @userId OR user_id IS NULL)
      AND invalid_at IS NULL
    `;
    const typeClause = opts?.type ? ' AND type = @type' : '';
    const where = baseWhere + typeClause;

    const params: Record<string, unknown> = { agentId, userId, limit, offset };
    if (opts?.type) params.type = opts.type;

    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`,
    ).all(params) as MemoryRow[];

    const countRow = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM memories WHERE ${where}`,
    ).get(params) as { cnt: number };

    return { rows, total: countRow.cnt };
  }

  /**
   * Count valid memories grouped by type for an agent+user.
   * When ownedOnly=true, excludes shared memories (user_id IS NULL) — use for clear flow.
   */
  countByType(agentId: string, userId: string, opts?: { ownedOnly?: boolean }): Array<{ type: string; count: number }> {
    const userClause = opts?.ownedOnly
      ? 'AND user_id = @userId'
      : 'AND (user_id = @userId OR user_id IS NULL)';
    return this.db.prepare(`
      SELECT type, COUNT(*) AS count FROM memories
      WHERE (agent_id = @agentId OR agent_id = '*')
        ${userClause}
        AND invalid_at IS NULL
      GROUP BY type
    `).all({ agentId, userId }) as Array<{ type: string; count: number }>;
  }

  /**
   * Delete all valid memories for an agent+user. Returns IDs of deleted memories
   * so caller can also clean up vec0 entries.
   */
  deleteAllForUser(agentId: string, userId: string): string[] {
    // Only delete memories explicitly owned by this user (user_id = @userId).
    // Shared memories (user_id IS NULL) are NOT deleted — they belong to everyone.
    const rows = this.db.prepare(`
      SELECT id FROM memories
      WHERE (agent_id = @agentId OR agent_id = '*')
        AND user_id = @userId
        AND invalid_at IS NULL
    `).all({ agentId, userId }) as Array<{ id: string }>;

    const ids = rows.map(r => r.id);
    if (ids.length === 0) return [];

    // Delete in batches via transaction
    this.db.transaction(() => {
      for (const id of ids) {
        this.stmtDelete.run(id);
      }
    })();

    return ids;
  }

  // ── Helpers ──

  close(): void {
    this.db.close();
    logger.info('Memory database closed');
  }

  static rowToMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      agentId: row.agent_id,
      userId: row.user_id,
      chatId: row.chat_id,
      workspaceDir: row.workspace_dir,
      type: row.type as MemoryType,
      content: row.content,
      tags: JSON.parse(row.tags) as string[],
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      confidence: row.confidence,
      confidenceLevel: row.confidence_level as ConfidenceLevel,
      evidenceCount: row.evidence_count,
      validAt: row.valid_at,
      invalidAt: row.invalid_at,
      supersededBy: row.superseded_by,
      ttl: row.ttl,
      sourceChatId: row.source_chat_id,
      sourceMessageId: row.source_message_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
    };
  }

  private rowToParams(row: MemoryRow): Record<string, unknown> {
    return {
      id: row.id,
      agent_id: row.agent_id,
      user_id: row.user_id,
      chat_id: row.chat_id,
      workspace_dir: row.workspace_dir,
      type: row.type,
      content: row.content,
      tags: row.tags,
      metadata: row.metadata,
      confidence: row.confidence,
      confidence_level: row.confidence_level,
      evidence_count: row.evidence_count,
      valid_at: row.valid_at,
      invalid_at: row.invalid_at,
      superseded_by: row.superseded_by,
      ttl: row.ttl,
      source_chat_id: row.source_chat_id,
      source_message_id: row.source_message_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_accessed_at: row.last_accessed_at,
    };
  }
}

// ============================================================
// One-time data migrations
// ============================================================

/** Current migration version. Bump when adding new migrations. */
const CURRENT_MIGRATION_VERSION = 2;

/**
 * Run idempotent data migrations guarded by PRAGMA user_version.
 * Each migration block checks the version before running.
 */
function runDataMigrations(db: Database.Database): void {
  // PRAGMA user_version returns the version number directly
  const version = db.pragma('user_version', { simple: true }) as number;

  if (version >= CURRENT_MIGRATION_VERSION) return;

  logger.info({ from: version, to: CURRENT_MIGRATION_VERSION }, 'Running memory data migrations');

  db.transaction(() => {
    if (version < 1) {
      migrationV1_normalizeWorkspaceDirs(db);
      migrationV1_invalidateTransientMemories(db);
    }
    if (version < 2) {
      migrationV2_renameRepoUrl(db);
    }

    db.pragma(`user_version = ${CURRENT_MIGRATION_VERSION}`);
  })();

  logger.info('Memory data migrations completed');
}

/**
 * Migration v1: Normalize fragmented workspace_dir values.
 * Consolidates local paths that point to the same repo into canonical form.
 */
function migrationV1_normalizeWorkspaceDirs(db: Database.Database): void {
  // Known local paths → canonical repo identity
  const mappings: Array<[string, string]> = [
    ['/root/dev', 'github.com/lishuceo/anycode.git'],
    ['/root/dev/', 'github.com/lishuceo/anycode.git'],
    ['/root/dev/anywhere-code', 'github.com/lishuceo/anycode.git'],
  ];

  let totalUpdated = 0;

  for (const [oldDir, newDir] of mappings) {
    const result = db.prepare(
      'UPDATE memories SET workspace_dir = ? WHERE workspace_dir = ?',
    ).run(newDir, oldDir);
    totalUpdated += result.changes;
  }

  // .workspaces paths: /root/dev/.workspaces/anywhere-code-* → anywhere-code repo
  const wsResult = db.prepare(
    'UPDATE memories SET workspace_dir = ? WHERE workspace_dir LIKE ?',
  ).run('github.com/lishuceo/anycode.git', '/root/dev/.workspaces/anywhere-code-%');
  totalUpdated += wsResult.changes;

  if (totalUpdated > 0) {
    logger.info({ updated: totalUpdated }, 'Migration v1: normalized workspace_dir values');
  }
}

/**
 * Migration v2: Rename repo URL after GitHub repo rename (anywhere-code → anycode).
 */
function migrationV2_renameRepoUrl(db: Database.Database): void {
  const result = db.prepare(
    'UPDATE memories SET workspace_dir = ? WHERE workspace_dir = ?',
  ).run('github.com/lishuceo/anycode.git', 'github.com/lishuceo/anywhere-code.git');

  if (result.changes > 0) {
    logger.info({ updated: result.changes }, 'Migration v2: renamed repo URL anywhere-code → anycode');
  }
}

/**
 * Migration v1: Invalidate transient/ephemeral memories that should not have been stored.
 * Targets PR statuses, deployment statuses, and non-decision "fix plans".
 */
function migrationV1_invalidateTransientMemories(db: Database.Database): void {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE memories SET invalid_at = ?, updated_at = ?
    WHERE invalid_at IS NULL
      AND (
        content LIKE '%PR #%已合并%'
        OR content LIKE '%已提交并推送%'
        OR content LIKE '%已部署%'
        OR content LIKE '%已上线%'
        OR (type = 'decision' AND content LIKE '%修复方案%')
        OR (type = 'decision' AND content LIKE '确认无需%')
      )
  `).run(now, now);

  if (result.changes > 0) {
    logger.info({ invalidated: result.changes }, 'Migration v1: invalidated transient memories');
  }
}
