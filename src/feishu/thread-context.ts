import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sessionManager } from '../session/manager.js';
import { routeWorkspace } from '../claude/router.js';
import { isAutoWorkspacePath, ensureIsolatedWorkspace } from '../workspace/isolation.js';
import { isOwner } from '../utils/security.js';
import { consumePreApproved } from './approval.js';
import { ensureThread } from './thread-utils.js';
import { feishuClient } from './client.js';
import { buildGreetingCardReady } from './message-builder.js';
import type { ThreadSession } from '../session/types.js';

// ============================================================
// resolveThreadContext — 共享的话题上下文解析逻辑
//
// 统一 executeClaudeTask 和 executePipelineTask 的前置流程：
// ensureThread → session 管理 → 路由状态机 → 工作区隔离 → greeting 更新
// ============================================================

/** 解析后的话题上下文 */
export interface ThreadContext {
  /** 话题锚点消息 ID（用于 reply_in_thread） */
  threadRootMsgId?: string;
  /** 问候卡片消息 ID（仅新建话题时有值） */
  greetingMsgId?: string;
  /** 解析后的工作目录 */
  workingDir: string;
  /** 话题 ID（session.threadId） */
  threadId?: string;
  /** Thread session 记录 */
  threadSession?: Readonly<ThreadSession>;
  /** 可能被路由追问替换的 prompt */
  prompt: string;
}

export type ResolveResult =
  | { status: 'resolved'; ctx: ThreadContext }
  | { status: 'pending' }   // 路由待澄清，已回复用户
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
}

/**
 * 解析话题上下文（thread + 路由 + 工作区隔离 + greeting）
 *
 * 从 executeClaudeTask 和 executePipelineTask 提取的共享前置逻辑。
 * 返回 resolved context 或指示 pending/stale/error 状态（已回复用户）。
 */
