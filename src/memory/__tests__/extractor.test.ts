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
      dashscopeApiKey: 'sk-test',
      dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      extractionModel: 'qwen-plus',
    },
  },
}));

import { parseExtractionResponse } from '../extractor.js';

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
});
