// ============================================================
// Memory System — Store (CRUD + two-phase write)
// ============================================================

import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { MemoryDatabase } from './database.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { Memory, MemoryCreateInput, MemoryType, ConfidenceLevel } from './types.js';
import { CONFIDENCE_CAPS } from './types.js';
import type { MemoryRow } from './database.js';

/** Max content length (characters) */
const MAX_CONTENT_LENGTH = 100_000;
/** Max number of tags per memory */
const MAX_TAGS = 50;
/** Max metadata JSON size (bytes) */
const MAX_METADATA_SIZE = 50_000;

function generateMemoryId(): string {
  return `mem_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

/** Clamp confidence to the level cap */
function clampConfidence(confidence: number, level: ConfidenceLevel): number {
  const cap = CONFIDENCE_CAPS[level];
  return Math.min(Math.max(confidence, 0), cap);
}

export class MemoryStore {
  private readonly db: MemoryDatabase;
  private readonly embeddingProvider: EmbeddingProvider;
  private pendingEmbeddings: Promise<void>[] = [];

  constructor(db: MemoryDatabase, embeddingProvider: EmbeddingProvider) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * Create a memory with two-phase write:
   * Phase 1 (sync): INSERT into main table → FTS5 trigger syncs automatically
   * Phase 2 (async fire-and-forget): embed content → INSERT into vec0
   */
  create(input: MemoryCreateInput): Memory {
    // Input validation
    if (!input.content.trim()) {
      throw new Error('Memory content cannot be empty');
    }
    if (input.content.length > MAX_CONTENT_LENGTH) {
      throw new Error(`Memory content exceeds max length (${MAX_CONTENT_LENGTH})`);
    }
    if (input.tags && input.tags.length > MAX_TAGS) {
      throw new Error(`Too many tags (max ${MAX_TAGS})`);
    }
    const metadataStr = JSON.stringify(input.metadata ?? {});
    if (metadataStr.length > MAX_METADATA_SIZE) {
      throw new Error(`Metadata too large (max ${MAX_METADATA_SIZE} bytes)`);
    }

    const id = generateMemoryId();
    const now = new Date().toISOString();
    const level = input.confidenceLevel ?? 'L0';
    const confidence = clampConfidence(input.confidence ?? CONFIDENCE_CAPS[level], level);

    const row: MemoryRow = {
      id,
      agent_id: input.agentId,
      user_id: input.userId ?? null,
      chat_id: input.chatId ?? null,
      workspace_dir: input.workspaceDir ?? null,
      type: input.type,
      content: input.content,
      tags: JSON.stringify(input.tags ?? []),
      metadata: metadataStr,
      confidence,
      confidence_level: level,
      evidence_count: 1,
      valid_at: now,
      invalid_at: null,
      superseded_by: null,
      ttl: input.ttl ?? null,
      source_chat_id: input.sourceChatId ?? null,
      source_message_id: input.sourceMessageId ?? null,
      created_at: now,
      updated_at: now,
      last_accessed_at: null,
    };

    // Phase 1: synchronous write (main table + FTS5 via trigger)
    this.db.insertMemory(row);

    // Phase 2: async embedding + vec0 (fire-and-forget)
    if (this.embeddingProvider.available && this.db.vectorEnabled) {
      const p = this.embedAndStore(id, input.content).catch((err) => {
        logger.warn({ err, memoryId: id }, 'Failed to embed memory (non-blocking)');
      });
      this.pendingEmbeddings.push(p);
      p.finally(() => {
        this.pendingEmbeddings = this.pendingEmbeddings.filter((x) => x !== p);
      });
    }

    return MemoryDatabase.rowToMemory(row);
  }

  /**
   * Supersede an old memory with a new one.
   * Marks the old memory as invalid and links to the new one.
   */
  supersede(oldId: string, newInput: MemoryCreateInput): Memory {
    const newMemory = this.create(newInput);
    this.db.supersedeMemory(oldId, newMemory.id);

    // Clean up old vector
    if (this.db.vectorEnabled) {
      this.db.deleteVec(oldId);
    }

    return newMemory;
  }

  /** Get a memory by ID */
  get(id: string): Memory | undefined {
    const row = this.db.getMemory(id);
    if (!row) return undefined;
    return MemoryDatabase.rowToMemory(row);
  }

  /** Delete a memory by ID */
  delete(id: string): boolean {
    if (this.db.vectorEnabled) {
      this.db.deleteVec(id);
    }
    return this.db.deleteMemory(id);
  }

  /** Increment evidence count for a memory */
  updateEvidence(id: string): void {
    this.db.updateEvidence(id);
  }

  /**
   * Find potentially conflicting memories via vector similarity.
   * Only works when vector search is available.
   * Returns memories with similarity > 0.85 (distance < 0.15 for cosine).
   */
  async findConflicting(
    content: string,
    type: string,
    agentId: string,
  ): Promise<Memory[]> {
    if (!this.embeddingProvider.available || !this.db.vectorEnabled) {
      return [];
    }

    try {
      const embedding = await this.embeddingProvider.embed(content);
      const vecResults = this.db.searchVec(new Float32Array(embedding), 20);

      const conflicts: Memory[] = [];
      for (const vr of vecResults) {
        // cosine distance < 0.15 ≈ similarity > 0.85
        if (vr.distance >= 0.15) continue;
        const row = this.db.getMemory(vr.memory_id);
        if (!row) continue;
        if (row.type !== type) continue;
        if (row.agent_id !== agentId) continue;
        if (row.invalid_at !== null) continue;
        conflicts.push(MemoryDatabase.rowToMemory(row));
      }
      return conflicts;
    } catch (err) {
      logger.warn({ err }, 'findConflicting failed');
      return [];
    }
  }

  /**
   * List valid memories for an agent+user, with optional type filter and pagination.
   */
  list(
    agentId: string,
    userId: string,
    opts?: { type?: MemoryType; limit?: number; offset?: number },
  ): { memories: Memory[]; total: number } {
    const { rows, total } = this.db.listMemories(agentId, userId, opts);
    return { memories: rows.map(MemoryDatabase.rowToMemory), total };
  }

  /**
   * Count valid memories by type for an agent+user.
   * Returns a Record mapping type → count.
   */
  countByType(agentId: string, userId: string): Record<string, number> {
    const rows = this.db.countByType(agentId, userId);
    const result: Record<string, number> = {};
    for (const r of rows) {
      result[r.type] = r.count;
    }
    return result;
  }

  /**
   * Delete all valid memories for an agent+user.
   * Also cleans up vec0 entries.
   */
  deleteAll(agentId: string, userId: string): number {
    const ids = this.db.deleteAllForUser(agentId, userId);
    if (this.db.vectorEnabled) {
      for (const id of ids) {
        this.db.deleteVec(id);
      }
    }
    return ids.length;
  }

  /** Wait for all pending async embedding operations to complete */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingEmbeddings);
  }

  private async embedAndStore(memoryId: string, content: string): Promise<void> {
    const embedding = await this.embeddingProvider.embed(content);
    // Verify memory still exists before inserting vector (avoid orphans)
    if (!this.db.getMemory(memoryId)) return;
    this.db.insertVec(memoryId, new Float32Array(embedding));
  }
}
