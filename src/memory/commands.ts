// ============================================================
// Memory System — Slash Commands & Card Action Handlers
// ============================================================

import { logger } from '../utils/logger.js';
import { feishuClient } from '../feishu/client.js';
import {
  buildMemoryListCard,
  buildMemorySearchCard,
  buildMemoryClearConfirmCard,
  buildMemoryResultCard,
} from '../feishu/message-builder.js';
import { getMemoryStore, getHybridSearch, isMemoryEnabled } from './init.js';
import { MemoryStore } from './store.js';
import type { MemoryType } from './types.js';
import { MEMORY_PAGE_SIZE } from './types.js';
import type { AgentId } from '../agent/types.js';

/** Chinese → English type mapping */
const TYPE_ALIASES: Record<string, MemoryType> = {
  fact: 'fact',
  事实: 'fact',
  preference: 'preference',
  偏好: 'preference',
  state: 'state',
  状态: 'state',
  decision: 'decision',
  决策: 'decision',
  relation: 'relation',
  关系: 'relation',
};

const HELP_TEXT = [
  '**记忆管理命令**',
  '',
  '`/memory` — 列出所有记忆',
  '`/memory list [类型]` — 按类型过滤 (偏好/事实/状态/决策/关系)',
  '`/memory search <关键词>` — 搜索记忆',
  '`/memory delete <id>` — 删除指定记忆',
  '`/memory clear` — 清除所有记忆',
  '`/memory help` — 显示此帮助',
].join('\n');

// ── Helper: send text or card, respecting thread context ──

async function sendReply(
  messageId: string,
  threadReplyMsgId: string | undefined,
  text: string,
): Promise<void> {
  if (threadReplyMsgId) {
    await feishuClient.replyTextInThread(threadReplyMsgId, text);
  } else {
    await feishuClient.replyText(messageId, text);
  }
}

async function sendCardReply(
  chatId: string,
  messageId: string,
  threadReplyMsgId: string | undefined,
  card: Record<string, unknown>,
  userId?: string,
): Promise<void> {
  // 优先使用临时卡片（仅发起人可见），话题内回退到普通卡片
  if (threadReplyMsgId) {
    await feishuClient.replyCardInThread(threadReplyMsgId, card);
  } else if (userId) {
    await feishuClient.sendEphemeralCard(chatId, userId, card);
  } else {
    await feishuClient.sendCard(chatId, card);
  }
}

// ============================================================
// Slash Command Handler
// ============================================================

/**
 * Handle /memory slash commands.
 * Returns void — sends responses directly via feishuClient.
 */
export async function handleMemoryCommand(
  args: string,
  chatId: string,
  userId: string,
  messageId: string,
  threadReplyMsgId?: string,
  agentId: AgentId = 'dev',
): Promise<void> {
  // Check if memory system is enabled
  if (!isMemoryEnabled()) {
    await sendReply(messageId, threadReplyMsgId, '记忆系统未启用');
    return;
  }

  const store = getMemoryStore();
  if (!store) {
    await sendReply(messageId, threadReplyMsgId, '记忆系统未初始化');
    return;
  }

  const parts = args.split(/\s+/).filter(Boolean);
  const subcommand = parts[0]?.toLowerCase() ?? '';

  try {
    if (!subcommand || subcommand === 'list') {
      await handleList(store, parts.slice(subcommand === 'list' ? 1 : 0), chatId, userId, messageId, threadReplyMsgId, agentId);
    } else if (subcommand === 'search') {
      await handleSearch(parts.slice(1).join(' '), chatId, userId, messageId, threadReplyMsgId, agentId);
    } else if (subcommand === 'delete') {
      await handleDeleteCmd(store, parts[1], userId, messageId, threadReplyMsgId);
    } else if (subcommand === 'clear') {
      await handleClear(store, chatId, userId, messageId, threadReplyMsgId, agentId);
    } else if (subcommand === 'help') {
      await sendReply(messageId, threadReplyMsgId, HELP_TEXT);
    } else {
      await sendReply(messageId, threadReplyMsgId, `未知子命令: ${subcommand.slice(0, 50)}\n\n${HELP_TEXT}`);
    }
  } catch (err) {
    logger.error({ err, args }, 'Memory command failed');
    await sendReply(messageId, threadReplyMsgId, '记忆命令执行失败，请稍后重试');
  }
}

