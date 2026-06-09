// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

// Mutable config so individual tests can flip apiKey / depth etc.
// vi.hoisted so the value exists when the hoisted vi.mock factory runs.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    websearch: {
      enabled: true,
      apiKey: 'tvly-test-key',
      baseUrl: 'https://api.tavily.com',
      maxResults: 5,
      searchDepth: 'basic',
      timeoutMs: 15000,
    },
  },
}));
vi.mock('../../config.js', () => ({ config: mockConfig }));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Capture the handler registered via tool()
let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => {
    capturedHandler = handler as typeof capturedHandler;
    return { name: _name, handler };
  },
  createSdkMcpServer: (cfg: unknown) => ({ type: 'mock-server', cfg }),
}));

import { webSearchTool, createWebSearchMcpServer, formatTavilyResponse } from '../tool.js';

// ============================================================
// formatTavilyResponse (pure)
// ============================================================

describe('formatTavilyResponse', () => {
  it('formats answer + results', () => {
    const text = formatTavilyResponse(
      {
        answer: 'Messi is a footballer.',
        results: [
          { title: 'Lionel Messi', url: 'https://en.wikipedia.org/wiki/Lionel_Messi', content: 'Argentine footballer.', score: 0.99 },
          { title: 'Messi stats', url: 'https://example.com/messi', content: 'Career stats.' },
        ],
      },
      'who is messi',
    );
    expect(text).toContain('**摘要**: Messi is a footballer.');
    expect(text).toContain('找到 2 条结果');
    expect(text).toContain('1. Lionel Messi');
    expect(text).toContain('https://en.wikipedia.org/wiki/Lionel_Messi');
    expect(text).toContain('Argentine footballer.');
    expect(text).toContain('2. Messi stats');
  });

  it('handles empty results', () => {
    const text = formatTavilyResponse({ results: [] }, 'nonexistent zzz');
    expect(text).toContain('未找到 "nonexistent zzz" 的相关结果');
  });

  it('handles missing answer and missing fields gracefully', () => {
    const text = formatTavilyResponse({ results: [{ url: 'https://x.com' }] }, 'q');
    expect(text).not.toContain('**摘要**');
    expect(text).toContain('1. (无标题)');
    expect(text).toContain('https://x.com');
  });
});

// ============================================================
// web_search handler
// ============================================================

describe('web_search tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset config defaults each test
    mockConfig.websearch.apiKey = 'tvly-test-key';
    mockConfig.websearch.baseUrl = 'https://api.tavily.com';
    mockConfig.websearch.maxResults = 5;
    mockConfig.websearch.searchDepth = 'basic';
    mockConfig.websearch.timeoutMs = 15000;
    global.fetch = vi.fn();
    webSearchTool(); // registers tool() → captures handler
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when apiKey is missing', async () => {
    mockConfig.websearch.apiKey = '';
    const result = await capturedHandler({ query: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TAVILY_API_KEY');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls Tavily with correct endpoint, auth header and body', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ title: 'T', url: 'https://u', content: 'c' }] }),
    });

    await capturedHandler({ query: 'typescript news', max_results: 3, topic: 'news', time_range: 'week' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tvly-test-key');
    expect(opts.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body);
    expect(body.query).toBe('typescript news');
    expect(body.max_results).toBe(3);
    expect(body.topic).toBe('news');
    expect(body.time_range).toBe('week');
    expect(body.search_depth).toBe('basic');
    expect(body.include_answer).toBe(true);
  });

  it('returns formatted results on success', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: 'An answer.',
        results: [{ title: 'Result One', url: 'https://one.com', content: 'snippet' }],
      }),
    });

    const result = await capturedHandler({ query: 'q' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('**摘要**: An answer.');
    expect(result.content[0].text).toContain('Result One');
    expect(result.content[0].text).toContain('https://one.com');
  });

  it('clamps max_results to [1, 20]', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

    await capturedHandler({ query: 'q', max_results: 99 });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).max_results).toBe(20);

    global.fetch.mockClear();
    await capturedHandler({ query: 'q', max_results: 0 });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).max_results).toBe(1);
  });

  it('falls back to config defaults for depth and max_results', async () => {
    mockConfig.websearch.maxResults = 8;
    mockConfig.websearch.searchDepth = 'advanced';
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

    await capturedHandler({ query: 'q' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.max_results).toBe(8);
    expect(body.search_depth).toBe('advanced');
  });

  it('maps HTTP 401 to a key error', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const result = await capturedHandler({ query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('401');
    expect(result.content[0].text).toContain('TAVILY_API_KEY');
  });

  it('maps HTTP 429 to a rate-limit error', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 429, text: async () => '' });
    const result = await capturedHandler({ query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('限流');
  });

  it('maps other HTTP errors with status + body snippet', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const result = await capturedHandler({ query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP 500');
    expect(result.content[0].text).toContain('boom');
  });

  it('handles network errors', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await capturedHandler({ query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('搜索请求失败');
    expect(result.content[0].text).toContain('ECONNREFUSED');
  });

  it('reports timeout on AbortError', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    global.fetch.mockRejectedValue(abortErr);
    const result = await capturedHandler({ query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('超时');
  });
});

// ============================================================
// createWebSearchMcpServer
// ============================================================

describe('createWebSearchMcpServer', () => {
  it('builds an SDK MCP server named web-search', () => {
    const server = createWebSearchMcpServer() as any;
    expect(server.cfg.name).toBe('web-search');
    expect(server.cfg.tools).toHaveLength(1);
  });
});
