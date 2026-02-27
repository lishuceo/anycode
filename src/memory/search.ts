// ============================================================
// Memory System — Hybrid Search + Scoring
// ============================================================

import { logger } from '../utils/logger.js';
import { MemoryDatabase } from './database.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { MemoryType, Memory, MemorySearchResult, MemorySearchQuery } from './types.js';

/** Type-aware boosting weights */
const TYPE_BOOST: Record<MemoryType, number> = {
  fact: 1.0,
  preference: 0.8,
  state: 0.6,
  decision: 0.9,
  relation: 0.7,
};

/** Exponential decay rates (λ) per type */
const DECAY_RATE: Record<MemoryType, number> = {
  fact: 0.005,       // ~139 day half-life
  preference: 0.01,  // ~69 day half-life
  state: 0.1,        // ~7 day half-life
  decision: 0.002,   // ~347 day half-life
  relation: 0.003,   // ~231 day half-life
};

/** Max allowed search limit to prevent resource exhaustion */
const MAX_SEARCH_LIMIT = 100;

function computeRecencyDecay(type: MemoryType, daysSinceCreated: number): number {
  return Math.exp(-DECAY_RATE[type] * daysSinceCreated);
}

function daysBetween(dateStr: string, now: Date): number {
  const d = new Date(dateStr);
  return Math.max(0, (now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
}

/** Normalize BM25 rank to 0~1 score (rank is negative, lower = better match) */
function normalizeBm25Rank(rank: number): number {
  // FTS5 rank is negative; closer to 0 = worse match
  // Typical range: -20 to 0. We normalize using sigmoid-like mapping.
  return 1 / (1 + Math.exp(rank));
}

export class HybridSearch {
  private readonly db: MemoryDatabase;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly vectorWeight: number;

  constructor(
    db: MemoryDatabase,
    embeddingProvider: EmbeddingProvider,
    vectorWeight: number = 0.7,
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorWeight = vectorWeight;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const limit = Math.min(query.limit ?? 10, MAX_SEARCH_LIMIT);
    const now = new Date();
    const candidateLimit = Math.max(limit * 10, 200);

    // Determine effective weights
    const useVector = this.embeddingProvider.available && this.db.vectorEnabled;
    const vw = useVector ? this.vectorWeight : 0;
    const tw = useVector ? 1 - this.vectorWeight : 1.0;

    // ── Step 1: BM25 search (always) ──
    const bm25Map = new Map<string, { memory: Memory; bm25Score: number }>();
    try {
      // FTS5 query is sanitized inside searchFts()
      const ftsResults = this.db.searchFts(query.query, candidateLimit);
      for (const row of ftsResults) {
        const memory = MemoryDatabase.rowToMemory(row);
        bm25Map.set(memory.id, {
          memory,
          bm25Score: normalizeBm25Rank(row.rank),
        });
      }
    } catch (err) {
      logger.warn({ err, query: query.query }, 'FTS5 search failed, skipping BM25 results');
    }

    // ── Step 2: Vector search (if available) ──
    const vecMap = new Map<string, number>();
    if (useVector) {
      try {
        const embedding = await this.embeddingProvider.embed(query.query);
        const vecResults = this.db.searchVec(new Float32Array(embedding), candidateLimit);
        for (const vr of vecResults) {
          // Convert cosine distance to similarity score (0~1)
          vecMap.set(vr.memory_id, Math.max(0, 1 - vr.distance));
        }
      } catch (err) {
        logger.warn({ err }, 'Vector search failed, continuing with BM25 only');
      }
    }

    // ── Step 3: Union candidates ──
    const allIds = new Set([...bm25Map.keys(), ...vecMap.keys()]);
    const candidates: MemorySearchResult[] = [];

    for (const id of allIds) {
      const bm25Entry = bm25Map.get(id);
      let memory: Memory;

      if (bm25Entry) {
        memory = bm25Entry.memory;
      } else {
        // From vector-only results: fetch full record
        const row = this.db.getMemory(id);
        if (!row) continue;
        memory = MemoryDatabase.rowToMemory(row);
      }

      // ── Step 4: Apply lifecycle filters ──
      if (!query.includeInvalid && memory.invalidAt !== null) continue;
      if (memory.ttl && new Date(memory.ttl) < now) continue;

      // Agent isolation
      if (memory.agentId !== query.agentId && memory.agentId !== '*') continue;

      // User isolation
      if (query.userId && memory.userId !== null && memory.userId !== query.userId) continue;

      // Workspace isolation
      if (query.workspaceDir && memory.workspaceDir !== null && memory.workspaceDir !== query.workspaceDir) continue;

      // Type filter
      if (query.types && query.types.length > 0 && !query.types.includes(memory.type)) continue;

      // ── Step 5: Score fusion ──
      const bm25Score = bm25Entry?.bm25Score ?? 0;
      const vectorScore = vecMap.get(id) ?? 0;
      const searchScore = vw * vectorScore + tw * bm25Score;
      const typeBoost = TYPE_BOOST[memory.type];
      const recencyDecay = computeRecencyDecay(memory.type, daysBetween(memory.createdAt, now));
      const finalScore = searchScore * typeBoost * recencyDecay * memory.confidence;

      candidates.push({
        memory,
        vectorScore,
        bm25Score,
        typeBoost,
        recencyDecay,
        finalScore,
      });
    }

    // ── Step 6: Sort + top-N ──
    candidates.sort((a, b) => b.finalScore - a.finalScore);
    const results = candidates.slice(0, limit);

    // Update last_accessed_at in a single transaction
    this.db.updateLastAccessedBatch(results.map((r) => r.memory.id));

    return results;
  }
}
