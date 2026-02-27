import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { NoopEmbeddingProvider, DashScopeEmbeddingProvider } from '../embeddings.js';

describe('NoopEmbeddingProvider', () => {
  it('should have available = false', () => {
    const provider = new NoopEmbeddingProvider();
    expect(provider.available).toBe(false);
  });

  it('should use default dimension of 1024', () => {
    const provider = new NoopEmbeddingProvider();
    expect(provider.dimension).toBe(1024);
  });

  it('should accept custom dimension', () => {
    const provider = new NoopEmbeddingProvider(768);
    expect(provider.dimension).toBe(768);
  });

  it('should throw on embed()', async () => {
    const provider = new NoopEmbeddingProvider();
    await expect(provider.embed('test')).rejects.toThrow('NoopEmbeddingProvider');
  });

  it('should throw on embedBatch()', async () => {
    const provider = new NoopEmbeddingProvider();
    await expect(provider.embedBatch(['a', 'b'])).rejects.toThrow('NoopEmbeddingProvider');
  });
});

describe('DashScopeEmbeddingProvider', () => {
  it('should have available = false when no API key', () => {
    const provider = new DashScopeEmbeddingProvider(
      '', // empty key
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'text-embedding-v4',
      1024,
    );
    expect(provider.available).toBe(false);
  });

  it('should have available = true when API key is provided', () => {
    const provider = new DashScopeEmbeddingProvider(
      'sk-test-key',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'text-embedding-v4',
      1024,
    );
    expect(provider.available).toBe(true);
  });

  it('should report correct dimension', () => {
    const provider = new DashScopeEmbeddingProvider(
      'sk-test-key',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'text-embedding-v4',
      1024,
    );
    expect(provider.dimension).toBe(1024);
  });

  it('should throw when calling embed without available client', async () => {
    const provider = new DashScopeEmbeddingProvider(
      '', // no key → client won't initialize
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'text-embedding-v4',
      1024,
    );

    await expect(provider.embed('test')).rejects.toThrow();
  });
});
