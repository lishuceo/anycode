import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sessionManager } from '../session/manager.js';
import { routeWorkspace, type RoutingDecision } from '../claude/router.js';
import { isAutoWorkspacePath, ensureIsolatedWorkspace } from '../workspace/isolation.js';
import { setupWorkspace } from '../workspace/manager.js';
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
  threadReplyMsgId?: string;
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
  | { status: 'resolved'; ctx: ThreadContext; pipelineMode?: boolean }
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
  /** agent 角色标识（多 agent 模式下传入，默认 'dev'） */
  agentId?: string;
  /** 是否为 /dev pipeline 模式（存入 routing state，clarification 后恢复） */
  pipelineMode?: boolean;
}

/**
 * 根据路由决策创建或隔离工作区
 *
 * clone_remote: 通过 setupWorkspace 从 bare cache 克隆到隔离工作区
 * use_existing / use_default: 通过 ensureIsolatedWorkspace 隔离本地仓库
 */
function resolveWorkdir(
  decision: RoutingDecision,
  isolationMode: 'readonly' | 'writable',
): { workingDir: string; warning?: string } {
  if (decision.decision === 'clone_remote' && decision.repo_url) {
    const result = setupWorkspace({ repoUrl: decision.repo_url, mode: isolationMode });
    return { workingDir: result.workspacePath, warning: result.warning };
  }
  const workingDir = decision.workdir || config.claude.defaultWorkDir;
  const isolated = ensureIsolatedWorkspace(workingDir, isolationMode);
  return { workingDir: isolated.workingDir, warning: isolated.warning };
}

/**
 * 解析话题上下文（thread + 路由 + 工作区隔离 + greeting）
 *
 * 从 executeClaudeTask 和 executePipelineTask 提取的共享前置逻辑。
 * 返回 resolved context 或指示 pending/stale/error 状态（已回复用户）。
 */
export async function resolveThreadContext(params: ResolveParams): Promise<ResolveResult> {
  const { chatId, userId, messageId, rootId, threadId: eventThreadId, agentId = 'dev' } = params;
  let prompt = params.prompt;

  // 1. 确保话题存在
  const { threadReplyMsgId, greetingMsgId } = await ensureThread(chatId, userId, messageId, rootId, eventThreadId, agentId);
  const session = sessionManager.getOrCreate(chatId, userId, agentId);

  // 2. Thread session 管理
  const threadId = session.threadId;
  let threadSession = threadId ? sessionManager.getThreadSession(threadId, agentId) : undefined;

  // 确保 thread_sessions 中有记录（首条消息时创建）
  if (threadId && !threadSession) {
    sessionManager.upsertThreadSession(threadId, chatId, userId, session.workingDir, agentId);
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

  // 3. 路由状态机：决定工作目录
  let workingDir: string;
  let warning: string | undefined;
  let restoredPipelineMode: boolean | undefined;
  const needsRouting = (threadId && threadSession?.routingState?.status === 'pending_clarification')
    || (threadId && !threadSession?.routingCompleted);

  // 路由可能耗时较长，先给用户即时反馈
  if (needsRouting && threadReplyMsgId) {
    await feishuClient.replyTextInThread(threadReplyMsgId, '🔍 正在分析工作目录...');
  }

  if (threadId && threadSession?.routingState?.status === 'pending_clarification') {
    // 3a. 用户回复了路由澄清问题
    const retryCount = threadSession.routingState.retryCount ?? 0;
    const MAX_ROUTING_RETRIES = 3;

    if (retryCount >= MAX_ROUTING_RETRIES) {
      // 超过最大追问次数，使用默认目录
      logger.warn({ chatId, userId, threadId, retryCount }, 'Routing clarification limit reached, using default workdir');
      workingDir = config.claude.defaultWorkDir;
      sessionManager.clearThreadRoutingState(threadId, agentId);
      sessionManager.setThreadWorkingDir(threadId, workingDir, agentId);
      sessionManager.markThreadRoutingCompleted(threadId, agentId);
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
          pipelineMode: threadSession.routingState.pipelineMode,
        }, agentId);
        if (threadReplyMsgId) {
          await feishuClient.replyTextInThread(threadReplyMsgId, question);
        } else {
          await feishuClient.replyText(messageId, question);
        }
        return { status: 'pending' };
      }

      // clone 失败时通知用户，不静默回退
      if (decision.cloneError) {
        const errorMsg = `❌ ${decision.cloneError}`;
        if (threadReplyMsgId) {
          await feishuClient.replyTextInThread(threadReplyMsgId, errorMsg);
        } else {
          await feishuClient.replyText(messageId, errorMsg);
        }
        return { status: 'error' };
      }

      warning = decision.warning;
      try {
        const isolationMode = isOwner(userId) ? 'writable' : (decision.mode || 'readonly');
        const resolved = resolveWorkdir(decision, isolationMode);
        workingDir = resolved.workingDir;
        warning = warning || resolved.warning;
      } catch (err) {
        const errorMsg = `❌ 无法创建隔离工作区: ${(err as Error).message}`;
        if (threadReplyMsgId) {
          await feishuClient.replyTextInThread(threadReplyMsgId, errorMsg);
        } else {
          await feishuClient.replyText(messageId, errorMsg);
        }
        return { status: 'error' };
      }
      // 路由成功后恢复原始请求作为主查询 prompt
      prompt = threadSession.routingState.originalPrompt;
      restoredPipelineMode = threadSession.routingState.pipelineMode;
      sessionManager.clearThreadRoutingState(threadId, agentId);
      sessionManager.setThreadWorkingDir(threadId, workingDir, agentId);
      sessionManager.markThreadRoutingCompleted(threadId, agentId);
      threadSession = sessionManager.getThreadSession(threadId, agentId);
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
        pipelineMode: params.pipelineMode || undefined,
      }, agentId);
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, question);
      } else {
        await feishuClient.replyText(messageId, question);
      }
      return { status: 'pending' };
    }

    // clone 失败时通知用户，不静默回退
    if (decision.cloneError) {
      const errorMsg = `❌ ${decision.cloneError}`;
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, errorMsg);
      } else {
        await feishuClient.replyText(messageId, errorMsg);
      }
      return { status: 'error' };
    }

    warning = decision.warning;
    try {
      const isolationMode = isOwner(userId) ? 'writable' : (decision.mode || 'readonly');
      const resolved = resolveWorkdir(decision, isolationMode);
      workingDir = resolved.workingDir;
      warning = warning || resolved.warning;
    } catch (err) {
      const errorMsg = `❌ 无法创建隔离工作区: ${(err as Error).message}`;
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, errorMsg);
      } else {
        await feishuClient.replyText(messageId, errorMsg);
      }
      return { status: 'error' };
    }
    sessionManager.setThreadWorkingDir(threadId, workingDir, agentId);
    sessionManager.markThreadRoutingCompleted(threadId, agentId);
    // 同步更新全局 session 的 workingDir
    sessionManager.setWorkingDir(chatId, userId, workingDir, agentId);
    threadSession = sessionManager.getThreadSession(threadId, agentId);

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
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, reply);
    } else {
      await feishuClient.replyText(messageId, reply);
    }
    sessionManager.setStatus(chatId, userId, 'idle', agentId);
    return { status: 'stale' };
  }

  // 5. 更新问候卡片
  if (greetingMsgId && threadId) {
    feishuClient.updateCard(
      greetingMsgId,
      buildGreetingCardReady(threadId, workingDir, warning),
    ).catch((err) => {
      logger.warn({ err }, 'Failed to update greeting card');
    });
  }

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
    pipelineMode: restoredPipelineMode,
  };
}
