import { logger } from '../utils/logger.js';
import { feishuClient } from '../feishu/client.js';
import { sessionManager } from '../session/manager.js';
import { claudeExecutor } from '../claude/executor.js';
import { PipelineOrchestrator } from './orchestrator.js';
import { pipelineStore, generatePipelineId } from './store.js';
import { PHASE_META, TOTAL_PHASES } from './types.js';
import {
  buildPipelineConfirmCard,
  buildPipelineCard,
  buildCancelledCard,
  buildInterruptedCard,
  buildGreetingCardReady,
} from '../feishu/message-builder.js';
import { ensureThread } from '../feishu/thread-utils.js';

// ============================================================
// Pipeline Runner — 管道生命周期管理
//
// 桥接 event-handler ↔ orchestrator ↔ store
// ============================================================

/** 正在运行的管道注册表 */
const runningPipelines = new Map<string, {
  orchestrator: PipelineOrchestrator;
  chatId: string;
  userId: string;
}>();

export interface CreatePipelineParams {
  chatId: string;
  userId: string;
  messageId: string;
  rootId?: string;
  /** 飞书话题 ID（message.thread_id，优先于 rootId 做话题标识） */
  threadId?: string;
  prompt: string;
  workingDir: string;
  /** 预创建的话题锚点消息 ID（由调用方 ensureThread 后传入，跳过内部的 ensureThread） */
  threadRootMsgId?: string;
}

/**
 * 创建待确认的管道（发送确认卡片，写入 store）
 */
export async function createPendingPipeline(params: CreatePipelineParams): Promise<string> {
  const { chatId, userId, messageId, rootId, prompt, workingDir } = params;
  const pipelineId = generatePipelineId();

  // 确保话题存在（如果调用方已提供 threadRootMsgId，跳过）
  let threadRootMsgId: string | undefined;
  if (params.threadRootMsgId) {
    threadRootMsgId = params.threadRootMsgId;
  } else {
    const threadResult = await ensureThread(chatId, userId, messageId, rootId, params.threadId);
    threadRootMsgId = threadResult.threadRootMsgId;

    // 更新问候卡片：显示话题 ID 和工作目录
    const session = sessionManager.getOrCreate(chatId, userId);
    const threadId = session.threadId;
    if (threadResult.greetingMsgId && threadId) {
      feishuClient.updateCard(
        threadResult.greetingMsgId,
        buildGreetingCardReady(threadId, workingDir),
      ).catch((err) => {
        logger.warn({ err }, 'Failed to update greeting card in pipeline');
      });
    }
  }

  // 发送确认卡片
  const confirmCard = buildPipelineConfirmCard(prompt, pipelineId, workingDir);
  let progressMsgId: string | undefined;
  if (threadRootMsgId) {
    progressMsgId = await feishuClient.replyCardInThread(threadRootMsgId, confirmCard);
  }
  if (!progressMsgId) {
    progressMsgId = await feishuClient.sendCard(chatId, confirmCard);
  }

  // 获取实际 threadId（ensureThread 设置后从 session 读取）
  const sessionForThreadId = sessionManager.getOrCreate(chatId, userId);
  const resolvedThreadId = params.threadId || sessionForThreadId.threadId;

  // 保存到 store
  pipelineStore.create({
    id: pipelineId,
    chatId,
    userId,
    messageId,
    threadId: resolvedThreadId,
    threadRootMsgId,
    progressMsgId,
    workingDir,
    prompt,
  });

  logger.info({ pipelineId, chatId, userId }, 'Pending pipeline created');
  return pipelineId;
}

/**
 * 启动管道（确认后调用）
 */
