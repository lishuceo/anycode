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

import { MemoryDatabase, sanitizeFtsQuery } from '../database.js';
import type { MemoryRow } from '../database.js';

function makeRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  const now = new Date().toISOString();
  return {
    id: `mem_test_${Math.random().toString(36).slice(2, 8)}`,
    agent_id: 'agent1',
    user_id: 'user1',
    chat_id: 'chat1',
    workspace_dir: '/projects/test',
    type: 'fact',
    content: 'Test memory content',
    tags: '["test"]',
    metadata: '{}',
    confidence: 0.7,
    confidence_level: 'L0',
    evidence_count: 1,
    valid_at: now,
    invalid_at: null,
    superseded_by: null,
    ttl: null,
    source_chat_id: null,
    source_message_id: null,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    ...overrides,
  };
}

describe('MemoryDatabase', () => {
  let db: MemoryDatabase;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-db-test-'));
    db = await MemoryDatabase.create(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('schema creation', () => {
    it('should create database without errors', () => {
      expect(db).toBeDefined();
      expect(db.db).toBeDefined();
    });

    it('should have memories table', () => {
      const tables = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    it('should have FTS5 virtual table', () => {
      const tables = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
      ).all();
      expect(tables).toHaveLength(1);
    });
  });

  describe('CRUD operations', () => {
    it('should insert and get a memory', () => {
      const row = makeRow({ id: 'mem_crud_1', content: 'Node.js version is 20' });
      db.insertMemory(row);

      const result = db.getMemory('mem_crud_1');
      expect(result).toBeDefined();
      expect(result!.content).toBe('Node.js version is 20');
      expect(result!.type).toBe('fact');
    });

    it('should return undefined for non-existent memory', () => {
      expect(db.getMemory('non_existent')).toBeUndefined();
    });

    it('should delete a memory', () => {
      const row = makeRow({ id: 'mem_del_1' });
      db.insertMemory(row);
      expect(db.getMemory('mem_del_1')).toBeDefined();

      const deleted = db.deleteMemory('mem_del_1');
      expect(deleted).toBe(true);
      expect(db.getMemory('mem_del_1')).toBeUndefined();
    });

    it('should update a memory', () => {
      const row = makeRow({ id: 'mem_upd_1', content: 'old content' });
      db.insertMemory(row);

      db.updateMemory({
        id: 'mem_upd_1',
        content: 'new content',
        updated_at: new Date().toISOString(),
      });

      const result = db.getMemory('mem_upd_1');
      expect(result!.content).toBe('new content');
    });

    it('should supersede a memory', () => {
      const oldRow = makeRow({ id: 'mem_old_1' });
      const newRow = makeRow({ id: 'mem_new_1' });
      db.insertMemory(oldRow);
      db.insertMemory(newRow);

      db.supersedeMemory('mem_old_1', 'mem_new_1');

      const old = db.getMemory('mem_old_1');
      expect(old!.invalid_at).not.toBeNull();
      expect(old!.superseded_by).toBe('mem_new_1');
    });

    it('should update evidence count', () => {
      const row = makeRow({ id: 'mem_ev_1', evidence_count: 1 });
      db.insertMemory(row);

      db.updateEvidence('mem_ev_1');

      const result = db.getMemory('mem_ev_1');
      expect(result!.evidence_count).toBe(2);
    });
  });

  describe('FTS5 trigger sync', () => {
    it('should find inserted memory via FTS5', () => {
      const row = makeRow({ id: 'mem_fts_1', content: 'TypeScript is the best language' });
      db.insertMemory(row);

      const results = db.searchFts('TypeScript', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.id === 'mem_fts_1')).toBe(true);
    });

    it('should update FTS5 after content change', () => {
      const row = makeRow({ id: 'mem_fts_2', content: 'Python is wonderful' });
      db.insertMemory(row);

      // Should find by old content
      expect(db.searchFts('Python', 10).some((r) => r.id === 'mem_fts_2')).toBe(true);

      // Update content
      db.updateMemory({
        id: 'mem_fts_2',
        content: 'Rust is blazing fast',
        updated_at: new Date().toISOString(),
      });

      // Old content should no longer match
      expect(db.searchFts('Python', 10).some((r) => r.id === 'mem_fts_2')).toBe(false);

      // New content should match
      expect(db.searchFts('Rust', 10).some((r) => r.id === 'mem_fts_2')).toBe(true);
    });

    it('should remove FTS5 entry after delete', () => {
      const row = makeRow({ id: 'mem_fts_3', content: 'Go concurrency patterns' });
      db.insertMemory(row);

      expect(db.searchFts('concurrency', 10).some((r) => r.id === 'mem_fts_3')).toBe(true);

      db.deleteMemory('mem_fts_3');

      expect(db.searchFts('concurrency', 10).some((r) => r.id === 'mem_fts_3')).toBe(false);
    });

    it('should search by tags', () => {
      const row = makeRow({ id: 'mem_fts_4', content: 'some fact', tags: '["database", "postgresql"]' });
      db.insertMemory(row);

      const results = db.searchFts('postgresql', 10);
      expect(results.some((r) => r.id === 'mem_fts_4')).toBe(true);
    });
  });

  describe('vec0 conditional behavior', () => {
    it('should report vectorEnabled status', () => {
      // In test env, sqlite-vec may or may not be available
      expect(typeof db.vectorEnabled).toBe('boolean');
    });

    it('should handle insertVec gracefully when vector disabled', () => {
      if (db.vectorEnabled) return; // skip if vector IS enabled
      // Should not throw
      db.insertVec('mem_no_vec', new Float32Array(1536));
    });

    it('should handle searchVec gracefully when vector disabled', () => {
      if (db.vectorEnabled) return;
      const results = db.searchVec(new Float32Array(1536), 10);
      expect(results).toEqual([]);
    });

    it('should handle deleteVec gracefully when vector disabled', () => {
      if (db.vectorEnabled) return;
      // Should not throw
      db.deleteVec('mem_no_vec');
    });
  });

  // Conditional vec0 tests: only run if sqlite-vec is available
  describe('vec0 operations (when available)', () => {
    it('should insert and search vectors', () => {
      if (!db.vectorEnabled) return;

      const row = makeRow({ id: 'mem_vec_1', content: 'vector test' });
      db.insertMemory(row);

      const embedding = new Float32Array(1536);
      embedding[0] = 1.0; // simple non-zero vector
      db.insertVec('mem_vec_1', embedding);

      const results = db.searchVec(embedding, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory_id).toBe('mem_vec_1');
    });

    it('should remove vector after deleteVec', () => {
      if (!db.vectorEnabled) return;

      const row = makeRow({ id: 'mem_vec_2', content: 'vector delete test' });
      db.insertMemory(row);

      const embedding = new Float32Array(1536);
      embedding[0] = 0.5;
      embedding[1] = 0.5;
      db.insertVec('mem_vec_2', embedding);

      db.deleteVec('mem_vec_2');

      const results = db.searchVec(embedding, 10);
      expect(results.every((r) => r.memory_id !== 'mem_vec_2')).toBe(true);
    });
  });

  describe('sanitizeFtsQuery', () => {
    it('should wrap tokens in double quotes', () => {
      expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"');
    });

    it('should strip FTS5 special characters', () => {
      // ':' and '*' are stripped, leaving two separate tokens
      expect(sanitizeFtsQuery('content:secret*')).toBe('"content" "secret"');
    });

    it('should handle query with only special chars', () => {
      expect(sanitizeFtsQuery('***')).toBe('""');
    });

    it('should handle empty string', () => {
      expect(sanitizeFtsQuery('')).toBe('""');
    });

    it('should strip double quotes to prevent injection', () => {
      expect(sanitizeFtsQuery('"hello" OR "world"')).toBe('"hello" "OR" "world"');
    });

    it('should strip parentheses', () => {
      expect(sanitizeFtsQuery('(NOT secret)')).toBe('"NOT" "secret"');
    });
  });

  describe('updateMemory nullable fields', () => {
    it('should allow clearing invalid_at with explicit null', () => {
      const row = makeRow({ id: 'mem_null_1' });
      db.insertMemory(row);

      // First set invalid_at
      db.supersedeMemory('mem_null_1', 'mem_other');
      expect(db.getMemory('mem_null_1')!.invalid_at).not.toBeNull();

      // Now clear it via updateMemory with explicit null
      db.updateMemory({
        id: 'mem_null_1',
        invalid_at: null,
        superseded_by: null,
        updated_at: new Date().toISOString(),
      });

      const result = db.getMemory('mem_null_1');
      expect(result!.invalid_at).toBeNull();
      expect(result!.superseded_by).toBeNull();
    });
  });

  describe('updateLastAccessedBatch', () => {
    it('should update last_accessed_at for multiple memories in one transaction', () => {
      const row1 = makeRow({ id: 'mem_batch_1' });
      const row2 = makeRow({ id: 'mem_batch_2' });
      db.insertMemory(row1);
      db.insertMemory(row2);

      expect(db.getMemory('mem_batch_1')!.last_accessed_at).toBeNull();
      expect(db.getMemory('mem_batch_2')!.last_accessed_at).toBeNull();

      db.updateLastAccessedBatch(['mem_batch_1', 'mem_batch_2']);

      expect(db.getMemory('mem_batch_1')!.last_accessed_at).not.toBeNull();
      expect(db.getMemory('mem_batch_2')!.last_accessed_at).not.toBeNull();
    });

    it('should handle empty array', () => {
      // Should not throw
      db.updateLastAccessedBatch([]);
    });
  });

  describe('dimension validation', () => {
    it('should reject invalid dimension', async () => {
      await expect(MemoryDatabase.create(join(tempDir, 'bad.db'), -1))
        .rejects.toThrow('Invalid embedding dimension');
    });

    it('should reject non-integer dimension', async () => {
      await expect(MemoryDatabase.create(join(tempDir, 'bad.db'), 1.5))
        .rejects.toThrow('Invalid embedding dimension');
    });
  });

  describe('rowToMemory', () => {
    it('should convert row to Memory interface', () => {
      const row = makeRow({
        id: 'mem_conv_1',
        tags: '["a", "b"]',
        metadata: '{"key": "val"}',
      });

      const memory = MemoryDatabase.rowToMemory(row);
      expect(memory.id).toBe('mem_conv_1');
      expect(memory.tags).toEqual(['a', 'b']);
      expect(memory.metadata).toEqual({ key: 'val' });
      expect(memory.agentId).toBe('agent1');
      expect(memory.type).toBe('fact');
    });
  });
});
