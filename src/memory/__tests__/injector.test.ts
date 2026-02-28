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
    maxInjectTokens: 4000,
  };
  return { mockMemoryConfig };
});

vi.mock('../../config.js', () => ({
  config: {
    memory: mockMemoryConfig,
  },
}));

import { formatMemories, injectMemories } from '../injector.js';
import { initializeMemory, closeMemory, getMemoryStore } from '../init.js';
import type { MemorySearchResult, MemoryType } from '../types.js';

function makeResult(overrides: {
  type?: MemoryType;
  content?: string;
  confidence?: number;
  ttl?: string | null;
  validAt?: string;
  createdAt?: string;
  finalScore?: number;
} = {}): MemorySearchResult {
  const now = new Date().toISOString();
  return {
    memory: {
      id: 'mem_test',
      agentId: 'agent1',
      userId: 'user1',
      chatId: 'chat1',
      workspaceDir: null,
      type: overrides.type ?? 'fact',
      content: overrides.content ?? 'test content',
      tags: [],
      metadata: {},
      confidence: overrides.confidence ?? 1.0,
      confidenceLevel: 'L2',
      evidenceCount: 1,
      validAt: overrides.validAt ?? now,
      invalidAt: null,
      supersededBy: null,
      ttl: overrides.ttl ?? null,
      sourceChatId: null,
      sourceMessageId: null,
      createdAt: overrides.createdAt ?? now,
      updatedAt: now,
      lastAccessedAt: null,
    },
    vectorScore: 0,
    bm25Score: 0.5,
    typeBoost: 1.0,
    recencyDecay: 1.0,
    finalScore: overrides.finalScore ?? 0.5,
  };
}

describe('formatMemories', () => {
  it('should return empty string for empty results', () => {
    expect(formatMemories([])).toBe('');
  });

  it('should group by type and use correct labels', () => {
    const results = [
      makeResult({ type: 'preference', content: '偏好 pnpm' }),
      makeResult({ type: 'fact', content: 'Node 20' }),
      makeResult({ type: 'decision', content: '选用 PostgreSQL' }),
    ];

    const output = formatMemories(results);
    expect(output).toContain('### 偏好');
    expect(output).toContain('### 项目事实');
    expect(output).toContain('### 过往决策');
    expect(output).toContain('偏好 pnpm');
    expect(output).toContain('Node 20');
    expect(output).toContain('选用 PostgreSQL');
  });

  it('should order types: preference → fact → state → decision → relation', () => {
    const results = [
      makeResult({ type: 'decision', content: 'decision item' }),
      makeResult({ type: 'preference', content: 'preference item' }),
      makeResult({ type: 'fact', content: 'fact item' }),
    ];

    const output = formatMemories(results);
    const prefIdx = output.indexOf('### 偏好');
    const factIdx = output.indexOf('### 项目事实');
    const decIdx = output.indexOf('### 过往决策');
    expect(prefIdx).toBeLessThan(factIdx);
    expect(factIdx).toBeLessThan(decIdx);
  });

  it('should include date for state with TTL', () => {
    const results = [
      makeResult({
        type: 'state',
        content: '正在重构支付模块',
        ttl: '2026-03-15T00:00:00.000Z',
      }),
    ];

    const output = formatMemories(results);
    expect(output).toContain('预计到 2026-03-15');
  });

  it('should include since date for facts', () => {
    const results = [
      makeResult({
        type: 'fact',
        content: 'Node 20',
        validAt: '2026-02-15T00:00:00.000Z',
      }),
    ];

    const output = formatMemories(results);
    expect(output).toContain('since 2026-02-15');
  });

  it('should include date for decisions', () => {
    const results = [
      makeResult({
        type: 'decision',
        content: '选用 PostgreSQL',
        createdAt: '2026-01-10T00:00:00.000Z',
      }),
    ];

    const output = formatMemories(results);
    expect(output).toContain('(2026-01-10)');
  });

  it('should tag low-confidence memories', () => {
    const results = [
      makeResult({ type: 'preference', content: '可能喜欢 Vue', confidence: 0.4 }),
    ];

    const output = formatMemories(results);
    expect(output).toContain('confidence: low');
  });

  it('should not tag high-confidence memories', () => {
    const results = [
      makeResult({ type: 'preference', content: '确定用 React', confidence: 0.9 }),
    ];

    const output = formatMemories(results);
    expect(output).not.toContain('confidence:');
  });

  it('should start with header', () => {
    const results = [makeResult()];
    const output = formatMemories(results);
    expect(output).toContain('## 关于此用户的记忆');
  });

  it('should handle relation type', () => {
    const results = [
      makeResult({ type: 'relation', content: 'Alice is tech lead of Bob' }),
    ];

    const output = formatMemories(results);
    expect(output).toContain('### 关系');
    expect(output).toContain('Alice is tech lead of Bob');
  });

  it('should truncate when exceeding token budget', () => {
    // Set a very low token budget
    const originalMax = mockMemoryConfig.maxInjectTokens;
    mockMemoryConfig.maxInjectTokens = 50; // ~150 chars

    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult({ type: 'fact', content: `Memory item number ${i} with some extra text to fill space` }),
    );

    const output = formatMemories(results);
    // Should not contain all 20 items
    const itemCount = (output.match(/^- /gm) ?? []).length;
    expect(itemCount).toBeLessThan(20);
    expect(itemCount).toBeGreaterThan(0);

    mockMemoryConfig.maxInjectTokens = originalMax;
  });

  it('should skip empty type groups', () => {
    const results = [
      makeResult({ type: 'fact', content: 'only facts here' }),
    ];

    const output = formatMemories(results);
    expect(output).toContain('### 项目事实');
    expect(output).not.toContain('### 偏好');
    expect(output).not.toContain('### 当前状态');
    expect(output).not.toContain('### 过往决策');
    expect(output).not.toContain('### 关系');
  });
});

