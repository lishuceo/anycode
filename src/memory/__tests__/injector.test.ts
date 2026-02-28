import { describe, it, expect, vi } from 'vitest';

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
    memory: {
      enabled: true,
      maxInjectTokens: 2000,
    },
  },
}));

import { formatMemories } from '../injector.js';
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
});