export async function startPipeline(pipelineId: string): Promise<void> {
  const record = pipelineStore.get(pipelineId);
  if (!record) {
    logger.warn({ pipelineId }, 'Pipeline not found');
    return;
  }

  // CAS 已在 handlePipelineConfirm 中完成（同步执行以确保卡片更新正确）
  // 这里做防御性检查：如果状态不是 running，说明 CAS 未执行或被并发修改
  if (record.status !== 'running') {
    // 兜底尝试：兼容直接调用 startPipeline 的场景
    if (!pipelineStore.tryStart(pipelineId)) {
      logger.info({ pipelineId }, 'Pipeline already started or not in pending state');
      return;
    }
  }

  const { chatId, userId, prompt, workingDir, progressMsgId, threadRootMsgId } = record;

  // 获取会话锁
  if (!sessionManager.tryAcquire(chatId, userId)) {
    pipelineStore.updateState(pipelineId, 'failed', '', JSON.stringify({ failureReason: '会话正忙' }));
    if (progressMsgId) {
      await feishuClient.updateCard(progressMsgId, buildPipelineCard(
        prompt, 'failed', 1, TOTAL_PHASES, 0, undefined, '⚠️ 会话正忙，请等待当前任务完成', pipelineId,
      ));
    }
    return;
  }

  // 将 workingDir 绑定到 thread session，确保后续普通消息使用同一工作区
  // 放在 tryAcquire 之后，避免锁获取失败时意外修改 thread session（setThreadWorkingDir 会清空 conversationId）
  // 使用 record.threadId（omt_xxx）做 thread session key，而非 threadRootMsgId（om_xxx 消息 ID）
  const pipelineThreadId = record.threadId;
  if (pipelineThreadId) {
    const existingTs = sessionManager.getThreadSession(pipelineThreadId);
    if (!existingTs) {
      sessionManager.upsertThreadSession(pipelineThreadId, chatId, userId, workingDir);
    } else if (existingTs.workingDir !== workingDir) {
      sessionManager.setThreadWorkingDir(pipelineThreadId, workingDir);
    }
    sessionManager.markThreadRoutingCompleted(pipelineThreadId);
  }

  const pipelineStartTime = Date.now();

  // 拉取话题对话历史，仅注入 plan 阶段（解决 /dev 丢失前序对话的问题）
  // 通过 threadHistory 参数拼入 plan 的 user prompt，不污染 state.userPrompt（避免泄漏到 review/push/pr_fixup）
  let threadHistory: string | undefined;
  if (pipelineThreadId) {
    try {
      const messages = await feishuClient.fetchRecentMessages(pipelineThreadId, 'thread', 50);
      // 过滤：排除 /dev 命令本身
      const historyLines: string[] = [];
      for (const msg of messages) {
        const text = msg.content.trim();
        if (!text) continue;
        if (text === '/dev' || text.startsWith('/dev ')) continue;
        const role = msg.senderType === 'app' ? '助手' : '用户';
        historyLines.push(`[${role}] ${text}`);
      }
      if (historyLines.length > 0) {
        let combined = historyLines.join('\n');
        // 限制大小：~10000 tokens ≈ 30000 chars
        if (combined.length > 30000) {
          combined = combined.slice(-30000);
          // 对齐到行边界，避免截断半条消息
          const firstNewline = combined.indexOf('\n');
          if (firstNewline > 0) combined = combined.slice(firstNewline + 1);
          combined = '...(已截断早期对话)\n' + combined;
        }
        threadHistory = combined;
        logger.info({ pipelineId, threadId: pipelineThreadId, messageCount: historyLines.length }, 'Fetched thread history for pipeline');
      }
    } catch (err) {
      logger.warn({ err, pipelineId, threadId: pipelineThreadId }, 'Failed to fetch thread history for pipeline');
    }
  }

  const orchestrator = new PipelineOrchestrator();
  runningPipelines.set(pipelineId, { orchestrator, chatId, userId });

  let currentPipelinePhase = 'plan';
  let currentPhaseIndex = 1;

  try {
    // 更新卡片为初始执行状态
    if (progressMsgId) {
      await feishuClient.updateCard(progressMsgId, buildPipelineCard(
        prompt, 'plan', 1, TOTAL_PHASES, 0, undefined, undefined, pipelineId,
      ));
    }

    const pipelineResult = await orchestrator.run(
      prompt,
      workingDir,
      {
        onPhaseChange: async (state) => {
          currentPipelinePhase = state.phase;
          currentPhaseIndex = PHASE_META[state.phase]?.index ?? currentPhaseIndex;

          // 同步到 store
          pipelineStore.updateState(pipelineId, 'running', state.phase, JSON.stringify(state));

          if (!progressMsgId) return;
          const elapsed = Math.floor((Date.now() - pipelineStartTime) / 1000);
          const cardUpdateTimeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000));
          const updated = await Promise.race([
            feishuClient.updateCard(
              progressMsgId,
              buildPipelineCard(
                prompt, state.phase, currentPhaseIndex, TOTAL_PHASES,
                elapsed, state.totalCostUsd || undefined, undefined, pipelineId,
              ),
            ),
            cardUpdateTimeout,
          ]);
          if (!updated) {
            logger.warn({ pipelineId, progressMsgId, phase: state.phase }, 'Pipeline card update failed/timed out');
          }
        },
        onStreamUpdate: async (text: string) => {
          if (!progressMsgId) return;
          const elapsed = Math.floor((Date.now() - pipelineStartTime) / 1000);
          const tail = text.length > 2000 ? '...\n' + text.slice(-2000) : text;
          const streamTimeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000));
          await Promise.race([
            feishuClient.updateCard(
              progressMsgId,
              buildPipelineCard(
                prompt, currentPipelinePhase, currentPhaseIndex, TOTAL_PHASES,
                elapsed, undefined, tail, pipelineId,
              ),
            ),
            streamTimeout,
          ]);
        },
      },
      threadHistory,
    );

    // 更新最终状态（中止的管道保留 aborted 状态，不覆盖为 failed）
    const finalStatus = orchestrator.isAborted()
      ? 'aborted' as const
      : pipelineResult.success ? 'done' as const : 'failed' as const;
    pipelineStore.updateState(pipelineId, finalStatus, pipelineResult.state.phase, JSON.stringify(pipelineResult.state));

    // 最终卡片
    const totalElapsed = Math.floor((Date.now() - pipelineStartTime) / 1000);
    const failedIndex = pipelineResult.state.failedAtPhase
      ? PHASE_META[pipelineResult.state.failedAtPhase]?.index ?? TOTAL_PHASES
      : TOTAL_PHASES;

    const finalCard = buildPipelineCard(
      prompt,
      pipelineResult.success ? 'done' : 'failed',
      pipelineResult.success ? TOTAL_PHASES + 1 : failedIndex,
      TOTAL_PHASES,
      totalElapsed,
      pipelineResult.totalCostUsd || undefined,
      pipelineResult.summary.slice(0, 2500),
      pipelineId,
    );

    if (progressMsgId) {
      // 给 updateCard 加超时保护，防止飞书 API 挂起导致卡片永远停在进度状态
      const updateTimeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000));
      const finalUpdated = await Promise.race([
        feishuClient.updateCard(progressMsgId, finalCard),
        updateTimeout,
      ]);
      if (!finalUpdated) {
        logger.warn({ pipelineId, progressMsgId }, 'Final card update failed or timed out, sending result as new message');
        // 回退：作为新消息发送最终卡片
        if (threadRootMsgId) {
          await feishuClient.replyCardInThread(threadRootMsgId, finalCard);
        } else {
          await feishuClient.sendCard(chatId, finalCard);
        }
      }
    } else if (threadRootMsgId) {
      await feishuClient.replyCardInThread(threadRootMsgId, finalCard);
    } else {
      await feishuClient.sendCard(chatId, finalCard);
    }

    // 如果摘要太长，额外发送完整文本
    if (pipelineResult.summary.length > 2500) {
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, pipelineResult.summary);
      } else {
        await feishuClient.sendText(chatId, pipelineResult.summary);
      }
    }

    // 保存 pipeline 上下文到 thread session（供后续普通消息注入历史）
    // 使用 pipelineThreadId（omt_xxx）做 thread session key
    if (pipelineThreadId) {
      try {
        // 确保 thread session 存在
        if (!sessionManager.getThreadSession(pipelineThreadId)) {
          sessionManager.upsertThreadSession(pipelineThreadId, chatId, userId, workingDir);
        }
        sessionManager.setThreadPipelineContext(pipelineThreadId, {
          prompt,
          summary: pipelineResult.summary,
          workingDir,
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to save pipeline context to thread session');
      }
    }

  } catch (err) {
    logger.error({ err, pipelineId }, 'Error executing pipeline');
    pipelineStore.updateState(pipelineId, 'failed', '', JSON.stringify({ failureReason: String(err) }));

    if (progressMsgId) {
      try {
        const elapsed = Math.floor((Date.now() - pipelineStartTime) / 1000);
        await feishuClient.updateCard(progressMsgId, buildPipelineCard(
          prompt, 'failed', 1, TOTAL_PHASES, elapsed, undefined,
          `❌ 管道执行出错: ${(err as Error).message}`, pipelineId,
        ));
      } catch (cardErr) {
        logger.warn({ cardErr, pipelineId }, 'Failed to update error card');
      }
    }
  } finally {
    runningPipelines.delete(pipelineId);
    try {
      sessionManager.setStatus(chatId, userId, 'idle');
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to reset session status');
    }
  }
}

