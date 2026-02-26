import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { isOwner } from '../utils/security.js';
import { feishuClient } from './client.js';
import { sessionManager } from '../session/manager.js';
import { buildApprovalCard, buildApprovalResultCard } from './message-builder.js';

/** 待审批请求 */
interface PendingApproval {
  id: string;
  userId: string;
  userName: string;
  chatId: string;
  chatType: string;
  threadId: string;
  messagePreview: string;
  messageId: string;
  rootId?: string;
  threadReplyMsgId?: string;
  /** 审批卡片的消息 ID（用于更新卡片） */
  approvalMsgId?: string;
  createdAt: number;
}

/** 内存中的待审批请求 */
const pendingApprovals = new Map<string, PendingApproval>();

/** threadId → approvalId 快速查找 */
const threadToApproval = new Map<string, string>();

/** 已审批但 thread 尚未创建时的临时标记（chatId:userId → 时间戳） */
const preApprovedUsers = new Map<string, number>();

let approvalCounter = 0;

function generateApprovalId(): string {
  return `approval_${Date.now()}_${++approvalCounter}`;
}

// ============================================================
// 回调机制：避免循环依赖
// ============================================================

type OnApprovedCallback = (chatId: string, userId: string, text: string, messageId: string, rootId?: string, threadId?: string) => void;
let onApprovedCallback: OnApprovedCallback | undefined;

/**
 * 注册消息重新入队回调（由 event-handler.ts 在初始化时调用）
 */
export function setOnApproved(callback: OnApprovedCallback): void {
  onApprovedCallback = callback;
}

// ============================================================
// PreApproved 机制
// ============================================================

const PRE_APPROVED_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * 检查用户是否已预审批（thread 尚未创建时）
 */
export function checkPreApproved(chatId: string, userId: string): boolean {
  const key = `${chatId}:${userId}`;
  const ts = preApprovedUsers.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > PRE_APPROVED_TTL_MS) {
    preApprovedUsers.delete(key);
    return false;
  }
  return true;
}

/**
 * 消费预审批标记（thread 创建后调用，将标记持久化到 DB）
 */
export function consumePreApproved(chatId: string, userId: string): boolean {
  return preApprovedUsers.delete(`${chatId}:${userId}`);
}

// ============================================================
// 审批检查
// ============================================================

/**
 * 检查是否需要审批。非阻塞：需要审批时发卡片并返回 false。
 * 返回 true 表示可以处理消息，false 表示已拦截（等待审批）。
 */
export async function checkAndRequestApproval(
  userId: string,
  chatId: string,
  chatType: string,
  text: string,
  messageId: string,
  rootId?: string,
  threadReplyMsgId?: string,
  threadId?: string,
): Promise<boolean> {
  // ownerUserId 未配置 → 跳过审批（向后兼容）
  if (!config.security.ownerUserId) return true;

  // Owner 免审批
  if (isOwner(userId)) return true;

  // 预审批通过（审批通过但 thread 尚未创建的情况）
  if (checkPreApproved(chatId, userId)) return true;

  // Thread 已 approved
  if (threadId) {
    const threadSession = sessionManager.getThreadSession(threadId);
    if (threadSession?.approved === true) return true;
  }

  // 已有 pending approval → 通知用户等待
  if (threadId && threadToApproval.has(threadId)) {
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, '⏳ 等待管理员授权中...');
    } else {
      await feishuClient.replyText(messageId, '⏳ 等待管理员授权中...');
    }
    return false;
  }

  // 获取用户名（best-effort，失败时用 userId）
  const userName = await feishuClient.getUserName(userId, chatId) || userId;

  // 需要审批：创建 pending 并通知 owner
  const approvalId = generateApprovalId();
  const pending: PendingApproval = {
    id: approvalId,
    userId,
    userName,
    chatId,
    chatType,
    threadId: threadId || '',
    messagePreview: text,
    messageId,
    rootId,
    threadReplyMsgId,
    createdAt: Date.now(),
  };

  pendingApprovals.set(approvalId, pending);
  if (threadId) {
    threadToApproval.set(threadId, approvalId);
  }

  logger.info({ approvalId, userId, chatId, threadId }, 'Approval requested');

  // 异步发送审批请求
  sendApprovalRequest(pending).catch((err) => {
    logger.error({ err, approvalId }, 'Failed to send approval request');
    pendingApprovals.delete(approvalId);
    if (threadId) threadToApproval.delete(threadId);
  });

  return false;
}

// ============================================================
// 审批请求发送
// ============================================================

