// ============================================================
// Memory System — Core Types
// ============================================================

/** Five distinct memory types with different lifecycle strategies */
export type MemoryType = 'fact' | 'preference' | 'state' | 'decision' | 'relation';

/**
 * Confidence level tiers (anti-prompt-injection):
 * - L0: auto-extracted, max confidence 0.7
 * - L1: user-confirmed, max confidence 0.9
 * - L2: manually created, max confidence 1.0
 */
export type ConfidenceLevel = 'L0' | 'L1' | 'L2';

/** Max confidence per level */
export const CONFIDENCE_CAPS: Record<ConfidenceLevel, number> = {
  L0: 0.7,
  L1: 0.9,
  L2: 1.0,
};

/** Full memory record as stored in the database */
export interface Memory {
  id: string;
  agentId: string;
  userId: string | null;
  chatId: string | null;
  workspaceDir: string | null;

  type: MemoryType;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;

  confidence: number;
  confidenceLevel: ConfidenceLevel;
  evidenceCount: number;

  validAt: string;
  invalidAt: string | null;
  supersededBy: string | null;
  ttl: string | null;

  sourceChatId: string | null;
  sourceMessageId: string | null;

  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

/** Input for creating a new memory */
export interface MemoryCreateInput {
  agentId: string;
  userId?: string | null;
  chatId?: string | null;
  workspaceDir?: string | null;

  type: MemoryType;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;

  confidence?: number;
  confidenceLevel?: ConfidenceLevel;

  ttl?: string | null;

  sourceChatId?: string | null;
  sourceMessageId?: string | null;
}

/** Search result with scoring details */
export interface MemorySearchResult {
  memory: Memory;
  vectorScore: number;
  bm25Score: number;
  typeBoost: number;
  recencyDecay: number;
  finalScore: number;
}

/** Parameters for searching memories */
export interface MemorySearchQuery {
  query: string;
  agentId: string;
  userId?: string | null;
  workspaceDir?: string | null;
  types?: MemoryType[];
  limit?: number;
  includeInvalid?: boolean;
}

/** Page size for /memory list pagination */
export const MEMORY_PAGE_SIZE = 5;
