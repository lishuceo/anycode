import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { MemoryDatabase } from '../database.js';
import { MemoryStore } from '../store.js';
import { HybridSearch } from '../search.js';
import { NoopEmbeddingProvider } from '../embeddings.js';
import type { MemoryCreateInput } from '../types.js';

function makeInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    agentId: 'agent1',
    userId: 'user1',
    type: 'fact',
    content: 'Test content',
    confidenceLevel: 'L2',
    confidence: 1.0,
    ...overrides,
  };
}

describe('HybridSearch', () => {
  let db: MemoryDatabase;
  let store: MemoryStore;
  let search: HybridSearch;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-search-test-'));
    db = await MemoryDatabase.create(join(tempDir, 'test.db'));
    const noop = new NoopEmbeddingProvider();
    store = new MemoryStore(db, noop);
    search = new HybridSearch(db, noop, 0.7);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('BM25-only search', () => {
    it('should return results via BM25 when no vector is available', async () => {
      store.create(makeInput({ content: 'PostgreSQL is the primary database' }));
      store.create(makeInput({ content: 'Redis is used for caching' }));

      const results = await search.search({
        query: 'PostgreSQL',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.content).toContain('PostgreSQL');
    });

    it('should return empty results for unmatched query', async () => {
      store.create(makeInput({ content: 'TypeScript is preferred' }));

      const results = await search.search({
        query: 'Kubernetes',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results).toHaveLength(0);
    });

    it('should set vectorScore to 0 in BM25-only mode', async () => {
      store.create(makeInput({ content: 'pnpm package manager' }));

      const results = await search.search({
        query: 'pnpm',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].vectorScore).toBe(0);
      expect(results[0].bm25Score).toBeGreaterThan(0);
    });
  });

  describe('score fusion', () => {
    it('should apply type boost', async () => {
      store.create(makeInput({ content: 'Express version 4 is used', type: 'fact' }));
      store.create(makeInput({ content: 'Express routing patterns', type: 'state' }));

      const results = await search.search({
        query: 'Express',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results.length).toBe(2);
      // Fact (boost=1.0) should score higher than state (boost=0.6) with same BM25
      expect(results[0].typeBoost).toBeGreaterThanOrEqual(results[1].typeBoost);
    });

    it('should include recency decay in scoring', async () => {
      const mem = store.create(makeInput({ content: 'recent and old test data' }));

      const results = await search.search({
        query: 'recent',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results.length).toBeGreaterThan(0);
      // Just-created memory should have recency decay close to 1.0
      expect(results[0].recencyDecay).toBeGreaterThan(0.99);
    });

    it('should factor in confidence', async () => {
      store.create(makeInput({
        content: 'high confidence assertion',
        confidence: 1.0,
        confidenceLevel: 'L2',
      }));
      store.create(makeInput({
        content: 'low confidence assertion guess',
        confidence: 0.3,
        confidenceLevel: 'L0',
      }));

      const results = await search.search({
        query: 'assertion',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results.length).toBe(2);
      // High confidence should rank higher
      expect(results[0].memory.confidence).toBeGreaterThan(results[1].memory.confidence);
    });
  });

  describe('lifecycle filters', () => {
    it('should exclude invalidated memories by default', async () => {
      const old = store.create(makeInput({ content: 'Node version 16 deprecated' }));
      store.supersede(old.id, makeInput({ content: 'Node version 20 current' }));

      const results = await search.search({
        query: 'Node version',
        agentId: 'agent1',
        userId: 'user1',
      });

      // Only the new memory should appear
      expect(results.every((r) => r.memory.invalidAt === null)).toBe(true);
      expect(results.some((r) => r.memory.content.includes('20'))).toBe(true);
    });

    it('should include invalidated memories when requested', async () => {
      const old = store.create(makeInput({ content: 'Python 2 was used' }));
      store.supersede(old.id, makeInput({ content: 'Python 3 is current' }));

      const results = await search.search({
        query: 'Python',
        agentId: 'agent1',
        userId: 'user1',
        includeInvalid: true,
      });

      expect(results.length).toBe(2);
    });

    it('should exclude TTL-expired memories', async () => {
      // Create a memory with TTL in the past
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      store.create(makeInput({
        content: 'expired temporary state info',
        type: 'state',
        ttl: pastDate,
      }));

      const results = await search.search({
        query: 'expired temporary',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results).toHaveLength(0);
    });

    it('should include memories with future TTL', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      store.create(makeInput({
        content: 'active temporary state info',
        type: 'state',
        ttl: futureDate,
      }));

      const results = await search.search({
        query: 'active temporary',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results).toHaveLength(1);
    });
  });

  describe('agent/workspace isolation', () => {
    it('should not return memories from another agent', async () => {
      store.create(makeInput({ content: 'agent1 secret config', agentId: 'agent1' }));
      store.create(makeInput({ content: 'agent2 secret config', agentId: 'agent2' }));

      const results = await search.search({
        query: 'secret config',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results.every((r) => r.memory.agentId === 'agent1')).toBe(true);
    });

    it('should include global memories (agentId = *)', async () => {
      store.create(makeInput({ content: 'global coding standard rule', agentId: '*' }));
      store.create(makeInput({ content: 'local agent1 standard rule', agentId: 'agent1' }));

      const results = await search.search({
        query: 'standard rule',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results.length).toBe(2);
    });

    it('should filter by workspace when specified', async () => {
      store.create(makeInput({
        content: 'workspace A settings info',
        workspaceDir: '/projects/repo-a',
      }));
      store.create(makeInput({
        content: 'workspace B settings info',
        workspaceDir: '/projects/repo-b',
      }));

      const results = await search.search({
        query: 'settings',
        agentId: 'agent1',
        userId: 'user1',
        workspaceDir: '/projects/repo-a',
      });

      expect(results.every((r) => r.memory.workspaceDir === '/projects/repo-a')).toBe(true);
    });

    it('should include memories with null workspace (cross-workspace)', async () => {
      store.create(makeInput({
        content: 'cross workspace preference fact',
        workspaceDir: null,
      }));
      store.create(makeInput({
        content: 'specific workspace preference fact',
        workspaceDir: '/projects/specific',
      }));

      const results = await search.search({
        query: 'preference fact',
        agentId: 'agent1',
        userId: 'user1',
        workspaceDir: '/projects/specific',
      });

      // Both should match: null workspace is cross-workspace
      expect(results.length).toBe(2);
    });
  });

  describe('recency decay', () => {
    it('should rank newer memories higher than older ones', async () => {
      // Create an "old" memory by backdating
      const oldMem = store.create(makeInput({ content: 'ancient memory about testing' }));
      const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      db.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(oldDate, oldMem.id);

      // Create a "new" memory
      store.create(makeInput({ content: 'fresh memory about testing' }));

      const results = await search.search({
        query: 'memory about testing',
        agentId: 'agent1',
        userId: 'user1',
      });

      expect(results.length).toBe(2);
      // Newer should have higher recency decay
      expect(results[0].recencyDecay).toBeGreaterThan(results[1].recencyDecay);
    });
  });

  describe('type filter', () => {
    it('should filter by memory type', async () => {
      store.create(makeInput({ content: 'TypeScript fact info', type: 'fact' }));
      store.create(makeInput({ content: 'TypeScript preference info', type: 'preference' }));
      store.create(makeInput({ content: 'TypeScript decision info', type: 'decision' }));

      const results = await search.search({
        query: 'TypeScript',
        agentId: 'agent1',
        userId: 'user1',
        types: ['fact', 'decision'],
      });

      expect(results.every((r) => r.memory.type === 'fact' || r.memory.type === 'decision')).toBe(true);
    });
  });

  describe('limit', () => {
    it('should respect the limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        store.create(makeInput({ content: `memory number ${i} about databases` }));
      }

      const results = await search.search({
        query: 'databases',
        agentId: 'agent1',
        userId: 'user1',
        limit: 3,
      });

      expect(results.length).toBeLessThanOrEqual(3);
    });
  });
});
