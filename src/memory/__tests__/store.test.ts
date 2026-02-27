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
import { NoopEmbeddingProvider } from '../embeddings.js';
import type { EmbeddingProvider } from '../embeddings.js';
import type { MemoryCreateInput } from '../types.js';

function makeInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    agentId: 'agent1',
    userId: 'user1',
    type: 'fact',
    content: 'Test content',
    ...overrides,
  };
}

describe('MemoryStore', () => {
  let db: MemoryDatabase;
  let store: MemoryStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-store-test-'));
    db = await MemoryDatabase.create(join(tempDir, 'test.db'));
    const noop = new NoopEmbeddingProvider();
    store = new MemoryStore(db, noop);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('create()', () => {
    it('should create a memory and return it', () => {
      const memory = store.create(makeInput({ content: 'pnpm is preferred' }));
      expect(memory).toBeDefined();
      expect(memory.id).toMatch(/^mem_/);
      expect(memory.content).toBe('pnpm is preferred');
      expect(memory.agentId).toBe('agent1');
      expect(memory.type).toBe('fact');
    });

    it('should be searchable via FTS5 immediately after create', () => {
      store.create(makeInput({ content: 'Node version is 20' }));

      const ftsResults = db.searchFts('Node', 10);
      expect(ftsResults.length).toBeGreaterThan(0);
      expect(ftsResults.some((r) => r.content === 'Node version is 20')).toBe(true);
    });

    it('should set default confidence level to L0', () => {
      const memory = store.create(makeInput());
      expect(memory.confidenceLevel).toBe('L0');
    });

    it('should generate unique IDs', () => {
      const m1 = store.create(makeInput());
      const m2 = store.create(makeInput());
      expect(m1.id).not.toBe(m2.id);
    });
  });

  describe('input validation', () => {
    it('should reject empty content', () => {
      expect(() => store.create(makeInput({ content: '' }))).toThrow('cannot be empty');
    });

    it('should reject whitespace-only content', () => {
      expect(() => store.create(makeInput({ content: '   ' }))).toThrow('cannot be empty');
    });

    it('should reject content exceeding max length', () => {
      const longContent = 'x'.repeat(100_001);
      expect(() => store.create(makeInput({ content: longContent }))).toThrow('max length');
    });

    it('should reject too many tags', () => {
      const tags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
      expect(() => store.create(makeInput({ tags }))).toThrow('Too many tags');
    });
  });

  describe('confidence level caps', () => {
    it('should cap L0 confidence at 0.7', () => {
      const memory = store.create(makeInput({
        confidence: 1.0,
        confidenceLevel: 'L0',
      }));
      expect(memory.confidence).toBe(0.7);
    });

    it('should cap L1 confidence at 0.9', () => {
      const memory = store.create(makeInput({
        confidence: 1.0,
        confidenceLevel: 'L1',
      }));
      expect(memory.confidence).toBe(0.9);
    });

    it('should allow L2 confidence up to 1.0', () => {
      const memory = store.create(makeInput({
        confidence: 1.0,
        confidenceLevel: 'L2',
      }));
      expect(memory.confidence).toBe(1.0);
    });

    it('should use level cap as default confidence', () => {
      const memory = store.create(makeInput({ confidenceLevel: 'L0' }));
      expect(memory.confidence).toBe(0.7);
    });
  });

  describe('supersede()', () => {
    it('should mark old memory as invalid', () => {
      const old = store.create(makeInput({ content: 'Node 16' }));
      const newMem = store.supersede(old.id, makeInput({ content: 'Node 20' }));

      expect(newMem.content).toBe('Node 20');

      // Old memory should be invalidated
      const oldRow = db.getMemory(old.id);
      expect(oldRow!.invalid_at).not.toBeNull();
      expect(oldRow!.superseded_by).toBe(newMem.id);
    });
  });

  describe('get()', () => {
    it('should get a memory by id', () => {
      const created = store.create(makeInput({ content: 'get test' }));
      const fetched = store.get(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.content).toBe('get test');
    });

    it('should return undefined for non-existent id', () => {
      expect(store.get('non_existent')).toBeUndefined();
    });
  });

  describe('delete()', () => {
    it('should delete a memory', () => {
      const mem = store.create(makeInput());
      expect(store.delete(mem.id)).toBe(true);
      expect(store.get(mem.id)).toBeUndefined();
    });

    it('should return false for non-existent memory', () => {
      expect(store.delete('non_existent')).toBe(false);
    });
  });

  describe('updateEvidence()', () => {
    it('should increment evidence count', () => {
      const mem = store.create(makeInput());
      expect(mem.evidenceCount).toBe(1);

      store.updateEvidence(mem.id);

      const updated = store.get(mem.id);
      expect(updated!.evidenceCount).toBe(2);
    });
  });

  describe('findConflicting()', () => {
    it('should return empty array when vector is not available', async () => {
      // NoopProvider.available = false, so findConflicting returns []
      const conflicts = await store.findConflicting('some content', 'fact', 'agent1');
      expect(conflicts).toEqual([]);
    });
  });

  describe('flush()', () => {
    it('should resolve when no pending embeddings', async () => {
      await expect(store.flush()).resolves.toBeUndefined();
    });
  });

  describe('two-phase write with embedding failure', () => {
    it('should still succeed BM25 search when embedding fails', async () => {
      // Create a mock provider that is "available" but fails on embed
      const failingProvider: EmbeddingProvider = {
        available: true,
        dimension: 1024,
        embed: vi.fn().mockRejectedValue(new Error('API timeout')),
        embedBatch: vi.fn().mockRejectedValue(new Error('API timeout')),
      };

      // Mock vectorEnabled to true so the embed path is actually exercised
      Object.defineProperty(db, 'vectorEnabled', { value: true, writable: true });

      const storeWithFailing = new MemoryStore(db, failingProvider);
      const mem = storeWithFailing.create(makeInput({ content: 'resilient memory' }));

      // Wait for the async embed to fail
      await storeWithFailing.flush();

      // embed should have been called
      expect(failingProvider.embed).toHaveBeenCalledOnce();

      // BM25 search should still work
      const ftsResults = db.searchFts('resilient', 10);
      expect(ftsResults.some((r) => r.id === mem.id)).toBe(true);
    });
  });
});
