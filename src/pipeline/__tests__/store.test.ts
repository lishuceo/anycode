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

vi.mock('../../config.js', () => ({
  config: {
    db: { sessionDbPath: '/tmp/test.db' },
  },
}));

import { PipelineStore, generatePipelineId } from '../store.js';

describe('PipelineStore', () => {
  let store: PipelineStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pipeline-store-test-'));
    store = new PipelineStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ============================================================
  // CRUD
  // ============================================================

  describe('create and get', () => {
    it('should create and retrieve a pipeline record', () => {
      const record = store.create({
        id: 'pipe_123_abcd',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        threadRootMsgId: 'root1',
        progressMsgId: 'progress1',
        workingDir: '/tmp/work',
        prompt: 'build a feature',
      });

      expect(record.id).toBe('pipe_123_abcd');
      expect(record.status).toBe('pending_confirm');
      expect(record.phase).toBe('');
      expect(record.stateJson).toBe('{}');

      const retrieved = store.get('pipe_123_abcd');
      expect(retrieved).toBeDefined();
      expect(retrieved!.chatId).toBe('chat1');
      expect(retrieved!.userId).toBe('user1');
      expect(retrieved!.prompt).toBe('build a feature');
      expect(retrieved!.workingDir).toBe('/tmp/work');
      expect(retrieved!.threadRootMsgId).toBe('root1');
      expect(retrieved!.progressMsgId).toBe('progress1');
    });

    it('should return undefined for non-existent pipeline', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('should handle null optional fields', () => {
      store.create({
        id: 'pipe_456',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        workingDir: '/tmp',
        prompt: 'task',
      });

      const record = store.get('pipe_456');
      expect(record!.threadRootMsgId).toBeUndefined();
      expect(record!.progressMsgId).toBeUndefined();
    });
  });

  // ============================================================
  // tryStart — CAS atomicity
  // ============================================================

  describe('tryStart (CAS)', () => {
    it('should succeed on first call', () => {
      store.create({
        id: 'pipe_cas',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        workingDir: '/tmp',
        prompt: 'task',
      });

      const result = store.tryStart('pipe_cas');
      expect(result).toBe(true);

      const record = store.get('pipe_cas');
      expect(record!.status).toBe('running');
    });

    it('should fail on second call (double-click prevention)', () => {
      store.create({
        id: 'pipe_cas2',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        workingDir: '/tmp',
        prompt: 'task',
      });

      expect(store.tryStart('pipe_cas2')).toBe(true);
      expect(store.tryStart('pipe_cas2')).toBe(false);
    });

    it('should fail if pipeline is already in non-pending state', () => {
      store.create({
        id: 'pipe_cas3',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        workingDir: '/tmp',
        prompt: 'task',
      });

      store.updateState('pipe_cas3', 'cancelled', '', '{}');
      expect(store.tryStart('pipe_cas3')).toBe(false);
    });
  });

  // ============================================================
  // updateState
  // ============================================================

  describe('updateState', () => {
    it('should update status, phase, and stateJson', () => {
      store.create({
        id: 'pipe_update',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        workingDir: '/tmp',
        prompt: 'task',
      });

      store.updateState('pipe_update', 'running', 'plan', '{"phase":"plan"}');

      const record = store.get('pipe_update');
      expect(record!.status).toBe('running');
      expect(record!.phase).toBe('plan');
      expect(record!.stateJson).toBe('{"phase":"plan"}');
    });
  });

  // ============================================================
  // updateProgressMsgId
  // ============================================================

  describe('updateProgressMsgId', () => {
    it('should update the progress message ID', () => {
      store.create({
        id: 'pipe_msg',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        workingDir: '/tmp',
        prompt: 'task',
      });

      store.updateProgressMsgId('pipe_msg', 'new_progress_msg');

      const record = store.get('pipe_msg');
      expect(record!.progressMsgId).toBe('new_progress_msg');
    });
  });

  // ============================================================
  // findByStatus
  // ============================================================

  describe('findByStatus', () => {
    it('should find pipelines by status', () => {
      store.create({ id: 'p1', chatId: 'c', userId: 'u', messageId: 'm', workingDir: '/tmp', prompt: 'a' });
      store.create({ id: 'p2', chatId: 'c', userId: 'u', messageId: 'm', workingDir: '/tmp', prompt: 'b' });

      store.tryStart('p1');

      const pending = store.findByStatus('pending_confirm');
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('p2');

      const running = store.findByStatus('running');
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe('p1');
    });
  });

  // ============================================================
  // markRunningAsInterrupted
  // ============================================================

  describe('markRunningAsInterrupted', () => {
    it('should mark running pipelines as interrupted', () => {
      store.create({ id: 'p1', chatId: 'c', userId: 'u', messageId: 'm', workingDir: '/tmp', prompt: 'a' });
      store.create({ id: 'p2', chatId: 'c', userId: 'u', messageId: 'm', workingDir: '/tmp', prompt: 'b' });

      store.tryStart('p1');
      store.tryStart('p2');

      const count = store.markRunningAsInterrupted();
      expect(count).toBe(2);

      const interrupted = store.findByStatus('interrupted');
      expect(interrupted).toHaveLength(2);

      const running = store.findByStatus('running');
      expect(running).toHaveLength(0);
    });

    it('should not affect non-running pipelines', () => {
      store.create({ id: 'p1', chatId: 'c', userId: 'u', messageId: 'm', workingDir: '/tmp', prompt: 'a' });
      store.create({ id: 'p2', chatId: 'c', userId: 'u', messageId: 'm', workingDir: '/tmp', prompt: 'b' });

      store.tryStart('p1');
      // p2 stays in pending_confirm

      const count = store.markRunningAsInterrupted();
      expect(count).toBe(1);

      const pending = store.findByStatus('pending_confirm');
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('p2');
    });

    it('should return 0 when no running pipelines', () => {
      expect(store.markRunningAsInterrupted()).toBe(0);
    });
  });

  // ============================================================
  // cleanExpired
  // ============================================================

  describe('cleanExpired', () => {
    it('should not clean recent pipelines', () => {
      store.create({ id: 'p1', chatId: 'c', userId: 'u', messageId: 'm', workingDir: '/tmp', prompt: 'a' });

      const cleaned = store.cleanExpired(30);
      expect(cleaned).toBe(0);
    });

    it('should clean old pipelines', () => {
      store.create({ id: 'p1', chatId: 'c', userId: 'u', messageId: 'm', workingDir: '/tmp', prompt: 'a' });

      // Back-date via raw SQL
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      (store as any).db.prepare(
        "UPDATE pipelines SET created_at = ? WHERE id = 'p1'"
      ).run(oldDate);

      const cleaned = store.cleanExpired(30);
      expect(cleaned).toBe(1);
      expect(store.get('p1')).toBeUndefined();
    });
  });

  // ============================================================
  // generatePipelineId
  // ============================================================

  describe('generatePipelineId', () => {
    it('should generate IDs with pipe_ prefix', () => {
      const id = generatePipelineId();
      expect(id).toMatch(/^pipe_\d+_[0-9a-f]{4}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generatePipelineId()));
      expect(ids.size).toBe(100);
    });
  });
});
