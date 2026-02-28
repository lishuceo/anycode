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

// Use vi.hoisted to make the config object available in the mock factory
const { mockMemoryConfig } = vi.hoisted(() => {
  const mockMemoryConfig = {
    enabled: true,
    dbPath: '',
    dashscopeApiKey: '',
    dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingModel: 'text-embedding-v4',
    embeddingDimension: 1024,
    extractionModel: '',
    vectorWeight: 0.7,
    maxInjectTokens: 2000,
  };
  return { mockMemoryConfig };
});

vi.mock('../../config.js', () => ({
  config: {
    memory: mockMemoryConfig,
  },
}));

import {
  initializeMemory, closeMemory, getMemoryStore,
  getHybridSearch, isMemoryEnabled, runMemoryMaintenance,
} from '../init.js';

describe('Memory Init', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-init-test-'));
    mockMemoryConfig.dbPath = join(tempDir, 'test.db');
    mockMemoryConfig.enabled = true;
    mockMemoryConfig.dashscopeApiKey = '';
    closeMemory();
  });

  afterEach(() => {
    closeMemory();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('initializeMemory', () => {
    it('should initialize when enabled', async () => {
      await initializeMemory();
      expect(isMemoryEnabled()).toBe(true);
      expect(getMemoryStore()).not.toBeNull();
      expect(getHybridSearch()).not.toBeNull();
    });

    it('should be idempotent', async () => {
      await initializeMemory();
      const store1 = getMemoryStore();
      await initializeMemory();
      const store2 = getMemoryStore();
      expect(store1).toBe(store2);
    });

    it('should return null singletons when disabled', async () => {
      mockMemoryConfig.enabled = false;
      await initializeMemory();
      expect(isMemoryEnabled()).toBe(false);
      expect(getMemoryStore()).toBeNull();
      expect(getHybridSearch()).toBeNull();
    });
  });

  describe('closeMemory', () => {
    it('should clean up singletons', async () => {
      await initializeMemory();
      expect(getMemoryStore()).not.toBeNull();
      closeMemory();
      expect(getMemoryStore()).toBeNull();
      expect(getHybridSearch()).toBeNull();
    });

    it('should be safe to call when not initialized', () => {
      expect(() => closeMemory()).not.toThrow();
    });
  });

  describe('runMemoryMaintenance', () => {
    it('should not throw when initialized', async () => {
      await initializeMemory();
      expect(() => runMemoryMaintenance()).not.toThrow();
    });

    it('should not throw when not initialized', () => {
      expect(() => runMemoryMaintenance()).not.toThrow();
    });

    it('should mark expired TTL states', async () => {
      await initializeMemory();
      const store = getMemoryStore()!;

      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      store.create({
        agentId: 'test',
        userId: 'user1',
        type: 'state',
        content: 'expired state',
        ttl: pastDate,
        confidenceLevel: 'L2',
        confidence: 1.0,
      });

      runMemoryMaintenance();

      const search = getHybridSearch()!;
      const results = await search.search({
        query: 'expired state',
        agentId: 'test',
        userId: 'user1',
      });
      expect(results).toHaveLength(0);
    });
  });
});
