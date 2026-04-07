import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sessionManager } from '../session/manager.js';
import { isAutoWorkspacePath } from '../workspace/isolation.js';
import { consumePreApproved } from './approval.js';
import { ensureThread } from './thread-utils.js';
import { feishuClient } from './client.js';
import type { ThreadSession } from '../session/types.js';

// ============================================================
// resolveThreadContext — 共享的话题上下文解析逻辑
//
// 统一 executeClaudeTask 和 executePipelineTask 的前置流程：
// ensureThread → session 管理 → workingDir 确定 → greeting 更新
//
// 不再有前置路由 Agent。工作区默认使用 DEFAULT_WORK_DIR，
// 主 Agent 在执行过程中通过 setup_workspace MCP tool 自主切换。
// ============================================================

/** 解析后的话题上下文 */
export interface ThreadContext {
  /** 话题锚点消息 ID（用于 reply_in_thread） */
  threadReplyMsgId?: string;
  /** 问候卡片消息 ID（仅新建话题时有值） */
  greetingMsgId?: string;
  /** 解析后的工作目录 */
  workingDir: string;
  /** 话题 ID（session.threadId） */
  threadId?: string;
  /** Thread session 记录 */
  threadSession?: Readonly<ThreadSession>;
  /** prompt（透传，不再被路由修改） */
  prompt: string;
}

export type ResolveResult =
  | { status: 'resolved'; ctx: ThreadContext }
  | { status: 'stale' }     // 工作区已过期，已回复用户
  | { status: 'error' };    // 工作区创建失败，已回复用户

export interface ResolveParams {
  prompt: string;
  chatId: string;
  userId: string;
  messageId: string;
  /** message.root_id — 回复目标消息 ID */
  rootId?: string;
  /** message.thread_id — 可靠的话题标识 */
  threadId?: string;
  /** agent 角色标识（多 agent 模式下传入，默认 'dev'） */
  agentId?: string;
}

/**
 * 解析话题上下文（thread + workingDir + greeting）
 *
 * 从 executeClaudeTask 和 executePipelineTask 提取的共享前置逻辑。
 * 默认使用 DEFAULT_WORK_DIR，主 Agent 通过 setup_workspace MCP tool 自主切换。
 * 返回 resolved context 或指示 stale/error 状态（已回复用户）。
 */
export async function resolveThreadContext(params: ResolveParams): Promise<ResolveResult> {
  const { prompt, chatId, userId, messageId, rootId, threadId: eventThreadId, agentId = 'dev' } = params;

  // 1. 确保话题存在
  const { threadReplyMsgId, greetingMsgId } = await ensureThread(chatId, userId, messageId, rootId, eventThreadId, agentId);
  const session = sessionManager.getOrCreate(chatId, userId, agentId);

  // 2. Thread session 管理
  const threadId = session.threadId;
  let threadSession = threadId ? sessionManager.getThreadSession(threadId, agentId) : undefined;

  // 确保 thread_sessions 中有记录（首条消息时创建）
  // 新话题始终用 defaultWorkDir，不继承全局 session 的 workingDir（可能被上一个话题污染）
  if (threadId && !threadSession) {
    sessionManager.upsertThreadSession(threadId, chatId, userId, config.claude.defaultWorkDir, agentId);
    threadSession = sessionManager.getThreadSession(threadId, agentId);
  }

  // 预审批持久化（审批通过时 thread 尚未创建的情况）
  if (threadId && consumePreApproved(chatId, userId)) {
    sessionManager.setThreadApproved(threadId, true, agentId);
  }

  // 刷新活跃时间，防止被 cleanup 清理
  if (threadId && threadSession) {
    sessionManager.touchThreadSession(threadId, agentId);
  }

  // 3. 确定工作目录
  // 后续消息使用已绑定的 workingDir（可能已被 setup_workspace 切换）
  // 首条消息使用 defaultWorkDir，主 Agent 在执行中自主判断是否需要切换
  // 注意：不能 fallback 到 session.workingDir，因为全局 session 可能被上一个话题的
  // workspace 切换污染（setWorkingDir 更新的是 per-chat 全局 session）
  const workingDir = threadSession?.workingDir ?? config.claude.defaultWorkDir;

  // 4. 过期工作区检测
  if (isAutoWorkspacePath(workingDir) && !existsSync(workingDir)) {
    logger.warn({ workingDir, threadId }, 'Stale workspace detected');
    const reply = [
      '⚠️ 该话题的工作区已过期清理。',
      `原工作区: \`${basename(workingDir)}\``,
      '',
      '请开启新话题继续操作，系统会自动创建新的工作区。',
    ].join('\n');
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, reply);
    } else {
      await feishuClient.replyText(messageId, reply);
    }
    sessionManager.setStatus(chatId, userId, 'idle', agentId);
    return { status: 'stale' };
  }

  // 5. 问候卡片不再显示 threadId/workingDir（默认工作目录不是有效信息）
  // 工作区切换后会由 event-handler 发送专门的工作区卡片

  return {
    status: 'resolved',
    ctx: {
      threadReplyMsgId,
      greetingMsgId,
      workingDir,
      threadId,
      threadSession,
      prompt,
    },
  };
}
