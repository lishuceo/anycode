// ============================================================
// Memory System — Embedding Providers
// ============================================================

import { logger } from '../utils/logger.js';

/** Common interface for embedding providers */
export interface EmbeddingProvider {
  /** Whether this provider is available (has API key, etc.) */
  readonly available: boolean;
  /** Vector dimension */
  readonly dimension: number;
  /** Generate embedding for a single text */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for multiple texts */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * DashScope embedding provider using OpenAI-compatible API.
 * Uses the `openai` npm package to call DashScope's compatible-mode endpoint.
 */
export class DashScopeEmbeddingProvider implements EmbeddingProvider {
  private client: import('openai').default | null = null;
  private readonly model: string;
  readonly dimension: number;
  readonly available: boolean;

  constructor(
    apiKey: string,
    baseUrl: string,
    model: string,
    dimension: number,
  ) {
    this.model = model;
    this.dimension = dimension;
    this.available = !!apiKey;

    if (this.available) {
      // Lazy-import openai to avoid hard dependency when not used
      import('openai').then((mod) => {
        const OpenAI = mod.default;
        this.client = new OpenAI({
          apiKey,
          baseURL: baseUrl,
        });
      }).catch((err) => {
        logger.warn({ err }, 'Failed to import openai SDK, embedding unavailable');
        (this as { available: boolean }).available = false;
      });
    }
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error('DashScope embedding provider not available');
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimension,
    });

    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

/**
 * No-op embedding provider for BM25-only fallback mode.
 * Always reports as unavailable.
 */
export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly available = false;
  readonly dimension: number;

  constructor(dimension: number = 1024) {
    this.dimension = dimension;
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error('NoopEmbeddingProvider: embedding not available');
  }

  async embedBatch(_texts: string[]): Promise<number[][]> {
    throw new Error('NoopEmbeddingProvider: embedding not available');
  }
}
