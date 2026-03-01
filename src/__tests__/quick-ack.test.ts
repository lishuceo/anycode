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

import { generateQuickAck, _resetClient } from '../utils/quick-ack.js';
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

  it('should return generated text on success', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '好的马上看' } }],
    });

    const result = await generateQuickAck('帮我看看这个bug');

    expect(result).toBe('好的马上看');
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'qwen3.5-flash',
        max_tokens: 30,
        temperature: 0.8,
      }),
    );
  });

  it('should truncate user message to 200 chars', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'OK' } }],
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
        choices: [{ message: { content: 'too late' } }],
      }), 200)),
    );

    const result = await generateQuickAck('hello');

    expect(result).toBeNull();
  });

  it('should include persona hint in system prompt when provided', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '收到' } }],
    });

    await generateQuickAck('hello', '你是一个友好的PM助手');

    const call = mockCreate.mock.calls[0][0];
    const systemMsg = call.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg.content).toContain('你的角色设定：你是一个友好的PM助手');
  });
});
