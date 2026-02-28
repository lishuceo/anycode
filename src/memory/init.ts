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
  if (!memoryDb) return;
  try {
    memoryDb.db.exec(`
      UPDATE memories SET invalid_at = datetime('now'), updated_at = datetime('now')
      WHERE type = 'state' AND ttl IS NOT NULL AND ttl < datetime('now') AND invalid_at IS NULL
    `);
    const result = memoryDb.db.prepare(`
      DELETE FROM memories
      WHERE confidence < 0.1
      AND created_at < datetime('now', '-90 days')
    `).run();
    if (result.changes > 0) {
      logger.info({ deleted: result.changes }, 'Memory maintenance: cleaned low-confidence memories');
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
