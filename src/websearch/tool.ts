// ============================================================
// Web Search — MCP Tool: web_search (Tavily)
//
// 通过 Tavily Search API 提供联网搜索能力。
//
// 为什么需要它：Claude Code 内置的 WebSearch 是 Anthropic 服务端工具，
// 当本服务通过 ANTHROPIC_BASE_URL 走代理/网关（如 litellm）时，
// 网关并不实现该服务端工具，导致内置 WebSearch 失效。
// MCP 工具在本进程内（客户端）执行 HTTP 请求，不依赖上游网关，因此可用。
// ============================================================

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Tavily /search 接口返回的单条结果（仅取用到的字段） */
interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

/** Tavily /search 接口返回体（仅取用到的字段） */
export interface TavilyResponse {
  query?: string;
  answer?: string;
  results?: TavilyResult[];
  response_time?: number;
}

/**
 * 把 Tavily 返回体格式化为适合在飞书聊天里阅读的纯文本。
 * 纯函数，便于单元测试。
 */
export function formatTavilyResponse(data: TavilyResponse, query: string): string {
  const lines: string[] = [];

  if (data.answer?.trim()) {
    lines.push(`**摘要**: ${data.answer.trim()}`, '');
  }

  const results = data.results ?? [];
  if (results.length === 0) {
    lines.push(`未找到 "${query}" 的相关结果。`);
    return lines.join('\n');
  }

  lines.push(`找到 ${results.length} 条结果:`, '');
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title?.trim() || '(无标题)'}`);
    if (r.url) lines.push(`   ${r.url}`);
    if (r.content?.trim()) lines.push(`   ${r.content.trim()}`);
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}

/** 把 HTTP 状态码映射为可读的错误提示 */
function describeHttpError(status: number, body: string): string {
  const snippet = body.slice(0, 200);
  switch (status) {
    case 401:
      return 'Tavily API key 无效或缺失 (401)。请检查 TAVILY_API_KEY 配置。';
    case 429:
      return 'Tavily 请求过于频繁，已被限流 (429)。请稍后重试。';
    case 432:
    case 433:
      return `Tavily 套餐额度已用尽 (${status})。`;
    default:
      return `Tavily 搜索失败 (HTTP ${status})${snippet ? `: ${snippet}` : ''}`;
  }
}

/**
 * web_search MCP 工具定义。
 * 返回 SDK tool()，handler 内通过 fetch 调用 Tavily /search。
 */
export function webSearchTool() {
  return tool(
    'web_search',
    [
      '联网搜索 — 通过 Tavily 搜索引擎获取最新的网络信息。',
      '当需要查询实时信息、新闻、文档、未知概念，或验证训练数据之外的事实时使用。',
      '返回相关网页的标题、URL 和摘要片段，并可附带一段综合性答案摘要。',
      '',
      '注意：这是本服务对内置 WebSearch 的替代实现（内置 WebSearch 在当前网关下不可用）。',
    ].join('\n'),
    {
      query: z.string().describe('搜索关键词或自然语言问题'),
      max_results: z.number().optional().describe('返回结果数 (1-20，默认 5)'),
      topic: z.enum(['general', 'news', 'finance']).optional()
        .describe('搜索主题：general(默认) / news(新闻) / finance(财经)'),
      search_depth: z.enum(['basic', 'advanced']).optional()
        .describe('搜索深度：basic(默认，1 credit) / advanced(更全面，2 credits)'),
      time_range: z.enum(['day', 'week', 'month', 'year']).optional()
        .describe('时间范围限制（可选），如 news 主题查最近一周用 week'),
      include_answer: z.boolean().optional()
        .describe('是否返回综合答案摘要（默认 true）'),
    },
    async (args) => {
      const apiKey = config.websearch.apiKey;
      if (!apiKey) {
        return {
          content: [{ type: 'text' as const, text: 'web_search 未配置：缺少 TAVILY_API_KEY 环境变量。' }],
          isError: true,
        };
      }

      const maxResults = Math.min(Math.max(args.max_results ?? config.websearch.maxResults, 1), 20);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.websearch.timeoutMs);

      try {
        const resp = await fetch(`${config.websearch.baseUrl}/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query: args.query,
            search_depth: args.search_depth ?? config.websearch.searchDepth,
            topic: args.topic ?? 'general',
            max_results: maxResults,
            include_answer: args.include_answer ?? true,
            ...(args.time_range ? { time_range: args.time_range } : {}),
          }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          const detail = describeHttpError(resp.status, body);
          logger.warn({ status: resp.status, query: args.query }, 'web_search Tavily API error');
          return {
            content: [{ type: 'text' as const, text: detail }],
            isError: true,
          };
        }

        const data = (await resp.json()) as TavilyResponse;
        logger.info(
          { query: args.query, resultCount: data.results?.length ?? 0, hasAnswer: !!data.answer },
          'web_search invoked',
        );

        return {
          content: [{ type: 'text' as const, text: formatTavilyResponse(data, args.query) }],
        };
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const msg = isAbort
          ? `搜索超时（超过 ${config.websearch.timeoutMs}ms）。请稍后重试或简化查询。`
          : `搜索请求失败: ${err instanceof Error ? err.message : String(err)}`;
        logger.error({ err: msg, query: args.query, isAbort }, 'web_search failed');
        return {
          content: [{ type: 'text' as const, text: msg }],
          isError: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        // 查询开放网络，结果不可预先枚举
        openWorldHint: true,
      },
    },
  );
}

/**
 * 创建 web-search MCP 服务器。
 * 每次 query 创建独立实例（与其它 MCP server 一致），工具读取全局 config。
 */
export function createWebSearchMcpServer() {
  return createSdkMcpServer({
    name: 'web-search',
    version: '1.0.0',
    tools: [webSearchTool()],
  });
}
