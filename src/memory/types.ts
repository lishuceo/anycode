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

/**
 * Memory scope classification.
 * - user: cross-project (preference, personal facts about people)
 * - repository: bound to a specific repo's canonical URL (project facts/decisions/relations)
 * - chat: short-lived state bound to a single chat
 */
export type MemoryScope = 'user' | 'repository' | 'chat';

/** Types that MUST carry repository attribution (otherwise rejected at extraction). */
export const PROJECT_SCOPED_TYPES: ReadonlySet<MemoryType> = new Set(['fact', 'decision', 'relation']);

/** Types that are user-scoped — visible across all repos for the same user. */
export const USER_SCOPED_TYPES: ReadonlySet<MemoryType> = new Set(['preference']);

/** Types that are chat-scoped — only visible within the originating chat. */
export const CHAT_SCOPED_TYPES: ReadonlySet<MemoryType> = new Set(['state']);

/** Full memory record as stored in the database */
export interface Memory {
  id: string;
  agentId: string;
  userId: string | null;
  chatId: string | null;
  workspaceDir: string | null;
  /**
   * Canonical repository URL the memory belongs to (e.g. https://github.com/taptap/maker).
   * - null for user-scoped (preference) and chat-scoped (state) memories
   * - null for legacy memories created before migration v3 — treated as "unattributed"
   *   and filtered out for PROJECT_SCOPED_TYPES to prevent cross-repo pollution
   */
  repository: string | null;

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
  /** Canonical repository URL — see Memory.repository. */
  repository?: string | null;

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
  /**
   * Current repository canonical URL (the cwd the caller is operating in).
   * When provided, PROJECT_SCOPED_TYPES memories whose repository ≠ this value
   * (or whose repository is null) are filtered out — preventing cross-repo pollution.
   * User-scoped (preference) memories always pass; chat-scoped (state) uses chatId instead.
   */
  repository?: string | null;
  /**
   * Current chat ID. When provided, CHAT_SCOPED_TYPES memories whose chatId ≠ this
   * are filtered out. Project/user-scoped memories are NOT chatId-filtered.
   */
  chatId?: string | null;
  types?: MemoryType[];
  limit?: number;
  includeInvalid?: boolean;
}

/** Compute the scope of a memory based on its type and attribution. */
export function getMemoryScope(type: MemoryType): MemoryScope {
  if (PROJECT_SCOPED_TYPES.has(type)) return 'repository';
  if (CHAT_SCOPED_TYPES.has(type)) return 'chat';
  return 'user';
}

/** Page size for /memory list pagination */
export const MEMORY_PAGE_SIZE = 5;
