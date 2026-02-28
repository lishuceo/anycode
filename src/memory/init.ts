// ============================================================
// Memory System — Singleton Initializer
// ============================================================

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { MemoryDatabase } from './database.js';
import { MemoryStore } from './store.js';
import { HybridSearch } from './search.js';
import { DashScopeEmbeddingProvider, NoopEmbeddingProvider } from './embeddings.js';
import type { EmbeddingProvider } from './embeddings.js';

let memoryStore: MemoryStore | null = null;
let hybridSearch: HybridSearch | null = null;
let memoryDb: MemoryDatabase | null = null;
let embeddingProvider: EmbeddingProvider | null = null;
let initialized = false;

/**
 * Initialize the memory system. Idempotent — safe to call multiple times.
 * Must be called at startup before any memory operations.
 */
export async function initializeMemory(): Promise<void> {
  if (initialized) return;
  if (!config.memory.enabled) {
    logger.info('Memory system disabled');
    initialized = true;
    return;
  }

  const ep = config.memory.dashscopeApiKey
    ? new DashScopeEmbeddingProvider(
        config.memory.dashscopeApiKey,
        config.memory.dashscopeBaseUrl,
        config.memory.embeddingModel,
        config.memory.embeddingDimension,
      )
    : new NoopEmbeddingProvider(config.memory.embeddingDimension);

  embeddingProvider = ep;

  memoryDb = await MemoryDatabase.create(
    config.memory.dbPath,
    config.memory.embeddingDimension,
  );

  memoryStore = new MemoryStore(memoryDb, ep);
  hybridSearch = new HybridSearch(memoryDb, ep, config.memory.vectorWeight);

  initialized = true;
  logger.info({
    vectorEnabled: memoryDb.vectorEnabled,
    embeddingAvailable: ep.available,
  }, 'Memory system initialized');
}

export function getMemoryStore(): MemoryStore | null {
  return memoryStore;
}

export function getHybridSearch(): HybridSearch | null {
  return hybridSearch;
}

export function isMemoryEnabled(): boolean {
  return initialized && config.memory.enabled;
}

/**
 * Periodic maintenance: mark expired TTL states, clean very old low-confidence memories.
 */
export function runMemoryMaintenance(): void {
  if (!memoryDb || !memoryStore) return;
  try {
    // Use ISO 8601 format to match stored timestamps (new Date().toISOString())
    const now = new Date().toISOString();
    const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // Mark expired TTL states as invalid
    memoryDb.db.prepare(`
      UPDATE memories SET invalid_at = ?, updated_at = ?
      WHERE type = 'state' AND ttl IS NOT NULL AND ttl < ? AND invalid_at IS NULL
    `).run(now, now, now);

    // Clean very old low-confidence memories (via store to also clean vec0)
    const rows = memoryDb.db.prepare(`
      SELECT id FROM memories
      WHERE confidence < 0.1 AND created_at < ?
    `).all(cutoff90d) as Array<{ id: string }>;

    for (const row of rows) {
      memoryStore.delete(row.id);
    }
    if (rows.length > 0) {
      logger.info({ deleted: rows.length }, 'Memory maintenance: cleaned low-confidence memories');
    }
  } catch (err) {
    logger.warn({ err }, 'Memory maintenance failed');
  }
}

/** Close the memory database. Call during graceful shutdown. */
export function closeMemory(): void {
  if (memoryDb) {
    memoryDb.close();
    memoryDb = null;
  }
  memoryStore = null;
  hybridSearch = null;
  embeddingProvider = null;
  initialized = false;
}