// ── /memory list [type] ──

async function handleList(
  store: MemoryStore,
  typeArgs: string[],
  chatId: string,
  userId: string,
  messageId: string,
  threadReplyMsgId: string | undefined,
  agentId: AgentId,
): Promise<void> {
  const typeFilter = typeArgs[0] ? TYPE_ALIASES[typeArgs[0].toLowerCase()] : undefined;
  if (typeArgs[0] && !typeFilter) {
    await sendReply(messageId, threadReplyMsgId,
      `未知类型: ${typeArgs[0].slice(0, 50)}，支持: 偏好/事实/状态/决策/关系`);
    return;
  }

  const { memories, total } = store.list(agentId, userId, {
    type: typeFilter,
    limit: MEMORY_PAGE_SIZE,
    offset: 0,
  });
  const stats = store.countByType(agentId, userId);
  const totalPages = Math.max(1, Math.ceil(total / MEMORY_PAGE_SIZE));

  const card = buildMemoryListCard(memories, 1, totalPages, stats, agentId, userId, typeFilter);
  await sendCardReply(chatId, messageId, threadReplyMsgId, card, userId);
}

// ── /memory search <keyword> ──

async function handleSearch(
  keyword: string,
  chatId: string,
  userId: string,
  messageId: string,
  threadReplyMsgId: string | undefined,
  agentId: AgentId,
): Promise<void> {
  if (!keyword.trim()) {
    await sendReply(messageId, threadReplyMsgId, '用法: `/memory search <关键词>`');
    return;
  }

  const search = getHybridSearch();
  if (!search) {
    await sendReply(messageId, threadReplyMsgId, '搜索功能不可用');
    return;
  }

  const results = await search.search({
    query: keyword,
    agentId,
    userId,
    limit: 10,
  });

  const card = buildMemorySearchCard(results, keyword, userId);
  await sendCardReply(chatId, messageId, threadReplyMsgId, card, userId);
}

// ── /memory delete <id> ──

async function handleDeleteCmd(
  store: MemoryStore,
  memoryId: string | undefined,
  userId: string,
  messageId: string,
  threadReplyMsgId: string | undefined,
): Promise<void> {
  if (!memoryId) {
    await sendReply(messageId, threadReplyMsgId, '用法: `/memory delete <记忆ID>`');
    return;
  }

  const memory = store.get(memoryId);
  if (!memory) {
    await sendReply(messageId, threadReplyMsgId, `记忆不存在: ${memoryId}`);
    return;
  }

  // Check ownership: user can only delete their own memories or memories with no user
  if (memory.userId && memory.userId !== userId) {
    await sendReply(messageId, threadReplyMsgId, '无权删除他人的记忆');
    return;
  }

  const deleted = store.delete(memoryId);
  if (deleted) {
    await sendReply(messageId, threadReplyMsgId,
      `已删除记忆: "${memory.content.slice(0, 80)}${memory.content.length > 80 ? '...' : ''}"`);
  } else {
    await sendReply(messageId, threadReplyMsgId, '删除失败');
  }
}

// ── /memory clear ──

async function handleClear(
  store: MemoryStore,
  chatId: string,
  userId: string,
  messageId: string,
  threadReplyMsgId: string | undefined,
  agentId: AgentId,
): Promise<void> {
  // ownedOnly: only count user's own memories (not shared ones with user_id=NULL)
  const stats = store.countByType(agentId, userId, { ownedOnly: true });
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total === 0) {
    await sendReply(messageId, threadReplyMsgId, '暂无记忆记录');
    return;
  }

  const card = buildMemoryClearConfirmCard(total, agentId, userId);
  await sendCardReply(chatId, messageId, threadReplyMsgId, card, userId);
}

// ============================================================
// Card Action Handler
// ============================================================

/**
 * Handle memory-related card button actions.
 * Returns the card to replace the current one, or empty object to dismiss.
 */