/**
 * 中止管道
 */
export function abortPipeline(pipelineId: string): boolean {
  const entry = runningPipelines.get(pipelineId);
  if (!entry) return false;

  entry.orchestrator.abort();

  // 尝试 kill 当前 Claude session
  const sessionKey = entry.orchestrator.getCurrentSessionKey();
  if (sessionKey) {
    claudeExecutor.killSession(sessionKey);
  }

  // 不在这里设置 aborted 状态 — startPipeline 的完成处理器会检查
  // orchestrator.isAborted() 来决定最终状态是 aborted 还是 failed
  logger.info({ pipelineId }, 'Pipeline abort requested');
  return true;
}

/**
 * 取消管道（pending_confirm 状态）
 */
export function cancelPipeline(pipelineId: string): boolean {
  const record = pipelineStore.get(pipelineId);
  if (!record || record.status !== 'pending_confirm') return false;

  pipelineStore.updateState(pipelineId, 'cancelled', '', '{}');
  logger.info({ pipelineId }, 'Pipeline cancelled');
  return true;
}

/**
 * 重试管道 — 创建新的待确认管道
 */
export async function retryPipeline(pipelineId: string): Promise<string | undefined> {
  const record = pipelineStore.get(pipelineId);
  if (!record) return undefined;

  return createPendingPipeline({
    chatId: record.chatId,
    userId: record.userId,
    messageId: record.messageId,
    rootId: record.threadRootMsgId,
    threadId: record.threadId,
    prompt: record.prompt,
    workingDir: record.workingDir,
    threadRootMsgId: record.threadRootMsgId,
  });
}

/**
 * 恢复被中断的管道（服务启动时调用）
 */
export async function recoverInterruptedPipelines(): Promise<void> {
  const count = pipelineStore.markRunningAsInterrupted();
  if (count === 0) return;

  const interrupted = pipelineStore.findByStatus('interrupted');
  logger.info({ count: interrupted.length }, 'Recovering interrupted pipelines');

  for (const record of interrupted) {
    if (!record.progressMsgId) continue;

    try {
      const card = buildInterruptedCard(record.prompt, record.id);
      await feishuClient.updateCard(record.progressMsgId, card);
    } catch (err) {
      logger.warn({ err, pipelineId: record.id }, 'Failed to update interrupted pipeline card');
    }
  }
}

/**
 * 检查管道是否正在运行
 */
export function isPipelineRunning(pipelineId: string): boolean {
  return runningPipelines.has(pipelineId);
}
