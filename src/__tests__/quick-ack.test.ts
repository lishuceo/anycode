import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger (must be before module-under-test import)
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config before importing module under test
vi.mock('../config.js', () => ({
  config: {
    dashscope: {
      apiKey: 'test-key',
      baseUrl: 'https://test.example.com/v1',
    },
    quickAck: {
      enabled: true,
      model: 'qwen3.5-flash',
      timeoutMs: 1500,
    },
  },
}));

// Mock openai SDK
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    constructor() {}
  },
}));

import { generateQuickAck, parseQuickAckResponse, _resetClient } from '../utils/quick-ack.js';
import { config } from '../config.js';

describe('quick-ack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetClient();
    // Reset config to enabled state
    (config.quickAck as { enabled: boolean }).enabled = true;
    (config.dashscope as { apiKey: string }).apiKey = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return QuickAckResult with type and text for commands', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"type":"other","text":"好的马上看"}' } }],
    });

    const result = await generateQuickAck('帮我看看这个bug');

    expect(result).toEqual({ type: 'other', text: '好的马上看' });
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('should return greeting type for pure greetings', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"type":"greeting","text":"嗨 在呢"}' } }],
    });

    const result = await generateQuickAck('你好');

    expect(result).toEqual({ type: 'greeting', text: '嗨 在呢' });
  });

  it('should truncate user message to 200 chars', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"type":"other","text":"OK"}' } }],
    });

    const longMsg = 'a'.repeat(500);
    await generateQuickAck(longMsg);

    const call = mockCreate.mock.calls[0][0];
    const userMsg = call.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.content).toHaveLength(200);
  });

  it('should return null when disabled', async () => {
    (config.quickAck as { enabled: boolean }).enabled = false;

    const result = await generateQuickAck('hello');

    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should return null when API key is missing', async () => {
    (config.dashscope as { apiKey: string }).apiKey = '';
    _resetClient(); // Force re-init

    const result = await generateQuickAck('hello');

    expect(result).toBeNull();
  });

  it('should return null when API returns empty content', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '' } }],
    });

    const result = await generateQuickAck('hello');

    expect(result).toBeNull();
  });

  it('should return null when API call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API error'));

    const result = await generateQuickAck('hello');

    expect(result).toBeNull();
  });

  it('should return null on timeout', async () => {
    (config.quickAck as { timeoutMs: number }).timeoutMs = 50;
    _resetClient();

    // Simulate slow API call
    mockCreate.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({
        choices: [{ message: { content: '{"type":"other","text":"too late"}' } }],
      }), 200)),
    );

    const result = await generateQuickAck('hello');

    expect(result).toBeNull();
  });

  it('should include persona hint in system prompt when provided', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"type":"other","text":"收到"}' } }],
    });

    await generateQuickAck('hello', '你是一个友好的PM助手');

    const call = mockCreate.mock.calls[0][0];
    const systemMsg = call.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg.content).toContain('你的角色设定：你是一个友好的PM助手');
  });
});

describe('parseQuickAckResponse', () => {
  it('should parse valid JSON response', () => {
    const result = parseQuickAckResponse('{"type":"greeting","text":"你好呀"}');
    expect(result).toEqual({ type: 'greeting', text: '你好呀' });
  });

  it('should parse JSON wrapped in markdown code block', () => {
    const result = parseQuickAckResponse('```json\n{"type":"other","text":"收到"}\n```');
    expect(result).toEqual({ type: 'other', text: '收到' });
  });

  it('should default unknown type to "other"', () => {
    const result = parseQuickAckResponse('{"type":"unknown","text":"好的"}');
    expect(result).toEqual({ type: 'other', text: '好的' });
  });

  it('should fallback to raw text as "other" when JSON is invalid', () => {
    const result = parseQuickAckResponse('好的马上看');
    expect(result).toEqual({ type: 'other', text: '好的马上看' });
  });

  it('should return null for empty string', () => {
    const result = parseQuickAckResponse('');
    expect(result).toBeNull();
  });

  it('should handle JSON with empty text by falling back', () => {
    const result = parseQuickAckResponse('{"type":"greeting","text":""}');
    // Empty text in JSON → fallback to raw string which contains JSON
    expect(result).not.toBeNull();
    expect(result?.type).toBe('other');
  });
});
