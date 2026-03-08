// ============================================================
// Memory System — MCP Tool: memory_search
//
// Exposes memory search as an MCP tool so the Agent can
// actively query long-term memory, including archived
// (superseded/invalidated) records for historical context.
// ============================================================

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import type { MemoryStore } from '../store.js';
import type { HybridSearch } from '../search.js';
import type { Memory, MemoryType } from '../types.js';

/** Context needed to scope searches */
export interface MemorySearchToolContext {
  agentId: string;
  userId?: string;
  workspaceDir?: string;
}

/**
 * Create a memory-search MCP server.
 * Called per-query so the context is bound via closure.
 */
export function createMemorySearchMcpServer(
  store: MemoryStore,
  search: HybridSearch,
  context: MemorySearchToolContext,
) {
  return createSdkMcpServer({
    name: 'memory-tools',
    version: '1.0.0',
    tools: [
      tool(
        'memory_search',
        [
          '搜索长期记忆，包括已归档的历史记忆。',
          '当需要了解历史背景、过去的决策理由、事实变迁等上下文时使用。',
          '',
          '示例场景:',
          '- 用户问"为什么不用 MySQL" → 搜索 includeArchived=true',
          '- 用户问"我们的数据库是什么" → 搜索 includeArchived=false',
          '- 用户问"这个项目的历史决策" → 搜索 types=["decision"], includeArchived=true',
        ].join('\n'),
        {
          query: z.string().describe('搜索关键词或自然语言问题'),
          includeArchived: z.boolean().optional().default(false)
            .describe('是否包含已失效的历史记忆（用于溯源类问题）'),
          types: z.array(z.enum(['fact', 'preference', 'state', 'decision', 'relation']))
            .optional()
            .describe('限定搜索的记忆类型'),
          limit: z.number().optional().default(10)
            .describe('返回数量上限 (最大 30)'),
        },
        async (args) => {
          try {
            const limit = Math.min(args.limit ?? 10, 30);

            const results = await search.search({
              query: args.query,
              agentId: context.agentId,
              userId: context.userId,
              workspaceDir: context.workspaceDir,
              types: args.types as MemoryType[] | undefined,
              limit,
              includeInvalid: args.includeArchived,
            });

            if (results.length === 0) {
              return {
                content: [{
                  type: 'text' as const,
                  text: '未找到相关记忆。',
                }],
              };
            }

            // Format results, including supersede chain when available
            const lines: string[] = [`找到 ${results.length} 条相关记忆:\n`];

            for (const r of results) {
              const mem = r.memory;
              const status = mem.invalidAt ? '(已归档)' : '';
              const score = r.finalScore.toFixed(3);

              lines.push(`---`);
              lines.push(`**${mem.content}** ${status}`);
              lines.push(`  类型: ${mem.type} | 置信度: ${mem.confidence} | 得分: ${score}`);

              if (mem.validAt) {
                lines.push(`  生效: ${mem.validAt.split('T')[0]}`);
              }
              if (mem.invalidAt) {
                lines.push(`  失效: ${mem.invalidAt.split('T')[0]}`);
              }
              if (mem.supersedeReason) {
                lines.push(`  替代原因: ${mem.supersedeReason}`);
              }

              // Walk supersede chain backwards for context
              if (mem.supersedes || mem.supersededBy) {
                const chain = store.getSupersedChain(mem.id);
                if (chain.length > 0) {
                  lines.push(`  历史链:`);
                  for (const ancestor of chain) {
                    const reason = ancestor.supersededBy
                      ? getSuccessorReason(store, ancestor.supersededBy)
                      : '';
                    const reasonStr = reason ? ` (原因: ${reason})` : '';
                    lines.push(`    <- ${ancestor.content}${reasonStr}`);
                  }
                }
              }
            }

            logger.info(
              { query: args.query, includeArchived: args.includeArchived, resultCount: results.length },
              'memory_search MCP tool invoked',
            );

            return {
              content: [{
                type: 'text' as const,
                text: lines.join('\n'),
              }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ err: msg, query: args.query }, 'memory_search tool failed');
            return {
              content: [{
                type: 'text' as const,
                text: `记忆搜索失败: ${msg}`,
              }],
              isError: true,
            };
          }
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
      ),
    ],
  });
}

/** Helper: get the supersedeReason from the successor memory */
function getSuccessorReason(store: MemoryStore, successorId: string): string {
  const successor = store.get(successorId);
  return successor?.supersedeReason ?? '';
}
