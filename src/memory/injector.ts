// ============================================================
// Memory System — Injector (search → system prompt fragment)
// ============================================================

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getHybridSearch } from './init.js';
import type { MemorySearchResult, MemoryType } from './types.js';

/** Context for memory injection */
export interface InjectionContext {
  agentId: string;
  userId?: string;
  workspaceDir?: string;
}

/** Type display names */
const TYPE_LABELS: Record<MemoryType, string> = {
  preference: '偏好',
  fact: '项目事实',
  state: '当前状态',
  decision: '过往决策',
  relation: '关系',
};

/** Group ordering for display */
const TYPE_ORDER: MemoryType[] = ['preference', 'fact', 'state', 'decision', 'relation'];

/**
 * Search for relevant memories and format as a system prompt fragment.
 * Returns empty string if no memories found or memory disabled.
 * Must be fast — runs before every query.
 */
export async function injectMemories(
  query: string,
  context: InjectionContext,
): Promise<string> {
  if (!config.memory.enabled) return '';

  const search = getHybridSearch();
  if (!search) return '';

  try {
    const results = await search.search({
      query,
      agentId: context.agentId,
      userId: context.userId,
      workspaceDir: context.workspaceDir,
      limit: 15,
    });

    if (results.length === 0) return '';

    return formatMemories(results);
  } catch (err) {
    logger.warn({ err }, 'Memory injection failed (non-blocking)');
    return '';
  }
}

/**
 * Format search results into a prompt fragment, respecting maxInjectTokens.
 */
export function formatMemories(results: MemorySearchResult[]): string {
  const maxChars = config.memory.maxInjectTokens * 3;

  // Group by type
  const groups = new Map<MemoryType, MemorySearchResult[]>();
  for (const r of results) {
    const existing = groups.get(r.memory.type) ?? [];
    existing.push(r);
    groups.set(r.memory.type, existing);
  }

  const lines: string[] = ['\n## 关于此用户的记忆\n'];
  let totalChars = lines[0].length;

  for (const type of TYPE_ORDER) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;

    const header = `### ${TYPE_LABELS[type]}`;
    if (totalChars + header.length + 1 > maxChars) break;
    lines.push(header);
    totalChars += header.length + 1;

    for (const r of group) {
      const mem = r.memory;
      let line: string;

      if (type === 'state' && mem.ttl) {
        line = `- ${mem.content} (预计到 ${mem.ttl.split('T')[0]})`;
      } else if (type === 'fact' && mem.validAt) {
        line = `- ${mem.content} (since ${mem.validAt.split('T')[0]})`;
      } else if (type === 'decision' && mem.createdAt) {
        line = `- ${mem.content} (${mem.createdAt.split('T')[0]})`;
      } else {
        const confidenceTag = mem.confidence < 0.6 ? ' (confidence: low)' : '';
        line = `- ${mem.content}${confidenceTag}`;
      }

      if (totalChars + line.length + 1 > maxChars) break;
      lines.push(line);
      totalChars += line.length + 1;
    }
  }

  if (lines.length <= 1) return '';

  return lines.join('\n');
}
