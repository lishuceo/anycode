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
} from '../feishu/message-builder.js';

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
  prompt: string;
  workingDir: string;
}

/**
 * 确保会话有话题（从 event-handler 导入的逻辑提取）
 */
async function ensureThreadForPipeline(
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
): Promise<string | undefined> {
  sessionManager.getOrCreate(chatId, userId);

  if (rootId) {
    sessionManager.setThread(chatId, userId, rootId, rootId);
    return rootId;
  }

  const greeting = '🤖 新会话已创建';
  const { messageId: botMsgId, threadId } = await feishuClient.replyInThread(
    messageId,
    greeting,
  );

  if (threadId && botMsgId) {
    sessionManager.setConversationId(chatId, userId, '');
    sessionManager.setThread(chatId, userId, threadId, messageId);
    return messageId;
  }

  logger.warn({ chatId, userId }, 'Failed to create thread for pipeline');
  return undefined;
}

/**
 * 创建待确认的管道（发送确认卡片，写入 store）
 */
export async function createPendingPipeline(params: CreatePipelineParams): Promise<string> {
  const { chatId, userId, messageId, rootId, prompt, workingDir } = params;
  const pipelineId = generatePipelineId();

  // 确保话题存在
  const threadRootMsgId = await ensureThreadForPipeline(chatId, userId, messageId, rootId);

  // 发送确认卡片
  const confirmCard = buildPipelineConfirmCard(prompt, pipelineId, workingDir);
  let progressMsgId: string | undefined;
  if (threadRootMsgId) {
    progressMsgId = await feishuClient.replyCardInThread(threadRootMsgId, confirmCard);
  }
  if (!progressMsgId) {
    progressMsgId = await feishuClient.sendCard(chatId, confirmCard);
  }

  // 保存到 store
  pipelineStore.create({
    id: pipelineId,
    chatId,
    userId,
    messageId,
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

  // CAS: pending_confirm → running
  if (!pipelineStore.tryStart(pipelineId)) {
    logger.info({ pipelineId }, 'Pipeline already started (duplicate click)');
    return;
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

  const pipelineStartTime = Date.now();

  // 获取历史摘要
  const summaries = sessionManager.getRecentSummaries(chatId, userId, 5);
  let historySummaries: string | undefined;
  if (summaries.length > 0) {
    let combined = summaries.join('\n');
    if (combined.length > 3000) {
      combined = combined.slice(-3000);
    }
    historySummaries = combined;
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
          await feishuClient.updateCard(
            progressMsgId,
            buildPipelineCard(
              prompt, state.phase, currentPhaseIndex, TOTAL_PHASES,
              elapsed, state.totalCostUsd || undefined, undefined, pipelineId,
            ),
          );
        },
        onStreamUpdate: async (text: string) => {
          if (!progressMsgId) return;
          const elapsed = Math.floor((Date.now() - pipelineStartTime) / 1000);
          const tail = text.length > 2000 ? '...\n' + text.slice(-2000) : text;
          await feishuClient.updateCard(
            progressMsgId,
            buildPipelineCard(
              prompt, currentPipelinePhase, currentPhaseIndex, TOTAL_PHASES,
              elapsed, undefined, tail, pipelineId,
            ),
          );
        },
      },
      historySummaries,
    );

    // 更新最终状态
    const finalStatus = pipelineResult.success ? 'done' as const : 'failed' as const;
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
      await feishuClient.updateCard(progressMsgId, finalCard);
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

    // 保存摘要
    if (pipelineResult.summary.length > 100) {
      try {
        const date = new Date().toISOString().slice(0, 10);
        const tail = pipelineResult.summary.slice(-500).trim();
        const summary = `[${date}] [pipeline] dir: ${workingDir} | ${tail}`;
        sessionManager.saveSummary(chatId, userId, workingDir, summary);
      } catch (err) {
        logger.warn({ err }, 'Failed to save pipeline summary');
      }
    }
  } catch (err) {
    logger.error({ err, pipelineId }, 'Error executing pipeline');
    pipelineStore.updateState(pipelineId, 'failed', '', JSON.stringify({ failureReason: String(err) }));

    if (progressMsgId) {
      const elapsed = Math.floor((Date.now() - pipelineStartTime) / 1000);
      await feishuClient.updateCard(progressMsgId, buildPipelineCard(
        prompt, 'failed', 1, TOTAL_PHASES, elapsed, undefined,
        `❌ 管道执行出错: ${(err as Error).message}`, pipelineId,
      ));
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

  pipelineStore.updateState(pipelineId, 'aborted', '', '{}');
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
    prompt: record.prompt,
    workingDir: record.workingDir,
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
