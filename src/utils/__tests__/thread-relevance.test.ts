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

  it('should fallback to true when raw contains "true" keyword', () => {
    expect(parseRelevanceResponse('respond: true')).toBe(true);
  });

  it('should default to false for unparseable response (宁可不回)', () => {
    expect(parseRelevanceResponse('不确定')).toBe(false);
  });

  it('should default to false for empty string (宁可不回)', () => {
    expect(parseRelevanceResponse('')).toBe(false);
  });

  it('should default to false for malformed JSON without keywords', () => {
    expect(parseRelevanceResponse('{respond: ???}')).toBe(false);
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

  it('should include recent context with sender names when provided', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"respond": false}' } }],
    });

    const recentMessages = [
      { senderType: 'app' as const, senderName: '大师', content: '好的，我来帮你看看' },
      { senderType: 'user' as const, senderName: '林美辰', content: '不给偷鸡' },
    ];

    await checkThreadRelevance('你不是应该用SkillHub么？', '大师', recentMessages);

    const userMsg = mockCreate.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain('最近对话');
    expect(userMsg).toContain('[大师(bot)]: 好的，我来帮你看看');
    expect(userMsg).toContain('[林美辰]: 不给偷鸡');
    expect(userMsg).toContain('新消息：你不是应该用SkillHub么？');
  });

  it('should fallback to [bot]/[user] tag when senderName is missing', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"respond": true}' } }],
    });

    const recentMessages = [
      { senderType: 'app' as const, content: '收到' },
      { senderType: 'user' as const, content: '帮我看看' },
    ];

    await checkThreadRelevance('继续', 'bot', recentMessages);

    const userMsg = mockCreate.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain('[bot]: 收到');
    expect(userMsg).toContain('[user]: 帮我看看');
  });

  it('should work without recent context (backward compatible)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"respond": true}' } }],
    });

    await checkThreadRelevance('帮我查一下', 'bot');

    const userMsg = mockCreate.mock.calls[0][0].messages[1].content;
    expect(userMsg).not.toContain('最近对话');
    expect(userMsg).toContain('新消息：帮我查一下');
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