describe('injectMemories', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'injector-test-'));
    mockMemoryConfig.dbPath = join(tempDir, 'test.db');
    mockMemoryConfig.enabled = true;
    closeMemory();
  });

  afterEach(() => {
    closeMemory();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return empty string when disabled', async () => {
    mockMemoryConfig.enabled = false;
    const result = await injectMemories('test query', { agentId: 'agent1' });
    expect(result).toBe('');
  });

  it('should return empty string when search is not initialized', async () => {
    // Don't call initializeMemory — search is null
    const result = await injectMemories('test query', { agentId: 'agent1' });
    expect(result).toBe('');
  });

  it('should return empty string when no memories match', async () => {
    await initializeMemory();
    const result = await injectMemories('completely unrelated query xyz', { agentId: 'agent1' });
    expect(result).toBe('');
  });

  it('should return formatted memories when matches exist', async () => {
    await initializeMemory();
    const store = getMemoryStore()!;

    store.create({
      agentId: 'agent1',
      userId: 'user1',
      type: 'preference',
      content: 'prefers TypeScript',
      confidenceLevel: 'L2',
      confidence: 1.0,
    });

    const result = await injectMemories('TypeScript', {
      agentId: 'agent1',
      userId: 'user1',
    });

    expect(result).toContain('TypeScript');
    expect(result).toContain('## 关于此用户的记忆');
  });

  it('should respect agent isolation', async () => {
    await initializeMemory();
    const store = getMemoryStore()!;

    store.create({
      agentId: 'agent1',
      type: 'fact',
      content: 'agent1 secret knowledge about databases',
      confidenceLevel: 'L2',
      confidence: 1.0,
    });

    // Search as agent2 should not find agent1's memory
    const result = await injectMemories('databases', {
      agentId: 'agent2',
    });

    expect(result).not.toContain('agent1 secret');
  });
});
