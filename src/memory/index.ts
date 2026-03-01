// ============================================================
// Memory System — Public API
// ============================================================

export { MemoryDatabase, sanitizeFtsQuery } from './database.js';
export type { MemoryRow, FtsResultRow, VecResultRow } from './database.js';

export { MemoryStore } from './store.js';

export { HybridSearch } from './search.js';

export { DashScopeEmbeddingProvider, NoopEmbeddingProvider } from './embeddings.js';
export type { EmbeddingProvider } from './embeddings.js';

export type {
  MemoryType,
  ConfidenceLevel,
  Memory,
  MemoryCreateInput,
  MemorySearchResult,
  MemorySearchQuery,
} from './types.js';
export { CONFIDENCE_CAPS } from './types.js';

export {
  initializeMemory, closeMemory, getMemoryStore, getHybridSearch,
  isMemoryEnabled, runMemoryMaintenance,
} from './init.js';

export { extractMemories } from './extractor.js';
export type { ExtractionContext } from './extractor.js';

export { injectMemories } from './injector.js';
export type { InjectionContext } from './injector.js';

export { handleMemoryCommand, handleMemoryCardAction } from './commands.js';