export function handleMemoryCardAction(
  actionType: string,
  value: Record<string, unknown> | undefined,
  operatorId: string,
): Record<string, unknown> {
  if (!isMemoryEnabled()) {
    return buildMemoryResultCard('记忆系统未启用', false);
  }

  const store = getMemoryStore();
  if (!store) {
    return buildMemoryResultCard('记忆系统未初始化', false);
  }

  try {
    switch (actionType) {
      case 'memory_delete':
        return handleDeleteAction(store, value, operatorId);

      case 'memory_clear_request':
        return handleClearRequest(store, value, operatorId);

      case 'memory_clear_confirm':
        return handleClearConfirm(store, value, operatorId);

      case 'memory_page':
        return handlePageAction(store, value, operatorId);

      case 'memory_cancel':
        return buildMemoryResultCard('已取消', true);

      default:
        return buildMemoryResultCard(`未知操作: ${actionType}`, false);
    }
  } catch (err) {
    logger.error({ err, actionType }, 'Memory card action failed');
    return buildMemoryResultCard('操作失败，请稍后重试', false);
  }
}

function handleDeleteAction(
  store: MemoryStore,
  value: Record<string, unknown> | undefined,
  operatorId: string,
): Record<string, unknown> {
  const memoryId = value?.memoryId as string | undefined;
  if (!memoryId) return buildMemoryResultCard('缺少记忆 ID', false);

  const memory = store.get(memoryId);
  if (!memory) return buildMemoryResultCard('记忆不存在或已被删除', false);

  // Only check against the actual DB record, not client-provided userId
  // Return toast so the card stays unchanged (non-owner click has no visible effect)
  if (memory.userId && memory.userId !== operatorId) {
    return { toast: { type: 'error', content: '无权操作此卡片' } };
  }

  const deleted = store.delete(memoryId);
  if (deleted) {
    return buildMemoryResultCard(
      `已删除: "${memory.content.slice(0, 80)}${memory.content.length > 80 ? '...' : ''}"`,
      true,
    );
  }
  return buildMemoryResultCard('删除失败', false);
}

function handleClearRequest(
  store: MemoryStore,
  value: Record<string, unknown> | undefined,
  operatorId: string,
): Record<string, unknown> {
  const agentId = (value?.agentId as string) ?? 'dev';
  const userId = (value?.userId as string) ?? operatorId;
  if (operatorId !== userId) {
    return { toast: { type: 'error', content: '无权操作此卡片' } };
  }

  // ownedOnly: only count user's own memories (not shared ones with user_id=NULL)
  const stats = store.countByType(agentId, userId, { ownedOnly: true });
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total === 0) return buildMemoryResultCard('暂无记忆记录', true);

  return buildMemoryClearConfirmCard(total, agentId, userId);
}

function handleClearConfirm(
  store: MemoryStore,
  value: Record<string, unknown> | undefined,
  operatorId: string,
): Record<string, unknown> {
  const agentId = (value?.agentId as string) ?? 'dev';
  const userId = (value?.userId as string) ?? operatorId;
  if (operatorId !== userId) {
    return { toast: { type: 'error', content: '无权操作此卡片' } };
  }

  const count = store.deleteAll(agentId, userId);
  return buildMemoryResultCard(`已清除 ${count} 条记忆`, true);
}

function handlePageAction(
  store: MemoryStore,
  value: Record<string, unknown> | undefined,
  operatorId: string,
): Record<string, unknown> {
  const rawPage = value?.page;
  const page = (typeof rawPage === 'number' && Number.isInteger(rawPage) && rawPage >= 1) ? rawPage : 1;
  const agentId = (value?.agentId as string) ?? 'dev';
  const userId = (value?.userId as string) ?? operatorId;
  const typeFilter = value?.type as string | undefined;

  // Authorization: operator can only view their own memories
  if (operatorId !== userId) {
    return { toast: { type: 'error', content: '无权操作此卡片' } };
  }

  const { memories, total } = store.list(agentId, userId, {
    type: typeFilter as MemoryType | undefined,
    limit: MEMORY_PAGE_SIZE,
    offset: (page - 1) * MEMORY_PAGE_SIZE,
  });
  const stats = store.countByType(agentId, userId);
  const totalPages = Math.max(1, Math.ceil(total / MEMORY_PAGE_SIZE));

  return buildMemoryListCard(memories, page, totalPages, stats, agentId, userId, typeFilter);
}