export async function resolveThreadContext(params: ResolveParams): Promise<ResolveResult> {
  const { chatId, userId, messageId, rootId, threadId: eventThreadId } = params;
  let prompt = params.prompt;

  // 1. 确保话题存在
  const { threadRootMsgId, greetingMsgId } = await ensureThread(chatId, userId, messageId, rootId, eventThreadId);
  const session = sessionManager.getOrCreate(chatId, userId);

  // 2. Thread session 管理
  const threadId = session.threadId;
  let threadSession = threadId ? sessionManager.getThreadSession(threadId) : undefined;

  // 确保 thread_sessions 中有记录（首条消息时创建）
  if (threadId && !threadSession) {
    sessionManager.upsertThreadSession(threadId, chatId, userId, session.workingDir);
    threadSession = sessionManager.getThreadSession(threadId);
  }

  // 预审批持久化（审批通过时 thread 尚未创建的情况）
  if (threadId && consumePreApproved(chatId, userId)) {
    sessionManager.setThreadApproved(threadId, true);
  }

  // 刷新活跃时间，防止被 cleanup 清理
  if (threadId && threadSession) {
    sessionManager.touchThreadSession(threadId);
  }

  // 3. 路由状态机：决定工作目录
  let workingDir: string;
  const needsRouting = (threadId && threadSession?.routingState?.status === 'pending_clarification')
    || (threadId && !threadSession?.routingCompleted);

  // 路由可能耗时较长，先给用户即时反馈
  if (needsRouting && threadRootMsgId) {
    await feishuClient.replyTextInThread(threadRootMsgId, '🔍 正在分析工作目录...');
  }

  if (threadId && threadSession?.routingState?.status === 'pending_clarification') {
    // 3a. 用户回复了路由澄清问题
    const retryCount = threadSession.routingState.retryCount ?? 0;
    const MAX_ROUTING_RETRIES = 3;

    if (retryCount >= MAX_ROUTING_RETRIES) {
      // 超过最大追问次数，使用默认目录
      logger.warn({ chatId, userId, threadId, retryCount }, 'Routing clarification limit reached, using default workdir');
      workingDir = config.claude.defaultWorkDir;
      sessionManager.clearThreadRoutingState(threadId);
      sessionManager.setThreadWorkingDir(threadId, workingDir);
      sessionManager.markThreadRoutingCompleted(threadId);
      threadSession = sessionManager.getThreadSession(threadId);
    } else {
      // 拼接上下文重新路由
      const context = [
        `[原始请求] ${threadSession.routingState.originalPrompt}`,
        `[路由问题] ${threadSession.routingState.question}`,
        `[用户回复] ${prompt}`,
      ].join('\n');

      logger.info({ chatId, userId, threadId, retryCount }, 'Re-routing with clarification context');
      const decision = await routeWorkspace(context, chatId, userId, threadId);

      if (decision.decision === 'need_clarification') {
        const question = decision.question || '请提供更多信息，我需要知道你想要操作哪个仓库或项目。';
        sessionManager.setThreadRoutingState(threadId, {
          status: 'pending_clarification',
          originalPrompt: threadSession.routingState.originalPrompt,
          question,
          retryCount: retryCount + 1,
        });
        if (threadRootMsgId) {
          await feishuClient.replyTextInThread(threadRootMsgId, question);
        } else {
          await feishuClient.replyText(messageId, question);
        }
        return { status: 'pending' };
      }

      workingDir = decision.workdir || config.claude.defaultWorkDir;
      try {
        const isolationMode = isOwner(userId) ? 'writable' : (decision.mode || 'readonly');
        workingDir = ensureIsolatedWorkspace(workingDir, isolationMode);
      } catch (err) {
        const errorMsg = `❌ 无法创建隔离工作区: ${(err as Error).message}`;
        if (threadRootMsgId) {
          await feishuClient.replyTextInThread(threadRootMsgId, errorMsg);
        } else {
          await feishuClient.replyText(messageId, errorMsg);
        }
        return { status: 'error' };
      }
      // 路由成功后恢复原始请求作为主查询 prompt
      prompt = threadSession.routingState.originalPrompt;
      sessionManager.clearThreadRoutingState(threadId);
      sessionManager.setThreadWorkingDir(threadId, workingDir);
      sessionManager.markThreadRoutingCompleted(threadId);
      threadSession = sessionManager.getThreadSession(threadId);
    }

  } else if (threadId && !threadSession?.routingCompleted && !threadSession?.conversationId) {
    // 3b. Thread 首条消息，需要路由
    logger.info({ chatId, userId, threadId }, 'First message in thread, running routing agent');
    const decision = await routeWorkspace(prompt, chatId, userId, threadId);

    if (decision.decision === 'need_clarification') {
      const question = decision.question || '请提供更多信息，我需要知道你想要操作哪个仓库或项目。';
      sessionManager.setThreadRoutingState(threadId, {
        status: 'pending_clarification',
        originalPrompt: prompt,
        question,
        retryCount: 0,
      });
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, question);
      } else {
        await feishuClient.replyText(messageId, question);
      }
      return { status: 'pending' };
    }

    workingDir = decision.workdir || config.claude.defaultWorkDir;
    try {
      const isolationMode = isOwner(userId) ? 'writable' : (decision.mode || 'readonly');
      workingDir = ensureIsolatedWorkspace(workingDir, isolationMode);
    } catch (err) {
      const errorMsg = `❌ 无法创建隔离工作区: ${(err as Error).message}`;
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, errorMsg);
      } else {
        await feishuClient.replyText(messageId, errorMsg);
      }
      return { status: 'error' };
    }
    sessionManager.setThreadWorkingDir(threadId, workingDir);
    sessionManager.markThreadRoutingCompleted(threadId);
    // 同步更新全局 session 的 workingDir
    sessionManager.setWorkingDir(chatId, userId, workingDir);
    threadSession = sessionManager.getThreadSession(threadId);

  } else {
    // 3c. Thread 后续消息，使用已绑定的 workdir
    workingDir = threadSession?.workingDir ?? session.workingDir;
  }

  // 4. 过期工作区检测
  if (isAutoWorkspacePath(workingDir) && !existsSync(workingDir)) {
    logger.warn({ workingDir, threadId }, 'Stale workspace detected');
    const reply = [
      '⚠️ 该话题的工作区已过期清理。',
      `原工作区: \`${basename(workingDir)}\``,
      '',
      '请开启新话题继续操作，系统会自动创建新的工作区。',
    ].join('\n');
    if (threadRootMsgId) {
      await feishuClient.replyTextInThread(threadRootMsgId, reply);
    } else {
      await feishuClient.replyText(messageId, reply);
    }
    sessionManager.setStatus(chatId, userId, 'idle');
    return { status: 'stale' };
  }

  // 5. 更新问候卡片
  if (greetingMsgId && threadId) {
    feishuClient.updateCard(
      greetingMsgId,
      buildGreetingCardReady(threadId, workingDir),
    ).catch((err) => {
      logger.warn({ err }, 'Failed to update greeting card');
    });
  }

  return {
    status: 'resolved',
    ctx: {
      threadRootMsgId,
      greetingMsgId,
      workingDir,
      threadId,
      threadSession,
      prompt,
    },
  };
}
