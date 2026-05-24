import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockConfig } = vi.hoisted(() => {
  const mockConfig = {
    memory: {
      scopeFilteringEnabled: true,
      strictRepositoryFiltering: false,
      maxInjectTokens: 4000,
    },
  };
  return { mockConfig };
});
vi.mock('../../config.js', () => ({ config: mockConfig }));

import { MemoryDatabase } from '../database.js';
import { MemoryStore } from '../store.js';
import { HybridSearch } from '../search.js';
import { NoopEmbeddingProvider } from '../embeddings.js';
import type { MemoryCreateInput } from '../types.js';

const REPO_A = 'https://github.com/taptap/maker';
const REPO_B = 'https://github.com/lishuceo/anycode';

function input(overrides: Partial<MemoryCreateInput>): MemoryCreateInput {
  return {
    agentId: 'agent1',
    userId: 'user1',
    type: 'fact',
    content: 'placeholder',
    confidenceLevel: 'L2',
    confidence: 1.0,
    ...overrides,
  };
}

describe('HybridSearch — repository scope filtering (plan-9)', () => {
  let db: MemoryDatabase;
  let store: MemoryStore;
  let search: HybridSearch;
  let tempDir: string;

  beforeEach(async () => {
    mockConfig.memory.scopeFilteringEnabled = true;
    mockConfig.memory.strictRepositoryFiltering = false;

    tempDir = mkdtempSync(join(tmpdir(), 'scope-filter-test-'));
    db = await MemoryDatabase.create(join(tempDir, 'test.db'));
    const noop = new NoopEmbeddingProvider();
    store = new MemoryStore(db, noop);
    search = new HybridSearch(db, noop, 0.7);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('hides project facts belonging to other repositories', async () => {
    store.create(input({ type: 'fact', content: 'maker uses dual bare repo architecture', repository: REPO_A }));
    store.create(input({ type: 'fact', content: 'anycode uses SQLite for sessions', repository: REPO_B }));

    // Query while in repo B — should NOT see the maker fact
    const inB = await search.search({
      query: 'architecture',
      agentId: 'agent1',
      userId: 'user1',
      repository: REPO_B,
    });
    expect(inB.find((r) => r.memory.content.includes('dual bare repo'))).toBeUndefined();

    // Query while in repo A — DOES see it
    const inA = await search.search({
      query: 'architecture',
      agentId: 'agent1',
      userId: 'user1',
      repository: REPO_A,
    });
    expect(inA.find((r) => r.memory.content.includes('dual bare repo'))).toBeDefined();
  });

  it('shows preferences across all repositories', async () => {
    store.create(input({ type: 'preference', content: 'user prefers terse replies', repository: null }));

    const inA = await search.search({
      query: 'terse',
      agentId: 'agent1',
      userId: 'user1',
      repository: REPO_A,
    });
    expect(inA.length).toBeGreaterThan(0);

    const inB = await search.search({
      query: 'terse',
      agentId: 'agent1',
      userId: 'user1',
      repository: REPO_B,
    });
    expect(inB.length).toBeGreaterThan(0);
  });

  it('state memories are filtered by chatId', async () => {
    store.create(input({ type: 'state', content: 'currently researching memory system', chatId: 'chat-X', ttl: '2099-01-01T00:00:00Z' }));

    const sameChat = await search.search({
      query: 'researching',
      agentId: 'agent1',
      userId: 'user1',
      chatId: 'chat-X',
    });
    expect(sameChat.length).toBeGreaterThan(0);

    const otherChat = await search.search({
      query: 'researching',
      agentId: 'agent1',
      userId: 'user1',
      chatId: 'chat-Y',
    });
    expect(otherChat.length).toBe(0);
  });

  it('compat mode (default) keeps legacy repository=null facts visible', async () => {
    store.create(input({ type: 'fact', content: 'legacy unattributed fact', repository: null }));

    const results = await search.search({
      query: 'legacy',
      agentId: 'agent1',
      userId: 'user1',
      repository: REPO_A,
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it('strict mode hides repository=null facts when query has a current repo', async () => {
    mockConfig.memory.strictRepositoryFiltering = true;

    store.create(input({ type: 'fact', content: 'legacy unattributed fact', repository: null }));
    store.create(input({ type: 'fact', content: 'properly attributed fact', repository: REPO_A }));

    const results = await search.search({
      query: 'fact',
      agentId: 'agent1',
      userId: 'user1',
      repository: REPO_A,
    });
    expect(results.find((r) => r.memory.content.includes('legacy'))).toBeUndefined();
    expect(results.find((r) => r.memory.content.includes('properly'))).toBeDefined();
  });

  it('with no current repo, only unattached project facts are visible', async () => {
    store.create(input({ type: 'fact', content: 'maker fact', repository: REPO_A }));
    store.create(input({ type: 'fact', content: 'unattached fact', repository: null }));

    const results = await search.search({
      query: 'fact',
      agentId: 'agent1',
      userId: 'user1',
      // no repository
    });
    expect(results.find((r) => r.memory.content.includes('maker'))).toBeUndefined();
    expect(results.find((r) => r.memory.content.includes('unattached'))).toBeDefined();
  });

  it('feature flag off restores legacy behavior (no repo filtering)', async () => {
    mockConfig.memory.scopeFilteringEnabled = false;

    store.create(input({ type: 'fact', content: 'maker fact', repository: REPO_A }));

    const results = await search.search({
      query: 'maker',
      agentId: 'agent1',
      userId: 'user1',
      repository: REPO_B,
    });
    expect(results.length).toBeGreaterThan(0);
  });
});
