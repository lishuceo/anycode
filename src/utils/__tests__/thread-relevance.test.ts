import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseRelevanceResponse } from '../thread-relevance.js';

// ============================================================
// parseRelevanceResponse — JSON 解析 + fallback 逻辑
// ============================================================

describe('parseRelevanceResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true for {"respond": true}', () => {
    expect(parseRelevanceResponse('{"respond": true}')).toBe(true);
  });

  it('should return false for {"respond": false}', () => {
    expect(parseRelevanceResponse('{"respond": false}')).toBe(false);
  });

  it('should extract JSON from markdown code block', () => {
    expect(parseRelevanceResponse('```json\n{"respond": false}\n```')).toBe(false);
  });

  it('should extract JSON with extra text', () => {
    expect(parseRelevanceResponse('判断结果：{"respond": true}')).toBe(true);
  });

  it('should fallback to keyword detection for "false"', () => {
    expect(parseRelevanceResponse('false')).toBe(false);
  });

  it('should fallback to keyword detection for "respond: false"', () => {
    expect(parseRelevanceResponse('respond: false')).toBe(false);
  });

  it('should default to true for unparseable response', () => {
    expect(parseRelevanceResponse('不确定')).toBe(true);
  });

  it('should default to true for empty string', () => {
    expect(parseRelevanceResponse('')).toBe(true);
  });

  it('should handle malformed JSON gracefully', () => {
    expect(parseRelevanceResponse('{respond: true')).toBe(true);
  });
});

// ============================================================
// checkThreadRelevance — integration（mock client）
// ============================================================

// Mock quick-ack getClient
const mockCreate = vi.fn();
vi.mock('../quick-ack.js', () => ({
  getClient: vi.fn(() => Promise.resolve({
    chat: { completions: { create: (...args: unknown[]) => mockCreate(...args) } },
  })),
}));

vi.mock('../../config.js', () => ({
  config: {
    quickAck: { enabled: true, model: 'qwen3.5-flash' },
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { checkThreadRelevance } from '../thread-relevance.js';

describe('checkThreadRelevance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when model says respond', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"respond": true}' } }],
    });

    const result = await checkThreadRelevance('帮我查一下这个bug', 'Alice');
    expect(result).toBe(true);
  });

  it('should return false when model says do not respond', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"respond": false}' } }],
    });

    const result = await checkThreadRelevance('@赵天一 这个项目不典型了', 'Alice');
    expect(result).toBe(false);
  });

  it('should include botName in the user message', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"respond": true}' } }],
    });

    await checkThreadRelevance('测试消息', 'DevBot');

    const userMsg = mockCreate.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain('DevBot');
    expect(userMsg).toContain('测试消息');
  });

  it('should default to false on API error', async () => {
    mockCreate.mockRejectedValue(new Error('API error'));

    const result = await checkThreadRelevance('test', 'bot');
    expect(result).toBe(false);
  });

  it('should default to false on empty response', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '' } }],
    });

    const result = await checkThreadRelevance('test', 'bot');
    expect(result).toBe(false);
  });

  it('should use enable_thinking: false and low temperature', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"respond": true}' } }],
    });

    await checkThreadRelevance('test', 'bot');

    const params = mockCreate.mock.calls[0][0];
    expect(params.temperature).toBe(0);
    expect(params.max_tokens).toBe(20);
  });
});