async function sendApprovalRequest(pending: PendingApproval): Promise<void> {
  const ownerUserId = config.security.ownerUserId;
  const card = buildApprovalCard(
    pending.id,
    pending.userName,
    pending.messagePreview,
    pending.chatType === 'group' ? 'group' : 'p2p',
  );

  let approvalMsgId: string | undefined;

  if (pending.chatType === 'group') {
    // 群聊：在同一群/话题中发送审批卡片
    if (pending.threadReplyMsgId) {
      approvalMsgId = await feishuClient.replyCardInThread(pending.threadReplyMsgId, card) ?? undefined;
    } else {
      approvalMsgId = await feishuClient.sendCard(pending.chatId, card) ?? undefined;
    }
  } else {
    // 私聊：发送审批卡片给 owner（通过 open_id）
    approvalMsgId = await feishuClient.sendCardToUser(ownerUserId, card) ?? undefined;
  }

  if (approvalMsgId) {
    pending.approvalMsgId = approvalMsgId;
  }

  // 通知请求者
  if (pending.threadReplyMsgId) {
    await feishuClient.replyTextInThread(pending.threadReplyMsgId, '⏳ 已通知管理员，等待授权...');
  } else {
    await feishuClient.replyText(pending.messageId, '⏳ 已通知管理员，等待授权...');
  }
}

// ============================================================
// 审批处理
// ============================================================

/**
 * 处理审批结果（卡片按钮或文本命令触发）
 */
export function resolveApproval(approvalId: string, approved: boolean): PendingApproval | undefined {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return undefined;

  // 清理内存
  pendingApprovals.delete(approvalId);
  if (pending.threadId) {
    threadToApproval.delete(pending.threadId);
  }

  // 持久化审批状态
  if (approved && pending.threadId) {
    sessionManager.setThreadApproved(pending.threadId, true);
  } else if (approved && !pending.threadId) {
    // Thread 尚未创建，存入预审批集合（带 TTL）
    preApprovedUsers.set(`${pending.chatId}:${pending.userId}`, Date.now());
  }

  // 更新审批卡片
  if (pending.approvalMsgId) {
    feishuClient.updateCard(
      pending.approvalMsgId,
      buildApprovalResultCard(pending.userName, approved),
    ).catch((err) => {
      logger.warn({ err }, 'Failed to update approval card');
    });
  }

  if (approved) {
    // 通知用户并重新入队消息
    const notification = '✅ 管理员已授权，正在处理你的消息...';
    if (pending.threadReplyMsgId) {
      feishuClient.replyTextInThread(pending.threadReplyMsgId, notification).catch(() => {});
    } else {
      feishuClient.replyText(pending.messageId, notification).catch(() => {});
    }

    // 重新入队原始消息
    if (onApprovedCallback) {
      onApprovedCallback(pending.chatId, pending.userId, pending.messagePreview, pending.messageId, pending.rootId, pending.threadId || undefined);
    }
  } else {
    const notification = '❌ 管理员已拒绝你的请求';
    if (pending.threadReplyMsgId) {
      feishuClient.replyTextInThread(pending.threadReplyMsgId, notification).catch(() => {});
    } else {
      feishuClient.replyText(pending.messageId, notification).catch(() => {});
    }
  }

  logger.info({ approvalId, userId: pending.userId, threadId: pending.threadId, approved }, 'Approval resolved');

  return pending;
}

// ============================================================
// 文本命令处理
// ============================================================

/**
 * 处理 owner 的文本审批命令（"允许"/"拒绝"）
 * 返回 true 表示已处理，false 表示不是审批命令
 */
export function handleApprovalTextCommand(
  text: string,
  userId: string,
  chatId: string,
  /** 话题标识（优先 thread_id，fallback root_id） */
  threadId?: string,
): boolean {
  if (!isOwner(userId)) return false;

  const trimmed = text.trim();
  if (trimmed !== '允许' && trimmed !== '拒绝') return false;

  const approved = trimmed === '允许';

  // 按 threadId 查找对应的 pending approval
  if (threadId) {
    const approvalId = threadToApproval.get(threadId);
    if (approvalId) {
      resolveApproval(approvalId, approved);
      return true;
    }
  }

  // Fallback：在该 chat 中查找最新的 pending approval
  for (const [id, pending] of pendingApprovals) {
    if (pending.chatId === chatId) {
      resolveApproval(id, approved);
      return true;
    }
  }

  return false;
}

// ============================================================
// 卡片动作处理
// ============================================================

/**
 * 处理审批卡片按钮点击
 */
export function handleApprovalCardAction(
  actionType: string,
  approvalId: string,
  operatorId: string,
): Record<string, unknown> {
  if (!isOwner(operatorId)) {
    logger.warn({ approvalId, operatorId }, 'Approval card action rejected: not owner');
    return {};
  }

  const approved = actionType === 'approval_approve';
  const pending = resolveApproval(approvalId, approved);

  if (!pending) return {};

  // 返回更新后的卡片内容（卡片动作返回值会替换卡片）
  return buildApprovalResultCard(pending.userName, approved);
}

// ============================================================
// 清理
// ============================================================

/**
 * 清理过期审批（超过 1 小时自动拒绝）
 */
export function cleanupExpiredApprovals(): void {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour

  for (const [id, pending] of pendingApprovals) {
    if (now - pending.createdAt > maxAge) {
      logger.info({ approvalId: id }, 'Auto-rejecting expired approval');
      resolveApproval(id, false);
    }
  }

  // 清理过期的预审批标记
  for (const [key, ts] of preApprovedUsers) {
    if (now - ts > PRE_APPROVED_TTL_MS) {
      preApprovedUsers.delete(key);
    }
  }
}
