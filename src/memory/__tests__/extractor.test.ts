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
    dashscopeApiKey: 'sk-test',
    dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingModel: 'text-embedding-v4',
    embeddingDimension: 1024,
    extractionModel: 'qwen-plus',
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

import { parseExtractionResponse, extractMemories } from '../extractor.js';
import { initializeMemory, closeMemory, getMemoryStore } from '../init.js';

describe('parseExtractionResponse', () => {
  it('should parse valid JSON array', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '项目运行时环境为 Node.js 20', confidence: 1.0, tags: ['runtime'], ttl: null, metadata: {} },
      { type: 'preference', content: '团队统一使用 pnpm 作为包管理器', confidence: 0.8, tags: [], ttl: null, metadata: {} },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('fact');
    expect(result[0].content).toContain('Node.js 20');
    expect(result[1].type).toBe('preference');
  });

  it('should parse JSON wrapped in { memories: [...] }', () => {
    const raw = JSON.stringify({
      memories: [
        { type: 'fact', content: '这是一条测试记忆，用于验证解析功能', confidence: 0.9, tags: [], ttl: null, metadata: {} },
      ],
    });

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('测试记忆');
  });

  it('should parse JSON from markdown code block', () => {
    const raw = `Here are the extracted memories:

\`\`\`json
[
  {"type": "preference", "content": "likes TypeScript", "confidence": 0.9, "tags": ["language"], "ttl": null, "metadata": {}}
]
\`\`\``;

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('likes TypeScript');
  });

  it('should return empty array for invalid JSON', () => {
    const result = parseExtractionResponse('not json at all');
    expect(result).toEqual([]);
  });

  it('should return empty array for empty array', () => {
    const result = parseExtractionResponse('[]');
    expect(result).toEqual([]);
  });

  it('should filter out invalid memory types', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '这是一条有效的事实记忆内容，用于验证类型过滤', confidence: 1.0 },
      { type: 'invalid_type', content: '这是一条无效类型的记忆内容，应被过滤掉', confidence: 1.0 },
      { type: 'preference', content: '这是一条有效的偏好记忆内容，应保留下来', confidence: 0.8 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('fact');
    expect(result[1].type).toBe('preference');
  });

  it('should filter out entries without content', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '', confidence: 1.0 },
      { type: 'fact', content: '这条记忆有足够长的内容，可以通过验证', confidence: 1.0 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('足够长');
  });

  it('should default confidence to 0.7 if missing', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '这条记忆没有 confidence 字段' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].confidence).toBe(0.7);
  });

  it('should handle missing tags gracefully', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '这条记忆没有 tags 字段标记' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].tags).toEqual([]);
  });

  it('should handle missing ttl gracefully (state without ttl demoted to fact)', () => {
    const raw = JSON.stringify([
      { type: 'state', content: '当前正在进行某个状态变更的操作' },
    ]);

    const result = parseExtractionResponse(raw);
    // state without ttl is demoted to fact
    expect(result[0].type).toBe('fact');
    expect(result[0].ttl).toBeNull();
  });

  it('should parse JSON wrapped in { data: [...] }', () => {
    const raw = JSON.stringify({
      data: [
        { type: 'decision', content: '选择 React 作为前端框架，因为生态更成熟', confidence: 1.0 },
      ],
    });

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('React');
  });

  it('should handle non-string tags in array', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '这条记忆有混合类型的 tags 标签', tags: ['valid', 123, null, 'also valid'] },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].tags).toEqual(['valid', 'also valid']);
  });

  it('should handle null/undefined entries in array', () => {
    const raw = JSON.stringify([
      null,
      { type: 'fact', content: '这是数组中唯一有效的记忆条目，其余为 null' },
      undefined,
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('有效');
  });

  it('should filter out transient PR status memories', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: 'PR #161 已合并，部署后生效', confidence: 1.0 },
      { type: 'fact', content: '项目使用 TypeScript 5.7 和 ESM 模块系统', confidence: 1.0 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('TypeScript');
  });

  it('should filter out deployment status memories', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '新版本已部署到生产环境', confidence: 1.0 },
      { type: 'state', content: '服务已上线运行中', confidence: 0.8, ttl: '2026-03-25' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(0);
  });

  it('should filter out content shorter than 15 chars', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '用了 pnpm', confidence: 1.0 },
      { type: 'fact', content: '项目的包管理器是 pnpm，全团队统一使用', confidence: 1.0 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('包管理器');
  });

  it('should demote state without ttl to fact', () => {
    const raw = JSON.stringify([
      { type: 'state', content: '系统通过环境变量 CRON_ENABLED 启用定时任务', confidence: 0.7 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('fact');
  });

  it('should keep state with ttl as state', () => {
    const raw = JSON.stringify([
      { type: 'state', content: '当前正在进行记忆系统重构，预计本周完成', confidence: 0.7, ttl: '2026-03-25' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('state');
    expect(result[0].ttl).toBe('2026-03-25');
  });
});

describe('extractMemories', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'extractor-test-'));
    mockMemoryConfig.dbPath = join(tempDir, 'test.db');
    mockMemoryConfig.enabled = true;
    mockMemoryConfig.extractionModel = 'qwen-plus';
    await initializeMemory();
  });

  afterEach(() => {
    closeMemory();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const context = {
    agentId: 'agent1',
    userId: 'user1',
    chatId: 'chat1',
    workspaceDir: '/projects/test',
  };

  it('should skip when memory is disabled', async () => {
    mockMemoryConfig.enabled = false;
    // Should not throw
    await extractMemories('hello', 'a'.repeat(100), context);
  });

  it('should skip when extractionModel is empty', async () => {
    mockMemoryConfig.extractionModel = '';
    await extractMemories('hello', 'a'.repeat(100), context);
  });

  it('should skip when output is too short', async () => {
    // Output < 50 chars
    await extractMemories('hello', 'short', context);
    // No store operations should have happened
  });

  it('should skip when store is null (not initialized)', async () => {
    closeMemory();
    await extractMemories('hello', 'a'.repeat(100), context);
  });

  it('should not throw on extraction failure', async () => {
    // getExtractionClient will fail because openai SDK mock isn't set up
    // But extractMemories should catch and log, not throw
    await expect(
      extractMemories('hello', 'a'.repeat(100), context),
    ).resolves.toBeUndefined();
  });
});

describe('extractMemories — userName identity context', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'extractor-identity-test-'));
    mockMemoryConfig.dbPath = join(tempDir, 'test.db');
    mockMemoryConfig.enabled = true;
    mockMemoryConfig.extractionModel = 'qwen-plus';
    await initializeMemory();
  });

  afterEach(() => {
    closeMemory();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should accept userName in ExtractionContext', async () => {
    const contextWithName = {
      agentId: 'agent1',
      userId: 'ou_abc123',
      chatId: 'chat1',
      workspaceDir: '/projects/test',
      userName: '姜黎',
    };
    // Should not throw — userName is optional and accepted
    await extractMemories('hello', 'a'.repeat(100), contextWithName);
  });

  it('should work without userName (backward compatible)', async () => {
    const contextWithoutName = {
      agentId: 'agent1',
      userId: 'ou_abc123',
      chatId: 'chat1',
    };
    await extractMemories('hello', 'a'.repeat(100), contextWithoutName);
  });
});

