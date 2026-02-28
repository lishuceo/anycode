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
