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
      { type: 'fact', content: 'Node 20', confidence: 1.0, tags: ['runtime'], ttl: null, metadata: {} },
      { type: 'preference', content: 'pnpm', confidence: 0.8, tags: [], ttl: null, metadata: {} },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('fact');
    expect(result[0].content).toBe('Node 20');
    expect(result[1].type).toBe('preference');
  });

  it('should parse JSON wrapped in { memories: [...] }', () => {
    const raw = JSON.stringify({
      memories: [
        { type: 'fact', content: 'test', confidence: 0.9, tags: [], ttl: null, metadata: {} },
      ],
    });

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('test');
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
      { type: 'fact', content: 'valid', confidence: 1.0 },
      { type: 'invalid_type', content: 'invalid', confidence: 1.0 },
      { type: 'preference', content: 'also valid', confidence: 0.8 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('fact');
    expect(result[1].type).toBe('preference');
  });

  it('should filter out entries without content', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '', confidence: 1.0 },
      { type: 'fact', content: 'has content', confidence: 1.0 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('has content');
  });

  it('should default confidence to 0.7 if missing', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: 'no confidence field' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].confidence).toBe(0.7);
  });

  it('should handle missing tags gracefully', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: 'no tags' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].tags).toEqual([]);
  });

  it('should handle missing ttl gracefully', () => {
    const raw = JSON.stringify([
      { type: 'state', content: 'some state' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].ttl).toBeNull();
  });

  it('should parse JSON wrapped in { data: [...] }', () => {
    const raw = JSON.stringify({
      data: [
        { type: 'decision', content: 'chose React', confidence: 1.0 },
      ],
    });

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('chose React');
  });

  it('should handle non-string tags in array', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: 'mixed tags', tags: ['valid', 123, null, 'also valid'] },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].tags).toEqual(['valid', 'also valid']);
  });

  it('should handle null/undefined entries in array', () => {
    const raw = JSON.stringify([
      null,
      { type: 'fact', content: 'valid' },
      undefined,
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('valid');
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
