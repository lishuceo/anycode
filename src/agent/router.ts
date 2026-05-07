/**
 * Binding Router — 消息 → agent 角色的路由
 *
 * 纯配置匹配，不调用 LLM。与 Workspace Router (src/claude/router.ts) 独立：
 * - Binding Router: 选 agent 角色
 * - Workspace Router: 选工作目录
 */
import { logger } from '../utils/logger.js';
import type { AgentId, AgentBinding, BindingMatch, InboundContext } from './types.js';

/**
 * First-match-wins 路由
 *
 * 推荐 binding 顺序（具体到宽泛）：
 *   1. peer 匹配（特定群 → 特定 agent）
 *   2. userId 匹配（特定用户 → 特定 agent）
 *   3. accountId 匹配（bot 账号 → agent）
 *   4. wildcard（accountId: '*'）
 */
export function resolveAgent(
  bindings: AgentBinding[],
  inbound: InboundContext,
): AgentId {
  for (const binding of bindings) {
    if (matchesBinding(binding.match, inbound)) {
      logger.debug(
        { agentId: binding.agentId, accountId: inbound.accountId, chatId: inbound.chatId },
        'Binding matched',
      );
      return binding.agentId;
    }
  }
  // 兜底：单 bot 模式下走 dev agent（向后兼容）
  return 'dev';
}

function matchesBinding(match: BindingMatch, inbound: InboundContext): boolean {
  // accountId 匹配
  if (match.accountId && match.accountId !== '*' && match.accountId !== inbound.accountId) {
    return false;
  }

  // peer 匹配
  if (match.peer) {
    const expectedKind = inbound.chatType === 'p2p' ? 'direct' : 'group';
    if (match.peer.kind !== expectedKind) return false;
    if (match.peer.id !== inbound.chatId) return false;
  }

  // userId 匹配
  if (match.userId && match.userId !== inbound.userId) {
    return false;
  }

  return true;
}

/**
 * 启动时校验 binding 配置
 * 返回警告列表（不阻止启动）
 */
export function validateBindings(bindings: AgentBinding[]): string[] {
  const warnings: string[] = [];

  if (bindings.length === 0) {
    return warnings; // 单 bot 模式，无 binding 配置
  }

  // 检查 wildcard binding 是否指向写权限 agent
  const lastBinding = bindings[bindings.length - 1];
  if (lastBinding.match.accountId === '*' && lastBinding.agentId === 'dev') {
    warnings.push(
      'Wildcard binding (accountId: "*") points to "dev" agent (write access). ' +
      'Consider pointing it to "pm" (read-only) for safety.',
    );
  }

  // 检查是否存在重复的精确匹配
  const seen = new Set<string>();
  for (const b of bindings) {
    const key = `${b.match.accountId ?? '*'}:${b.match.peer?.id ?? '*'}:${b.match.userId ?? '*'}`;
    if (seen.has(key)) {
      warnings.push(`Duplicate binding match: ${key} (second one will never match)`);
    }
    seen.add(key);
  }

  return warnings;
}

/** 放行原因 — 用于 @mention 过滤器的白名单日志 */
export type RespondReason = 'p2p' | 'mentioned' | 'commander';

/**
 * 群内 @mention 路由 — 返回放行原因，undefined 表示不响应。
 *
 * 优先级：显式 @mention > commander 模式 > 不响应
 */
export function getRespondReason(
  chatType: string,
  mentions: Array<{ id: { open_id?: string } }>,
  botOpenId: string,
  allBotOpenIds: Set<string>,
  commanderBotOpenId?: string,
): RespondReason | undefined {
  if (chatType === 'p2p') return 'p2p';

  const mentionedBotIds = new Set<string>();
  for (const m of mentions) {
    if (m.id.open_id && allBotOpenIds.has(m.id.open_id)) {
      mentionedBotIds.add(m.id.open_id);
    }
  }

  if (mentionedBotIds.size > 0) {
    return mentionedBotIds.has(botOpenId) ? 'mentioned' : undefined;
  }

  if (commanderBotOpenId && botOpenId === commanderBotOpenId) return 'commander';

  return undefined;
}

/** 向后兼容 wrapper */
export function shouldRespond(
  chatType: string,
  mentions: Array<{ id: { open_id?: string } }>,
  botOpenId: string,
  allBotOpenIds: Set<string>,
  commanderBotOpenId?: string,
): boolean {
  return getRespondReason(chatType, mentions, botOpenId, allBotOpenIds, commanderBotOpenId) !== undefined;
}
