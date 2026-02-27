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