describe('extractMemories — processExtractedMemory integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'extractor-process-test-'));
    mockMemoryConfig.dbPath = join(tempDir, 'test.db');
    mockMemoryConfig.enabled = true;
    mockMemoryConfig.extractionModel = 'qwen-plus';
    await initializeMemory();
  });

  afterEach(() => {
    closeMemory();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create memories with L0 confidence level', () => {
    const store = getMemoryStore()!;
    // Simulate what processExtractedMemory does via store.create
    const mem = store.create({
      agentId: 'agent1',
      userId: 'user1',
      type: 'fact',
      content: 'auto extracted fact',
      confidence: 1.0,
      confidenceLevel: 'L0',
    });

    // L0 caps at 0.7
    expect(mem.confidence).toBe(0.7);
    expect(mem.confidenceLevel).toBe('L0');
  });

  it('should supersede conflicting facts via store', () => {
    const store = getMemoryStore()!;

    const old = store.create({
      agentId: 'agent1',
      userId: 'user1',
      type: 'fact',
      content: 'Node 16',
      confidenceLevel: 'L2',
      confidence: 1.0,
    });

    const newMem = store.supersede(old.id, {
      agentId: 'agent1',
      userId: 'user1',
      type: 'fact',
      content: 'Node 20',
      confidenceLevel: 'L0',
      confidence: 0.7,
    });

    expect(newMem.content).toBe('Node 20');
    const oldRow = store.get(old.id);
    expect(oldRow!.invalidAt).not.toBeNull();
    expect(oldRow!.supersededBy).toBe(newMem.id);
  });

  it('should increment evidence on duplicate', () => {
    const store = getMemoryStore()!;

    const mem = store.create({
      agentId: 'agent1',
      userId: 'user1',
      type: 'preference',
      content: 'prefers pnpm',
      confidenceLevel: 'L0',
    });

    expect(mem.evidenceCount).toBe(1);
    store.updateEvidence(mem.id);

    const updated = store.get(mem.id);
    expect(updated!.evidenceCount).toBe(2);
  });
});
