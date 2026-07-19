import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../utils/logger.js';
import { isUserAllowed, containsDangerousCommand, isOwner, autoDetectOwner } from '../utils/security.js';
import { sessionManager } from '../session/manager.js';
import { parseFableCommand, resolveForcedModel } from '../session/model-override.js';
import { forkSession } from '../session/fork.js';
import { taskQueue } from '../session/queue.js';
import { claudeExecutor } from '../claude/executor.js';
import { DEFAULT_IMAGE_PROMPT, DEFAULT_DOCUMENT_PROMPT } from '../claude/types.js';
import type { TurnInfo, ToolCallInfo, ImageAttachment, DocumentAttachment, ConversationTurn, CompactResult } from '../claude/types.js';
import { buildStatusCard, buildCancelledCard, buildPipelineCard, buildPipelineConfirmCard, buildCombinedProgressCard, buildAskUserQuestionCard, buildAskUserAnsweredCard } from './message-builder.js';
import type { AskUserQuestionItem } from './message-builder.js';
import { TOTAL_PHASES } from '../pipeline/types.js';
import { feishuClient, feishuClientContext, runWithAccountId } from './client.js';
import { saveMessageFileToCache } from './file-cache.js';
import { config, isMultiBotMode } from '../config.js';
import { checkAndRequestApproval, handleApprovalTextCommand, handleApprovalCardAction, setOnApproved } from './approval.js';
import { resolveThreadContext } from './thread-context.js';
import { ensureThread, initProgressCardMsgId } from './thread-utils.js';
import { formatMergeForwardSubMessage } from './message-parser.js';
import { extractPostText } from './message-text.js';
import { pipelineStore } from '../pipeline/store.js';
import {
  createPendingPipeline,
  startPipeline,
  abortPipeline,
  cancelPipeline,
  retryPipeline,
} from '../pipeline/runner.js';
import { resolveAgent, getRespondReason } from '../agent/router.js';
import { agentRegistry } from '../agent/registry.js';
import { accountManager } from './multi-account.js';
import { chatBotRegistry } from './bot-registry.js';
import type { AgentId } from '../agent/types.js';
import { readPersonaFile, loadKnowledgeContent, getAgentConfigInfo, getExplicitBindings, deriveBindings } from '../agent/config-loader.js';
import { resolveMentions } from './mention-resolver.js';
import { createDiscussionMcpServer } from '../agent/tools/discussion.js';
import { generateAuthUrl, hasCallbackUrl, handleManualCode } from './oauth.js';
import { injectMemories } from '../memory/injector.js';
import { extractMemories } from '../memory/extractor.js';
import { resolveRepositoryForCwd } from '../memory/scope.js';
import { handleMemoryCommand, handleMemoryCardAction } from '../memory/commands.js';
import { getRepoIdentity } from '../workspace/identity.js';
import { parseRepoNameFromWorkspaceDir } from '../workspace/manager.js';
import { generateQuickAck } from '../utils/quick-ack.js';
import { evaluateThreadBypass, type ThreadBypassDeps } from './thread-participants.js';
import { compressImage, compressImageForHistory } from '../utils/image-compress.js';

// 注册审批通过后的消息重新入队回调（避免 approval.ts → event-handler.ts 循环依赖）
setOnApproved((chatId, userId, text, messageId, accountId, agentId, rootId, threadId) => {
  // threadId 由 handleMessageEvent 校验后传入（有 rootId 时必有 threadId）
  // accountId 用于恢复正确的 feishuClient 上下文（哪个 bot 收到的消息就由哪个 bot 处理）
  const queueKey = makeQueueKey(chatId, threadId, agentId as AgentId);
  runWithAccountId(accountId, () => {
    taskQueue.enqueue(queueKey, chatId, userId, text, messageId, rootId, threadId, undefined, undefined, undefined, undefined, undefined, accountId).catch(() => {});
    processQueue(queueKey, agentId as AgentId);
  });
});

// ============================================================
// 使用飞书 SDK 的 EventDispatcher 处理事件
//
// EventDispatcher 自动处理:
//   - URL verification (challenge)
//   - 事件签名验证 (encryptKey / verificationToken)
//   - 事件去重 (内置 cache)
//   - 事件解密
//   - 类型安全的事件回调
//
// 配合 adaptExpress 可以一行代码接入 Express
// ============================================================

/**
 * 将对话轨迹格式化为文本，用于 restart 时注入 priorContext。
 * 保留 Agent 的推理文本和关键工具交互，截断过长内容。
 */
export function formatConversationTrace(trace?: ConversationTurn[]): string {
  if (!trace?.length) return '';
  const MAX_TOTAL = 15000;
  const parts: string[] = [];
  for (const turn of trace) {
    if (turn.text) parts.push(turn.text);
    for (const tc of turn.toolCalls) {
      // 只保留关键输入字段，避免序列化完整 input
      const inputSummary = tc.name === 'Read' ? String(tc.input.file_path ?? '')
        : tc.name === 'Bash' ? String(tc.input.command ?? '')
        : tc.name === 'Grep' ? `${tc.input.pattern ?? ''} in ${tc.input.path ?? '.'}`
        : JSON.stringify(tc.input).slice(0, 200);
      parts.push(`[${tc.name}] ${inputSummary}`);
      if (tc.result) parts.push(tc.result);
    }
  }
  const joined = parts.join('\n');
  return joined.length > MAX_TOTAL ? joined.slice(-MAX_TOTAL) : joined;
}

/** 把 token 数格式化为紧凑形式：40445 → "40.4k"，1351 → "1.4k"，800 → "800" */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** 构造 /compact 结果的飞书回复文本 */
export function formatCompactReply(result: CompactResult): string {
  if (result.success) {
    const { preTokens: pre, postTokens: post } = result;
    if (pre && post && pre > 0) {
      const pct = Math.round((1 - post / pre) * 100);
      return `✅ 上下文已压缩：约 ${formatTokenCount(pre)} → ${formatTokenCount(post)} tokens（↓${pct}%）`;
    }
    return '✅ 上下文已压缩。';
  }
  if (result.noop) {
    return 'ℹ️ 当前上下文较短，无需压缩。';
  }
  return `❌ 压缩失败：${result.error || '未知错误'}`;
}

/**
 * 工作区切换 restart 时：把已落盘的图片路径拼成文本提示，让 agent 用 Read 工具按需查看。
 * 由于 restart query 不重传多模态 images 参数（避免重复消耗 token），需以文本路径作为 fallback。
 * 返回空字符串表示没有可附加的图片提示。
 */
export function formatRestartImageHints(paths: string[]): string {
  if (!paths.length) return '';
  // 去重后保持原顺序
  const unique = Array.from(new Set(paths));
  const lines = unique.map(p => `- ${p}`);
  return [
    '[历史聊天图片] 工作区切换前已加载的图片已落盘到本地，如需查看请使用 Read 工具读取：',
    ...lines,
  ].join('\n');
}

/**
 * 把历史消息中的图片落盘路径拼成文本提示。与 formatRestartImageHints 同形式但措辞不同：
 * 历史图片不再走多模态(避免污染上下文),需要时让 agent 用 Read 工具按需读取。
 */
export function formatHistoryImageHints(paths: string[]): string {
  if (!paths.length) return '';
  const unique = Array.from(new Set(paths));
  const lines = unique.map(p => `- ${p}`);
  return [
    '[历史聊天图片] 历史消息中的图片未自动展开,已落盘到本地,如需查看请使用 Read 工具读取：',
    ...lines,
  ].join('\n');
}

/**
 * Workspace restart 路径专用：将"刚拉到的完整历史"与本轮 prompt 拼成 S2 的 prompt 文本。
 *
 * 纯函数，仅做字符串/数组装配。便于单元测试覆盖 restart-history loss 回归。
 *
 * - history.text → 前置历史块（无则不前置）
 * - history.fileTexts → 再前置（文本文件原文）
 * - history.historyImagePaths → 合并到 imagePaths 并去重（保留原有顺序在前）
 *
 * 不处理 rootId 引用消息注入（异步 IO，由调用方在 helper 之后处理）。
 */
export function assembleRestartPromptFromFullHistory(
  promptWithTime: string,
  history: {
    text?: string;
    fileTexts?: string[];
    historyImagePaths?: string[];
  },
  existingImagePaths: string[],
): { prompt: string; imagePaths: string[] } {
  let prompt = promptWithTime;
  if (history.text) {
    prompt = history.text + '\n\n---\n\n' + prompt;
  }
  if (history.fileTexts?.length) {
    prompt = history.fileTexts.join('\n\n') + '\n\n---\n\n' + prompt;
  }
  const imagePaths = [...existingImagePaths];
  if (history.historyImagePaths?.length) {
    const seen = new Set(imagePaths);
    for (const p of history.historyImagePaths) {
      if (!seen.has(p)) {
        imagePaths.push(p);
        seen.add(p);
      }
    }
  }
  return { prompt, imagePaths };
}

// ============================================================
// AskUserQuestion 待回答存储
// 当 Claude 调用 AskUserQuestion 时，canUseTool 拦截并发送飞书卡片，
// 然后在此等待用户通过卡片按钮回答。
// ============================================================
interface PendingQuestion {
  questions: AskUserQuestionItem[];
  /** 已收集的答案（按 question 文本为 key） */
  answers: Record<string, string>;
  /** 需要回答的问题总数 */
  totalQuestions: number;
  /** 回答完成后 resolve */
  resolve: (answers: Record<string, string>) => void;
  /** 超时或异常时 reject */
  reject: (err: Error) => void;
  /** 卡片消息 ID（用于更新卡片） */
  cardMessageId?: string;
  /** 卡片所在 chatId */
  chatId?: string;
  /** 超时 timer */
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

/** questionId → PendingQuestion */
// 共享 bypass 判定的依赖注入：所有都是 module-level singleton，构造一次复用
const threadBypassDeps: ThreadBypassDeps = {
  client: feishuClient,
  getThreadSession: (threadId, agentId) => sessionManager.getThreadSession(threadId, agentId),
  isOwner,
};

const pendingQuestions = new Map<string, PendingQuestion>();

/** AskUserQuestion 等待超时（毫秒）。0 表示永不超时（默认）。 */
const ASK_USER_TIMEOUT_MS = (() => {
  const raw = process.env.ASK_USER_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

/**
 * 创建 AskUserQuestion 回调（供 executeClaudeTask / executeDirectTask 共用）
 * 将 Claude 的 AskUserQuestion 工具调用渲染为飞书交互卡片，等待用户点击按钮回答。
 */
function createAskUserHandler(chatId: string, getThreadReplyMsgId: () => string | undefined) {
  return async (questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>) => {
    const questionId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const questionItems: AskUserQuestionItem[] = questions.map(q => ({
      question: q.question,
      header: q.header,
      options: q.options.map(o => ({ label: o.label, description: o.description })),
      multiSelect: q.multiSelect,
    }));

    const card = buildAskUserQuestionCard(questionId, questionItems);

    return new Promise<Record<string, string>>((resolve, reject) => {
      const pending: PendingQuestion = {
        questions: questionItems,
        answers: {},
        totalQuestions: questions.length,
        resolve,
        reject,
        chatId,
      };

      if (ASK_USER_TIMEOUT_MS > 0) {
        pending.timeoutTimer = setTimeout(() => {
          pendingQuestions.delete(questionId);
          reject(new Error('AskUserQuestion timed out'));
        }, ASK_USER_TIMEOUT_MS);
      }

      pendingQuestions.set(questionId, pending);

      // 发送卡片（在话题内回复或直接发到群）
      // 如果发送失败，立即 reject 而非等待用户回答（避免任务永久挂起）
      const trySendCard = async () => {
        try {
          const threadMsgId = getThreadReplyMsgId();
          const msgId = threadMsgId
            ? await feishuClient.replyCardInThread(threadMsgId, card)
            : await feishuClient.sendCard(chatId, card);
          pending.cardMessageId = msgId ?? undefined;
        } catch (err) {
          logger.warn({ err, questionId }, 'Failed to send AskUserQuestion card');
          pendingQuestions.delete(questionId);
          if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
          reject(err instanceof Error ? err : new Error('Failed to send AskUserQuestion card'));
        }
      };
      trySendCard();
    });
  };
}

/** 处理 AskUserQuestion 卡片按钮点击 */
function handleAskUserAnswer(actionValue: Record<string, unknown>): Record<string, unknown> {
  const questionId = actionValue.questionId as string | undefined;
  const questionIndex = actionValue.questionIndex as number | undefined;
  const optionLabel = actionValue.optionLabel as string | undefined;

  if (!questionId || questionIndex == null || !optionLabel) return {};

  const pending = pendingQuestions.get(questionId);
  if (!pending) {
    logger.warn({ questionId }, 'AskUserQuestion answer received but no pending question found');
    return {
      toast: {
        type: 'info' as const,
        content: '该问题已过期或已回答',
      },
    };
  }

  const question = pending.questions[questionIndex];
  if (!question) return {};

  // 用 questionIndex 作为内部 key，避免相同问题文本导致 key 冲突
  pending.answers[String(questionIndex)] = optionLabel;

  // 检查是否所有问题都已回答
  if (Object.keys(pending.answers).length >= pending.totalQuestions) {
    // 全部回答完毕：将 index-keyed 答案转换回 question-text-keyed（SDK 需要）
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
    const sdkAnswers: Record<string, string> = {};
    const displayAnswers: Record<string, string> = {};
    for (const [idx, answer] of Object.entries(pending.answers)) {
      const q = pending.questions[Number(idx)];
      if (q) {
        sdkAnswers[q.question] = answer;
        displayAnswers[q.question] = answer;
      }
    }
    pending.resolve(sdkAnswers);
    pendingQuestions.delete(questionId);

    // 返回已回答卡片（替换原卡片）
    return buildAskUserAnsweredCard(pending.questions, displayAnswers);
  }

  // 部分回答：返回 toast 提示
  return {
    toast: {
      type: 'success' as const,
      content: `已选择: ${optionLabel}`,
    },
  };
}

// 消息去重缓存 (accountId:message_id → 时间戳)，防止飞书重试导致重复处理
// 多 bot 模式下每个 bot 独立去重（key 包含 accountId），避免跨 bot 误去重
const processedMessages = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 分钟过期

function isDuplicate(messageId: string, accountId: string = 'default'): boolean {
  const dedupKey = `${accountId}:${messageId}`;
  const now = Date.now();
  // 清理过期条目
  if (processedMessages.size > 500) {
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL_MS) processedMessages.delete(id);
    }
  }
  if (processedMessages.has(dedupKey)) return true;
  processedMessages.set(dedupKey, now);
  return false;
}

/**
 * 创建飞书事件分发器
 *
 * @param accountId 多 bot 模式下的 bot 账号标识（通过闭包绑定到 handler）。
 *   每个 bot 各自创建独立的 EventDispatcher + WSClient，确保收到事件时知道是哪个 bot 的。
 *   单 bot 模式下 accountId = 'default'。
 */
export function createEventDispatcher(accountId: string = 'default'): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({
    encryptKey: config.feishu.encryptKey || undefined,
    verificationToken: config.feishu.verifyToken || undefined,
  });

  // 注册消息接收事件 (im.message.receive_v1)
  // accountId 通过闭包绑定，handleMessageEvent 无需从事件数据推断
  // runWithAccountId 将 accountId 注入 AsyncLocalStorage，
  // 下游所有 feishuClient 调用自动路由到正确的 per-account client
  dispatcher.register({
    'im.message.receive_v1': async (data) => {
      try {
        await runWithAccountId(accountId, () => handleMessageEvent(data, accountId));
      } catch (err) {
        logger.error({ err, accountId }, 'Error handling message event');
      }
    },
  });

  // 注册卡片交互回调 (card.action.trigger)
  dispatcher.register({
    'card.action.trigger': async (data: Record<string, unknown>) => {
      try {
        const cardBody = await runWithAccountId(accountId, () => handleCardAction(data));
        // Toast responses: return as-is (no card replacement, just show notification)
        if (cardBody && 'toast' in cardBody) {
          return cardBody;
        }
        if (cardBody && Object.keys(cardBody).length > 0) {
          return { card: { type: 'raw', data: cardBody } };
        }
        return {};
      } catch (err) {
        logger.error({ err }, 'Error handling card action trigger');
        return {};
      }
    },
  });

  // Bot 入群事件（SDK 无此事件类型定义，用 as any 绕过 + 运行时校验）
  (dispatcher as any).register({
    'im.chat.member.bot.added_v1': async (data: Record<string, unknown>) => {
      try {
        await runWithAccountId(accountId, () => handleBotAddedEvent(data, accountId));
      } catch (err) {
        logger.error({ err, accountId }, 'Error handling bot added event');
      }
    },
  });

  // Bot 离群事件
  (dispatcher as any).register({
    'im.chat.member.bot.deleted_v1': async (data: Record<string, unknown>) => {
      try {
        await runWithAccountId(accountId, () => handleBotDeletedEvent(data, accountId));
      } catch (err) {
        logger.error({ err, accountId }, 'Error handling bot deleted event');
      }
    },
  });

  logger.debug({ accountId }, 'Feishu EventDispatcher created');
  return dispatcher;
}

/**
 * 处理卡片交互动作（共享逻辑）
 * 被 EventDispatcher (card.action.trigger) 和 CardActionHandler 共用
 */
async function handleCardAction(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = data.action as { value?: Record<string, unknown> } | undefined;
  const actionType = action?.value?.action as string | undefined;
  const pipelineId = action?.value?.pipelineId as string | undefined;
  const approvalId = action?.value?.approvalId as string | undefined;

  // 提取操作者 user ID
  const operatorId = (data.operator as { open_id?: string } | undefined)?.open_id;

  logger.info({ actionType, pipelineId, approvalId, operatorId }, 'Card action received');

  if (!actionType) return {};

  // 审批卡片动作（approval_approve / approval_reject）
  if ((actionType === 'approval_approve' || actionType === 'approval_reject') && approvalId && operatorId) {
    return handleApprovalCardAction(actionType, approvalId, operatorId);
  }

  // 记忆管理卡片动作（memory_*）
  if (actionType.startsWith('memory_') && operatorId) {
    return handleMemoryCardAction(actionType, action?.value, operatorId);
  }

  // AskUserQuestion 卡片动作
  if (actionType === 'ask_user_answer' && action?.value) {
    return handleAskUserAnswer(action.value);
  }

  // 管道卡片动作需要 pipelineId
  if (!pipelineId) return {};

  // 验证操作者身份：无法识别身份时拒绝操作（fail closed）
  if (!operatorId) {
    logger.warn({ pipelineId }, 'Card action rejected: no operator identity');
    return {};
  }

  // 只有管道创建者可以操作
  const record = pipelineStore.get(pipelineId);
  if (record && record.userId !== operatorId) {
    logger.warn({ pipelineId, operatorId, ownerId: record.userId }, 'Card action rejected: operator is not pipeline owner');
    return {};
  }

  switch (actionType) {
    case 'pipeline_confirm':
      return handlePipelineConfirm(pipelineId);
    case 'pipeline_cancel':
      return handlePipelineCancel(pipelineId);
    case 'pipeline_abort':
      return handlePipelineAbort(pipelineId);
    case 'pipeline_retry':
      return handlePipelineRetry(pipelineId);
    default:
      logger.warn({ actionType }, 'Unknown card action');
      return {};
  }
}

/**
 * 创建飞书卡片交互处理器（Webhook 模式使用）
 */
export function createCardActionHandler(): lark.CardActionHandler {
  const handler = new lark.CardActionHandler({
    encryptKey: config.feishu.encryptKey || undefined,
    verificationToken: config.feishu.verifyToken || undefined,
  }, (data: Record<string, unknown>) => handleCardAction(data));

  return handler;
}

async function handlePipelineConfirm(pipelineId: string): Promise<Record<string, unknown>> {
  const record = pipelineStore.get(pipelineId);
  if (!record) return {};

  // 同步执行 CAS，确保只在转换成功后才返回进度卡片
  // 避免 CAS 失败时用户看到卡住的进度卡片
  if (!pipelineStore.tryStart(pipelineId)) {
    // 已经被处理过（double-click 或并发取消）
    return {};
  }

  // CAS 成功，在后台启动管道（startPipeline 会跳过自身的 tryStart）
  startPipeline(pipelineId).catch((err) => {
    logger.error({ err, pipelineId }, 'Failed to start pipeline');
  });

  // 不返回卡片 — 让 startPipeline 通过 updateCard API 统一管理卡片状态。
  // 如果这里返回卡片，card action response 可能在管道完成后才到达飞书服务端，
  // 导致最终的"完成"卡片被覆盖为初始进度卡片（race condition）。
  return {};
}

async function handlePipelineCancel(pipelineId: string): Promise<Record<string, unknown>> {
  const record = pipelineStore.get(pipelineId);
  if (!record) return {};

  cancelPipeline(pipelineId);
  return buildCancelledCard(record.prompt);
}

async function handlePipelineAbort(pipelineId: string): Promise<Record<string, unknown>> {
  abortPipeline(pipelineId);
  // 不立即替换卡片 — orchestrator 的 onPhaseChange 会在最终状态时更新
  return {};
}

async function handlePipelineRetry(pipelineId: string): Promise<Record<string, unknown>> {
  const record = pipelineStore.get(pipelineId);
  if (!record) return {};

  const newId = await retryPipeline(pipelineId);
  if (!newId) return {};

  const newRecord = pipelineStore.get(newId);
  if (!newRecord) return {};

  return buildPipelineConfirmCard(newRecord.prompt, newId, newRecord.workingDir);
}

// ============================================================
// @mention 白名单过滤 — 必须返回明确理由才放行
// ============================================================

interface MentionGateInput {
  chatType: string;
  mentionedBot: boolean;
  mentions: Array<{ id: { open_id?: string } }>;
  threadId?: string;
  messageId: string;
  text: string;
  userId: string;
  chatId: string;
  agentId: string;
  accountId: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
}

async function resolveMentionGate(input: MentionGateInput): Promise<string | undefined> {
  const { chatType, mentionedBot, mentions, threadId, messageId, text, userId, chatId, agentId, accountId } = input;

  // 私聊始终放行
  if (chatType === 'p2p') return 'p2p';

  if (isMultiBotMode()) {
    const botOpenId = accountManager.getBotOpenId(accountId) ?? '';
    const allBotOpenIds = accountManager.getAllBotOpenIds();
    const groupConfig = config.agent.groupConfigs[chatId];
    const commanderOpenId = groupConfig?.commander
      ? accountManager.getBotOpenId(groupConfig.commander)
      : undefined;

    // 补充 chatBotRegistry 中跨 app bot open_id
    const registryBotIds = chatBotRegistry.getBots(chatId).map(b => b.openId);
    const knownBotIds = new Set([...allBotOpenIds, ...registryBotIds]);

    // 话题内 thread bypass：话题创建者 bot 无需 @mention 也可继续对话。
    // 但只要用户 @ 了"除本 bot 以外的任何对象"，就说明在叫别人 —— 不 bypass。
    //
    // 为什么以"是否 @ 了非自己"为准，而不是"是否 @ 了已知 bot"：
    // 飞书 open_id 按 app 隔离，同一个 bot 在不同 app 下 open_id 不同。
    // getAllBotOpenIds() 存的是各 bot 用自己 app 拉到的「自视 open_id」，
    // 当用户 @ 了另一个 bot 时，本 bot 的 app 收到的那条 mention 是「对方在本 app 视角下的 open_id」，
    // 不在 knownBotIds 里 → anyBotMentioned 漏判 → 话题创建者 bot 误以为没人被 @ 而抢答。
    // 每个 bot 唯一能确信的就是自己的 open_id，故改用「@ 了非自己」作为不 bypass 的判据。
    const mentionsOtherParty = mentions.some(
      (m) => !!m.id.open_id && m.id.open_id !== botOpenId,
    );
    if (threadId && !mentionsOtherParty && isThreadCreatorAgent(threadId, agentId)) {
      const result = await evaluateThreadBypass(threadBypassDeps, {
        threadId, chatId, agentId, senderUserId: userId, messageId,
      });
      if (result.allow) {
        return 'thread_bypass';
      }
      if (result.reason === 'multi_user') {
        logger.info(
          { threadId, agentId, sessionUserId: result.sessionUserId, text: text?.slice(0, 100) },
          'Thread bypass skipped — multi-user thread without @mention',
        );
      }
      // no_session / not_creator：静默落回 @mention 路由
    }

    // @mention / commander 路由
    const reason = getRespondReason(chatType, mentions, botOpenId, knownBotIds, commanderOpenId);
    if (reason) return reason;

    return undefined;
  }

  // 单 bot 模式
  if (mentionedBot) return 'mentioned';
  if (chatType !== 'group') return 'non_group';

  // 群聊未 @mention：仅话题内 session 创建者可放行（共享判定逻辑，与多 bot 一致）
  if (!threadId) return undefined;

  // 若消息 @ 了"除本 bot 以外的任何对象"（哪怕是另一个独立服务的 bot），说明在叫别人，不 bypass。
  // 走到这里说明本 bot 未被 @（@自己已在上方 mentionedBot 分支返回），故任一带 open_id 的 mention 都是「@别人」。
  const selfOpenId = feishuClient.botOpenId ?? '';
  const mentionsOtherParty = mentions.some(
    (m) => !!m.id.open_id && m.id.open_id !== selfOpenId,
  );
  if (mentionsOtherParty) return undefined;

  const result = await evaluateThreadBypass(threadBypassDeps, {
    threadId, chatId, senderUserId: userId, messageId,
  });
  if (!result.allow) {
    if (result.reason === 'multi_user') {
      logger.info(
        { messageId, threadId, sessionUserId: result.sessionUserId, text: text?.slice(0, 100) },
        'Single-bot thread bypass skipped — multi-user thread without @mention',
      );
    }
    return undefined;
  }
  return 'thread_session_owner';
}

// ============================================================
// 话题创建者判定
// ============================================================

/**
 * 判断指定 agent 是否为某话题的创建者（拥有最早的 thread session）。
 * 被 @mention 后加入的 agent 只在显式 @mention 时响应。
 */
function isThreadCreatorAgent(threadId: string, agentId: string): boolean {
  const mySession = sessionManager.getThreadSession(threadId, agentId);
  if (!mySession) return false;

  for (const otherId of agentRegistry.allIds()) {
    if (otherId === agentId) continue;
    const other = sessionManager.getThreadSession(threadId, otherId);
    if (other && other.createdAt < mySession.createdAt) return false;
  }
  return true;
}

// ============================================================
// 队列驱动：同一 thread 内串行执行，不同 thread 间可并行
// queueKey = threadId 存在时用 `chatId:threadId`，否则用 `chatId`
//
// thread 模式下无 threadId 的消息（p2p/群聊首条）：用 messageId 区分，
// 因为每条消息会创建独立话题，不需要串行等待。
// ============================================================

/**
 * 构建队列 key，包含 agentId 维度
 * 同 thread 同 agent 串行，不同 agent 可并行
 *
 * direct 模式（无 thread）加入 userId，不同用户可并行
 * thread 模式（无 thread）加入 messageId，每条消息可并行
 */
function makeQueueKey(chatId: string, threadId?: string, agentId: string = 'dev', userId?: string): string {
  if (threadId) {
    return `${agentId}:${chatId}:${threadId}`;
  }
  // direct 模式: 加 userId 实现 per-user 并行
  if (userId) {
    return `${agentId}:${chatId}:${userId}`;
  }
  return `${agentId}:${chatId}`;
}

function processQueue(queueKey: string, agentId: AgentId = 'dev'): void {
  const task = taskQueue.dequeue(queueKey);
  if (!task) return;

  // 恢复 task 入队时的 feishuClient 上下文（accountId），
  // 防止 .finally() 回调继承前一个 task 的 AsyncLocalStorage 上下文
  const taskAccountId = task.accountId ?? 'default';

  const execute = () => {
    const agentCfg = agentRegistry.get(agentId);
    const useDirectMode = agentCfg?.replyMode === 'direct';

    const executeFn = useDirectMode
      ? executeDirectTask(task.message, task.chatId, task.userId, task.messageId, task.images, task.documents, agentId, task.threadId, task.rootId, task.createTime, { forceThread: task.forceThread }, task.messageType)
      : executeClaudeTask(task.message, task.chatId, task.userId, task.messageId, task.rootId, task.threadId, task.images, task.documents, agentId, task.createTime, task.messageType, task.currentImagePaths);

    claudeExecutor.registerTask(executeFn);

    executeFn
      .then(() => task.resolve('done'))
      .catch((err) => task.reject(err instanceof Error ? err : new Error(String(err))))
      .finally(() => {
        taskQueue.complete(queueKey);
        processQueue(queueKey, agentId);
      });
  };

  runWithAccountId(taskAccountId, execute);
}

// ============================================================
// 管道文本确认 (卡片按钮不可用时的 fallback)
// ============================================================

/**
 * 处理用户通过文本消息确认/取消管道。
 * 当飞书卡片按钮不可用（如未配置 card.action.trigger 事件订阅）时，
 * 用户可以直接回复 "确认" 或 "取消" 来操作待确认的管道。
 */
async function handlePipelineTextConfirm(
  text: string,
  chatId: string,
  userId: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed !== '确认' && trimmed !== '取消') return false;

  const pending = pipelineStore.findPendingByChat(chatId, userId);
  if (!pending) return false;

  if (trimmed === '确认') {
    if (!pipelineStore.tryStart(pending.id)) {
      // 已被处理（double-click 或并发）
      return true;
    }

    logger.info({ pipelineId: pending.id, chatId, userId }, 'Pipeline confirmed via text message');

    // 更新确认卡片为初始进度卡片
    if (pending.progressMsgId) {
      const progressCard = buildPipelineCard(pending.prompt, 'plan', 1, TOTAL_PHASES, 0, undefined, undefined, pending.id);
      await feishuClient.updateCard(pending.progressMsgId, progressCard);
    }

    // 后台启动管道
    startPipeline(pending.id).catch((err) => {
      logger.error({ err, pipelineId: pending.id }, 'Failed to start pipeline');
    });

    return true;
  }

  if (trimmed === '取消') {
    const cancelled = cancelPipeline(pending.id);
    if (!cancelled) return true;

    logger.info({ pipelineId: pending.id, chatId, userId }, 'Pipeline cancelled via text message');

    // 更新卡片为已取消
    if (pending.progressMsgId) {
      await feishuClient.updateCard(pending.progressMsgId, buildCancelledCard(pending.prompt));
    }

    return true;
  }

  return false;
}

// ============================================================
// 消息处理逻辑
// ============================================================

/** SDK 回调的事件数据类型 */
interface MessageEventData {
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
}

/** 解析后的消息 */
interface ParsedMessage {
  text: string;
  messageId: string;
  userId: string;
  chatId: string;
  chatType: string;
  /** 单 bot 模式下的 @mention 检测结果 */
  mentionedBot: boolean;
  /** 原始 mentions 数组（多 bot 模式 @mention 过滤使用） */
  mentions: Array<{ id: { open_id?: string } }>;
  /** message.root_id — 回复链根消息 ID */
  rootId?: string;
  /** message.thread_id — 飞书话题 ID（可靠的话题标识） */
  threadId?: string;
  /** 图片附件列表 (用户发送图片消息时) */
  images?: ImageAttachment[];
  /** 文档附件列表 (用户发送 PDF 等文件时) */
  documents?: DocumentAttachment[];
  /** 原始消息类型（text/image/file 等），用于区分"新文件上传"与"引用父消息文件" */
  messageType?: string;
  /** 发送者类型: 'user' = 人类用户, 'app' = 应用/机器人 */
  senderType?: string;
  /** 消息创建时间（毫秒级时间戳字符串，来自飞书 message.create_time） */
  createTime?: string;
  /** 当前消息内图片的落盘路径（workspace 切换后 restart 不重传多模态 images，用此作为文本 fallback） */
  currentImagePaths?: string[];
}

/**
 * 处理消息事件 (由 EventDispatcher 回调)
 *
 * 多 Agent 模式处理流程：
 * ① resolveMentionGate — @mention 白名单过滤
 * ② Binding Router — 选 agent 角色
 * ③ Slash command — 在 agent 角色确定后执行
 * ④ Workspace Router — 选工作目录（在 resolveThreadContext 中）
 * ⑤ Agent 执行
 */
async function handleMessageEvent(data: MessageEventData, accountId: string = 'default'): Promise<void> {
  // 消息去重：飞书可能在未及时收到响应时重试推送（移到 parseMessage 之前，避免图片重复下载）
  // key 包含 accountId，多 bot 共存时各自独立去重
  if (isDuplicate(data.message.message_id, accountId)) {
    logger.debug({ messageId: data.message.message_id, accountId }, 'Duplicate message ignored');
    return;
  }

  // 过期消息丢弃：服务重启后 WebSocket 重连可能重放旧的未确认消息
  // create_time 为毫秒级时间戳字符串
  const messageAgeMs = Date.now() - Number(data.message.create_time);
  const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000; // 5 分钟
  if (messageAgeMs > MAX_MESSAGE_AGE_MS) {
    logger.warn({ messageId: data.message.message_id, messageAgeMs, accountId }, 'Stale message ignored (older than 5 minutes)');
    return;
  }

  // -- 被动收集：消息发送者为 bot 时记录到 registry --
  // 必须在 parseMessage 之前执行：bot 发的卡片消息 (interactive) 会被 parseMessage 过滤掉，
  // 如果放在后面，卡片消息的 bot sender 永远不会被注册。
  {
    const sender = data.sender;
    const senderUserId = sender.sender_id?.open_id;
    const senderChatId = data.message.chat_id;
    if (sender.sender_type === 'app' && senderUserId && senderChatId) {
      const selfBotOpenIds = accountManager.getAllBotOpenIds();
      const selfBotOpenId = feishuClient.botOpenId;
      if (selfBotOpenId) selfBotOpenIds.add(selfBotOpenId);
      if (!selfBotOpenIds.has(senderUserId)) {
        chatBotRegistry.addBot(senderChatId, senderUserId, undefined, 'message_sender');
      }
    }
  }

  const parsed = await parseMessage(data);
  if (!parsed) return;

  const { text, messageId, userId, chatId, chatType, mentionedBot, rootId, threadId, images, documents, messageType, mentions, createTime, currentImagePaths } = parsed;

  logger.info({ userId, chatId, chatType, rootId, threadId, accountId, text: text.slice(0, 100), hasImages: !!images?.length }, 'Received message');

  // ── 多 Agent: Binding Router 选 agent 角色（提前解析，供 @mention 过滤使用） ──
  const allBindings = [...getExplicitBindings(), ...deriveBindings()];
  const agentId: AgentId = isMultiBotMode()
    ? resolveAgent(allBindings, { accountId, chatId, userId, chatType: chatType as 'group' | 'p2p' })
    : 'dev'; // 单 bot 模式默认 dev agent

  // ── 无需 @mention 的斜杠命令（在 @mention 过滤之前拦截） ──
  if (text) {
    const trimmedText = text.trim();
    if (trimmedText === '/auth' || trimmedText.startsWith('/auth ')) {
      // /auth 命令：仅 owner 可用，多 bot 模式下仅 dev-bot 处理
      if (!isMultiBotMode() || agentId === 'dev') {
        if (!isOwner(userId)) {
          await feishuClient.replyText(messageId, '仅管理员可执行 /auth 命令');
          return;
        }
        const rootReplyId = rootId || undefined;
        const codeArg = trimmedText.startsWith('/auth ') ? trimmedText.slice('/auth '.length).trim() : '';
        if (codeArg) {
          try {
            await handleManualCode(codeArg, userId, chatId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (rootReplyId) {
              await feishuClient.replyTextInThread(rootReplyId, msg);
            } else {
              await feishuClient.replyText(messageId, msg);
            }
          }
        } else {
          const authUrl = generateAuthUrl(userId, chatId);
          const reply = hasCallbackUrl()
            ? `请点击以下链接授权，授权后即可查看个人任务：\n${authUrl}`
            : `请点击以下链接授权：\n${authUrl}\n\n授权完成后，浏览器会跳转到一个打不开的页面，这是正常的。请复制地址栏中 code= 后面的那串字符，发送：\n/auth <code值>`;
          if (rootReplyId) {
            await feishuClient.replyTextInThread(rootReplyId, reply);
          } else {
            await feishuClient.replyText(messageId, reply);
          }
        }
        return;
      }
      // 其他 bot 静默忽略 /auth
      return;
    }
  }

  // ── @mention 过滤（白名单模式：必须有明确放行理由，否则一律拦截） ──
  const passReason = await resolveMentionGate({
    chatType, mentionedBot, mentions, threadId, messageId, text,
    userId, chatId, agentId, accountId, images, documents,
  });
  if (!passReason) {
    logger.info({ messageId, chatId, threadId, agentId, accountId, chatType }, '@mention gate: blocked — no pass reason');
    return;
  }
  logger.info({ messageId, chatId, threadId, agentId, accountId, passReason }, '@mention gate: passed');

  // root_id 单独出现（无 thread_id）= 主面板引用回复，不是话题内消息，正常处理即可

  const effectiveThreadId = threadId;

  const agentConfig = agentRegistry.get(agentId);
  logger.debug({ agentId, accountId }, 'Agent resolved');

  // 自动检测 owner：OWNER_USER_ID 未配置时，首个发消息的白名单用户自动成为管理员
  // 必须先过白名单检查，否则非白名单用户可自动成为 owner 绕过审批
  if (isUserAllowed(userId) && autoDetectOwner(userId)) {
    await feishuClient.replyText(messageId, `🔑 已自动将你设为管理员 (${userId})，已写入 .env`);
  }

  // 用户权限检查：不在白名单的用户走审批流程（而非直接拒绝）
  if (!isUserAllowed(userId)) {
    if (!config.security.ownerUserId) {
      // 没有 owner 无法审批，直接放行
      logger.debug({ userId }, 'No owner configured, allowing unlisted user');
    } else {
      const session = sessionManager.get(chatId, userId, agentId);
      const threadIdForApproval = effectiveThreadId || session?.threadId;
      const approved = await checkAndRequestApproval(
        userId, chatId, chatType, text || '', messageId,
        accountId, agentId, rootId, rootId, threadIdForApproval,
      );
      if (!approved) return;
    }
  }

  // /t <text> — 强制话题回复 + 跳过 quick-ack（仅对 direct 模式 agent 生效）
  // thread 模式 agent 本身就会创建话题，/t 对其无意义，直接忽略前缀
  let forceThread = false;
  let strippedText = text; // /t 命令剥离前缀后的文本
  const isAgentDirectMode = agentConfig?.replyMode === 'direct';
  if (text && isAgentDirectMode) {
    const trimmedForT = text.trim();
    if (trimmedForT === '/t') {
      await feishuClient.replyText(messageId, '⚠️ 用法: `/t <消息内容>` — 强制开话题回复');
      return;
    }
    if (trimmedForT.startsWith('/t ')) {
      strippedText = trimmedForT.slice('/t '.length).trim();
      forceThread = true;
    }
  }

  // 斜杠命令、管道确认、审批命令仅对文本消息有效
  if (text && !forceThread) {
    // 处理斜杠命令（在 agent 角色确定后执行）
    const commandResult = await handleSlashCommand(text, chatId, userId, messageId, rootId, effectiveThreadId, agentId, accountId);
    if (commandResult) return;

    // 处理管道消息确认（卡片按钮的文本 fallback）
    const pipelineHandled = await handlePipelineTextConfirm(text, chatId, userId);
    if (pipelineHandled) return;

    // 处理审批文本命令（owner 回复 "允许"/"拒绝"）
    if (handleApprovalTextCommand(text, userId, chatId, effectiveThreadId)) return;
  }

  // 非 owner 用户审批检查
  // Chat Agent (readonly) 无需审批；Dev Agent 由 agentConfig.requiresApproval 控制
  if (agentConfig?.requiresApproval) {
    const session = sessionManager.get(chatId, userId, agentId);
    const threadIdForApproval = effectiveThreadId || session?.threadId;
    const approved = await checkAndRequestApproval(
      userId, chatId, chatType, strippedText, messageId,
      accountId, agentId, rootId, rootId, threadIdForApproval,
    );
    if (!approved) return;
  }

  // 安全检查（图片消息无文本，跳过）
  if (strippedText && containsDangerousCommand(strippedText)) {
    await feishuClient.replyText(messageId, '⚠️ 检测到危险命令，已拒绝执行');
    return;
  }

  // 图片/文档消息无文字时使用默认 prompt
  const effectiveText = strippedText || (images?.length ? DEFAULT_IMAGE_PROMPT : documents?.length ? DEFAULT_DOCUMENT_PROMPT : '');

  // 通过 taskQueue 串行化：queue key 包含 agentId，不同 agent 可并行
  // direct 模式加 userId，不同用户可并行
  // enqueue 返回的 Promise 的错误处理在 processQueue/executeClaudeTask 中完成
  const isDirectMode = agentConfig?.replyMode === 'direct';
  // 无话题消息并行执行：thread 模式下每条无 threadId 的消息会创建独立话题，
  // 用 messageId 区分队列键，避免同一 chat 内的独立消息被串行化
  const perMessageParallel = !effectiveThreadId && !isDirectMode;
  const queueKey = perMessageParallel
    ? makeQueueKey(chatId, undefined, agentId, messageId)
    : makeQueueKey(chatId, effectiveThreadId, agentId, isDirectMode ? userId : undefined);
  taskQueue.enqueue(queueKey, chatId, userId, effectiveText, messageId, rootId, effectiveThreadId, images, documents, createTime, forceThread, messageType, accountId, currentImagePaths).catch(() => {});
  processQueue(queueKey, agentId);
}

/**
 * 处理斜杠命令
 */
async function handleSlashCommand(
  text: string,
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
  effectiveThreadId?: string,
  agentId: AgentId = 'dev',
  accountId: string = 'default',
): Promise<boolean> {
  const trimmed = text.trim();

  // 仅当用户确实在话题内发消息时（有 threadId），才回复到话题
  // rootId 单独出现（无 threadId）= 主面板引用回复，不应跟进话题
  // 不 fallback 到 session 的 threadRootMessageId，避免群主界面的命令被发到旧话题
  const threadReplyMsgId = effectiveThreadId ? rootId : undefined;

  // /status - 查看状态
  if (trimmed === '/status') {
    const session = sessionManager.getOrCreate(chatId, userId, agentId);
    const threadForcedModel = effectiveThreadId
      ? sessionManager.getThreadSession(effectiveThreadId, agentId)?.forcedModel
      : undefined;
    const forcedModel = resolveForcedModel(threadForcedModel, session.forcedModel);
    const card = buildStatusCard(
      session.workingDir,
      session.status,
      taskQueue.pendingCountForChat(chatId),
      forcedModel,
    );
    if (threadReplyMsgId) {
      await feishuClient.replyCardInThread(threadReplyMsgId, card);
    } else {
      await feishuClient.sendCard(chatId, card);
    }
    return true;
  }

  // /auth 已在 @mention 过滤之前处理（无需 @ 即可触发），此处不再重复

  // /reset、/clear - 重置会话（清除所有 agent 的 session + thread conversation）
  // /clear 是 Claude Code 的清空命令，这里作为 /reset 的别名（本地清掉 conversationId
  // 即等效于清空：下次 query 不带 resume，开启全新 session）
  if (trimmed === '/reset' || trimmed === '/clear') {
    claudeExecutor.killSessionsForChat(chatId, userId);
    // 重置所有 agent 的主 session
    for (const aid of ['dev', 'pm'] as const) {
      sessionManager.reset(chatId, userId, aid);
    }
    // 如果在话题内，额外清除 thread session 的 conversationId
    if (effectiveThreadId) {
      for (const aid of ['dev', 'pm'] as const) {
        sessionManager.resetThreadConversation(effectiveThreadId, aid);
      }
    }
    const reply = '🔄 会话已重置，下次消息将使用全新 session';
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, reply);
    } else {
      await feishuClient.replyText(messageId, reply);
    }
    return true;
  }

  // /stop - 中断执行
  if (trimmed === '/stop') {
    claudeExecutor.killSessionsForChat(chatId, userId);
    taskQueue.cancelAllForChat(chatId);
    sessionManager.setStatus(chatId, userId, 'idle');
    const reply = '🛑 已中断当前会话的执行';
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, reply);
    } else {
      await feishuClient.replyText(messageId, reply);
    }
    return true;
  }

  // /compact - 压缩当前会话上下文
  // 直接在飞书发 /compact 无效：normal task 链路会层层加前缀（发送者标签/历史/记忆/时间），
  // 把 /compact 挤出消息开头，CLI 便不再识别为 local slash command。这里拦截后以**裸**
  // /compact + resume 透传给 SDK，触发真实压缩。
  if (trimmed === '/compact') {
    const replyFn = async (msg: string) => {
      if (threadReplyMsgId) await feishuClient.replyTextInThread(threadReplyMsgId, msg);
      else await feishuClient.replyText(messageId, msg);
    };

    const session = sessionManager.getOrCreate(chatId, userId, agentId);

    // resume 目标：话题内用 thread session，否则用主 session
    let conversationId: string | undefined;
    let convCwd: string | undefined;
    let workingDir: string;
    let threadForcedModel: string | undefined;
    if (effectiveThreadId) {
      const ts = sessionManager.getThreadSession(effectiveThreadId, agentId);
      conversationId = ts?.conversationId;
      convCwd = ts?.conversationCwd;
      workingDir = ts?.workingDir ?? session.workingDir;
      threadForcedModel = ts?.forcedModel;
    } else {
      conversationId = session.conversationId;
      convCwd = session.conversationCwd;
      workingDir = session.workingDir;
    }

    if (!conversationId) {
      await replyFn('ℹ️ 当前会话还没有可压缩的上下文（尚未开始对话或已 /reset）。');
      return true;
    }
    if (session.status === 'busy') {
      await replyFn('⚠️ 当前有任务正在执行，请等待完成或先 /stop，再 /compact。');
      return true;
    }

    // resume 要求 cwd 与建会话时一致；conversationCwd 缺失则回退到 workingDir
    const { existsSync } = await import('node:fs');
    const cwd = convCwd && existsSync(convCwd) ? convCwd : workingDir;
    const sessionKey = effectiveThreadId ? `${chatId}:${userId}:${effectiveThreadId}` : `${chatId}:${userId}`;
    // /fable 强制模型也应用于压缩查询，保持与正常执行一致
    const model = resolveForcedModel(threadForcedModel, session.forcedModel) ?? agentRegistry.get(agentId)?.model;

    await replyFn('🗜️ 正在压缩对话上下文，请稍候（约需 30–60 秒）…');

    sessionManager.setStatus(chatId, userId, 'busy', agentId);
    let result: CompactResult;
    try {
      result = await claudeExecutor.compact({ sessionKey, workingDir: cwd, resumeSessionId: conversationId, model });
    } finally {
      sessionManager.setStatus(chatId, userId, 'idle', agentId);
    }

    // 压缩成功后回存 session ID（实测与原 ID 相同，但保持与 normal 流程一致）
    if (result.success && result.sessionId) {
      if (effectiveThreadId) {
        sessionManager.setThreadConversationId(effectiveThreadId, result.sessionId, cwd, agentId);
      }
      sessionManager.setConversationId(chatId, userId, result.sessionId, cwd, agentId);
    }

    await replyFn(formatCompactReply(result));
    return true;
  }

  // /edit [repo] [task] - 原地编辑源仓库（OWNER only）
  if (trimmed === '/edit' || trimmed.startsWith('/edit ')) {
    if (!isOwner(userId)) {
      const reply = '⚠️ 只有管理员可以使用 /edit 命令';
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }

    const args = trimmed.slice('/edit'.length).trim();
    const { resolve: resolvePath } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const { findLocalPathByName } = await import('../workspace/registry.js');

    let targetDir: string | undefined;
    let task = args;

    if (args) {
      // 尝试解析第一个 token 为仓库名或路径
      const firstToken = args.split(/\s+/)[0];
      const rest = args.slice(firstToken.length).trim();

      // 1. 绝对路径
      if (firstToken.startsWith('/') && existsSync(firstToken)) {
        targetDir = resolvePath(firstToken);
        task = rest;
      } else {
        // 2. 按名字从 registry 查找
        const found = findLocalPathByName(firstToken);
        if (found && existsSync(found)) {
          targetDir = found;
          task = rest;
        }
        // 3. 未匹配到仓库名 → 整个 args 作为 task，使用当前 workdir
      }
    }

    // fallback: 使用 anycode 服务仓库本身（process.cwd()）
    // /edit 不指定仓库时，用户大概率是想改服务配置（知识、人设、agents.json）
    if (!targetDir) {
      targetDir = process.cwd();
    }

    // 验证目标路径存在
    if (!existsSync(targetDir)) {
      const reply = `⚠️ 路径不存在: ${targetDir}`;
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }

    // 设置 session workingDir
    sessionManager.getOrCreate(chatId, userId, agentId);
    sessionManager.setWorkingDir(chatId, userId, targetDir, agentId);

    // 确保话题存在并标记 inplaceEdit
    const threadResult = await ensureThread(chatId, userId, messageId, rootId, effectiveThreadId);
    const editThreadReplyMsgId = threadResult.threadReplyMsgId;
    const editThreadId = effectiveThreadId || sessionManager.getOrCreate(chatId, userId, agentId).threadId;

    if (editThreadId) {
      // 确保 thread session 存在
      if (!sessionManager.getThreadSession(editThreadId, agentId)) {
        sessionManager.upsertThreadSession(editThreadId, chatId, userId, targetDir, agentId);
      } else {
        sessionManager.setThreadWorkingDir(editThreadId, targetDir, agentId);
      }
      sessionManager.setThreadInplaceEdit(editThreadId, true, agentId);
    }

    // 确认消息
    const { basename: baseName } = await import('node:path');
    const repoName = baseName(targetDir);
    const confirmReply = [
      `📝 原地编辑模式 — ${repoName} (${targetDir})`,
      '⚠️ 直接修改源仓库，hot-reload 即时生效',
    ].join('\n');
    if (editThreadReplyMsgId) {
      await feishuClient.replyTextInThread(editThreadReplyMsgId, confirmReply);
    } else {
      await feishuClient.replyText(messageId, confirmReply);
    }

    // 如果有 task 内容，将其作为普通消息入队执行
    if (task) {
      // 当 /edit 目标是 anycode 服务仓库时，注入 agent 配置路径信息
      // 让 agent 知道自己的知识/人设文件在哪，以及 .example.md 是模板不要编辑
      let editPrompt = task;
      if (targetDir === process.cwd()) {
        const cfgInfo = getAgentConfigInfo(agentId);
        if (cfgInfo) {
          editPrompt = [
            '<agent-config-info>',
            '你正在编辑的是 anycode 服务仓库。',
            `你当前的 agent id 是 "${agentId}"，所有 agent 的配置（persona、knowledge 路径等）定义在: ${cfgInfo.configFile}`,
            '先读取该文件了解配置结构，再修改对应的文件。',
            '.example.md 是模板，不要编辑。只编辑不带 .example 的正式文件。',
            '配置文件支持热加载，修改后下次查询自动生效。',
            '</agent-config-info>',
            '',
            task,
          ].join('\n');
        }
      }
      const queueKey = editThreadId
        ? makeQueueKey(chatId, editThreadId, agentId)
        : makeQueueKey(chatId, undefined, agentId);
      taskQueue.enqueue(queueKey, chatId, userId, editPrompt, messageId, editThreadReplyMsgId || rootId, editThreadId, undefined, undefined, undefined, undefined, undefined, accountId).catch(() => {});
      processQueue(queueKey, agentId);
    }

    return true;
  }

  // /dev <task> - 自动开发管道
  if (trimmed.startsWith('/dev ')) {
    if (!isOwner(userId)) {
      const reply = '⚠️ 只有管理员可以使用 /dev 命令';
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }
    const task = trimmed.slice('/dev '.length).trim();
    if (!task) {
      const reply = '⚠️ 用法: `/dev <开发任务描述>`';
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }
    // 安全检查
    if (containsDangerousCommand(task)) {
      await feishuClient.replyText(messageId, '⚠️ 检测到危险命令，已拒绝执行');
      return true;
    }
    await executePipelineTask(task, chatId, userId, messageId, rootId, effectiveThreadId);
    return true;
  }

  // /fork [--clean] [描述] - Session Fork (Plan 8)
  if (trimmed === '/fork' || trimmed.startsWith('/fork ')) {
    if (!config.fork.enabled) {
      const reply = '⚠️ /fork 命令未启用 (FORK_ENABLED=false)';
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }

    if (!effectiveThreadId) {
      const reply = '⚠️ /fork 必须在话题内执行（先进入一个话题再 /fork）';
      await feishuClient.replyText(messageId, reply);
      return true;
    }

    // 解析 /fork [--clean] [描述]: --clean 必须在 description 之前
    const rawArgs = trimmed === '/fork' ? '' : trimmed.slice('/fork '.length).trim();
    let clean = false;
    let description = rawArgs;
    if (rawArgs === '--clean' || rawArgs.startsWith('--clean ')) {
      clean = true;
      description = rawArgs === '--clean' ? '' : rawArgs.slice('--clean '.length).trim();
    }
    const result = await forkSession({
      parentThreadId: effectiveThreadId,
      chatId,
      userId,
      triggerMessageId: messageId,
      description,
      agentId,
      clean,
    });

    if (!result.ok) {
      const reply = `⚠️ Fork 失败: ${result.message}`;
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }

    const ok = [
      `🔱 Fork 完成 (id=${result.shortId})`,
      `- 新话题已创建，继承了完整对话历史`,
      `- 工作目录: ${result.workingDir}`,
      `- 在新话题里继续发消息即可,与本话题互不影响`,
    ].join('\n');
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, ok);
    } else {
      await feishuClient.replyText(messageId, ok);
    }
    return true;
  }

  // /memory - 记忆管理
  if (trimmed === '/memory' || trimmed.startsWith('/memory ')) {
    const memoryArgs = trimmed === '/memory' ? '' : trimmed.slice('/memory '.length).trim();
    await handleMemoryCommand(memoryArgs, chatId, userId, messageId, threadReplyMsgId, agentId);
    return true;
  }

  // /config - 查看当前 agent 配置
  if (trimmed === '/config') {
    if (!isOwner(userId)) {
      const reply = '⚠️ 只有管理员可以使用 /config 命令';
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }

    const agentCfg = agentRegistry.get(agentId);
    const cfgInfo = getAgentConfigInfo(agentId);
    const personaContent = readPersonaFile(agentId);
    const knowledgeContent = loadKnowledgeContent(agentId);

    const lines: string[] = [
      `🔧 **Agent 配置 — ${agentId}**`,
      '',
      `**显示名称**: ${agentCfg?.displayName ?? '(未配置)'}`,
      ...(agentCfg?.description ? [`**描述**: ${agentCfg.description}`] : []),
      `**飞书 Bot 名**: ${feishuClient.botName ?? '(未获取)'}`,
      `**模型**: ${agentCfg?.model ?? '(默认)'}`,
      `**工具策略**: ${agentCfg?.toolPolicy ?? '(默认)'}`,
      `**回复模式**: ${agentCfg?.replyMode ?? '(默认)'}`,
      `**需要审批**: ${agentCfg?.requiresApproval ? '是' : '否'}`,
      `**预算**: ${agentCfg ? (agentCfg.maxBudgetUsd === undefined ? '关闭' : '$' + agentCfg.maxBudgetUsd) : '?'} / ${agentCfg?.maxTurns ?? '?'} turns`,
    ];

    if (agentCfg?.editablePathPatterns?.length) {
      lines.push(`**可编辑路径**: ${agentCfg.editablePathPatterns.join(', ')}`);
    }

    lines.push('');
    if (cfgInfo) {
      lines.push(`**配置文件**: ${cfgInfo.configFile}`);
      if (cfgInfo.personaFile) lines.push(`**人设文件**: ${cfgInfo.personaFile}`);
      if (cfgInfo.knowledgeDir) lines.push(`**知识目录**: ${cfgInfo.knowledgeDir}`);
      if (cfgInfo.knowledgeFiles.length > 0) {
        lines.push(`**知识文件**: ${cfgInfo.knowledgeFiles.join(', ')}`);
      }
    }

    if (personaContent) {
      const preview = personaContent.length > 200 ? personaContent.slice(0, 200) + '...' : personaContent;
      lines.push('', '**── 人设内容 ──**', preview);
    }

    if (knowledgeContent) {
      const preview = knowledgeContent.length > 200 ? knowledgeContent.slice(0, 200) + '...' : knowledgeContent;
      lines.push('', '**── 知识内容 ──**', preview);
    }

    const reply = lines.join('\n');
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, reply);
    } else {
      await feishuClient.replyText(messageId, reply);
    }
    return true;
  }

  // /fable [1m|off] - 强制本会话使用 claude-fable-5 模型（OWNER only）
  if (trimmed === '/fable' || trimmed.startsWith('/fable ')) {
    const replyFn = async (msg: string) => {
      if (threadReplyMsgId) await feishuClient.replyTextInThread(threadReplyMsgId, msg);
      else await feishuClient.replyText(messageId, msg);
    };

    if (!isOwner(userId)) {
      await replyFn('⚠️ 只有管理员可以使用 /fable 命令');
      return true;
    }

    const rawArgs = trimmed === '/fable' ? '' : trimmed.slice('/fable '.length).trim();
    const parsed = parseFableCommand(rawArgs);
    if (!parsed.ok) {
      await replyFn(parsed.error!);
      return true;
    }

    // 确保 chat 级 session 存在
    sessionManager.getOrCreate(chatId, userId, agentId);
    // 作用域：话题内且已有 thread session → 绑定该话题；否则绑定 chat 级 session
    const threadSession = effectiveThreadId
      ? sessionManager.getThreadSession(effectiveThreadId, agentId)
      : undefined;
    const bindToThread = Boolean(effectiveThreadId && threadSession);

    if (parsed.clear) {
      // 取消强制：清掉两级作用域，确保彻底恢复默认
      if (bindToThread) sessionManager.setThreadForcedModel(effectiveThreadId!, null, agentId);
      sessionManager.setForcedModel(chatId, userId, null, agentId);
      await replyFn('↩️ 已取消强制模型，本会话恢复使用默认模型（从下一条消息生效）。');
      return true;
    }

    const model = parsed.model!;
    if (bindToThread) {
      sessionManager.setThreadForcedModel(effectiveThreadId!, model, agentId);
    } else {
      sessionManager.setForcedModel(chatId, userId, model, agentId);
    }

    const ctxLabel = parsed.context1m ? '1M 上下文' : '默认上下文';
    const scopeLabel = bindToThread ? '本话题' : '本会话';
    await replyFn([
      `🎯 已强制${scopeLabel}使用 **${model}**（${ctxLabel}），从下一条消息生效。`,
      '发送 `/fable off` 恢复默认模型；`/fable 1m` 开启 1M 上下文。',
    ].join('\n'));
    return true;
  }

  // /help - 帮助
  if (trimmed === '/help') {
    const helpLines: string[] = [
      '🤖 **Anycode 使用帮助**',
      '',
      '直接发送消息即可与 Agent 对话。支持文本、图片、PDF 文件。',
      '',
      '**── 基础命令 ──**',
      '`/status` — 查看当前会话状态（工作目录、队列）',
      '`/compact` — 压缩当前会话上下文，降低后续 token 成本',
      '`/reset`（`/clear`）— 重置会话，清除对话历史',
      '`/stop` — 中断当前正在执行的任务',
      '`/config` — 查看当前 Agent 配置和人设 🔒',
      '`/fable [1m|off]` — 强制本会话用 claude-fable-5 模型，`1m` 开启 1M 上下文 🔒',
      '`/help` — 显示此帮助',
      '',
      '**── 工作区 ──**',
      '`/edit [repo] [task]` — 原地编辑源仓库，跳过 clone 隔离 🔒',
      '提到仓库 URL 或名称时，Agent 会自动创建隔离工作区',
      '',
      '**── 开发流程 ──**',
      '`/dev <task>` — 自动开发管道 🔒',
      '  方案 → 方案审查 → 实现 → 代码审查 → 推送 → PR 修复',
      '`/t <text>` — 强制开话题回复（适用于 direct 模式）',
    ];

    if (config.fork.enabled) {
      helpLines.push(
        '',
        '**── 话题 Fork ──**',
        '`/fork [描述]` — 从当前话题派生新话题，继承完整对话历史 🔒',
        '  适合在深入讨论中开辟新思路而不污染原话题',
      );
    }

    // 条件性功能
    if (config.memory.enabled) {
      helpLines.push(
        '',
        '**── 记忆系统 ──**',
        '`/memory` — 查看所有记忆',
        '`/memory search <关键词>` — 搜索记忆',
        '`/memory add <内容>` — 手动添加记忆',
        '`/memory delete <id>` — 删除记忆',
        'Agent 也会自动从对话中提取和注入相关记忆',
      );
    }

    if (config.cron.enabled) {
      helpLines.push(
        '',
        '**── 定时任务 ──**',
        '对话中要求 Agent 设置定时任务即可，支持 cron 表达式和自然语言时间',
      );
    }

    if (hasCallbackUrl()) {
      helpLines.push(
        '',
        '**── OAuth 授权 ──**',
        '`/auth` — 授权飞书个人权限（任务、日历等） 🔒',
      );
    }

    helpLines.push(
      '',
      '**── 说明 ──**',
      '🔒 = 仅管理员可用',
      '每个话题独立维护对话上下文和工作目录',
      '发送图片或 PDF 文件，Agent 可直接查看和分析',
    );

    const helpText = helpLines.join('\n');
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, helpText);
    } else {
      await feishuClient.replyText(messageId, helpText);
    }
    return true;
  }

  return false;
}

/** 历史消息中最多下载的图片数量 */
const MAX_HISTORY_IMAGES = 5;

/**
 * 从历史消息中下载图片（最多 MAX_HISTORY_IMAGES 张，使用更激进的压缩）。
 * 优先取最新的图片（消息列表已按时间正序排列，从末尾取）。
 *
 * 父群消息中的图片不自动下载，仅注入元数据提示供 LLM 按需调用工具加载，
 * 防止话题外的图片（如其他人发的简历）干扰话题内的分析。
 *
 * @param parentMsgCount 父群补充消息数量（messages 数组前 N 条来自父群）
 * @returns { images, lazyHints } images 直接嵌入多模态，lazyHints 拼入 prompt 文本
 */
async function downloadHistoryImages(
  messages: Array<{ messageId: string; imageRefs?: Array<{ imageKey: string }> }>,
  parentMsgCount = 0,
  topicRootMessageId?: string,
): Promise<{ historyImagePaths: string[]; lazyHints: string[] }> {
  // 收集所有图片引用，标记是否来自父群
  const refs: Array<{ messageId: string; imageKey: string; fromParent: boolean }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.imageRefs) {
      const fromParent = i < parentMsgCount;
      for (const ref of msg.imageRefs) {
        refs.push({ messageId: msg.messageId, imageKey: ref.imageKey, fromParent });
      }
    }
  }
  if (refs.length === 0) return { historyImagePaths: [], lazyHints: [] };

  // 父群图片：lazy loading（注入元数据，不下载）
  const lazyHints: string[] = [];
  const downloadable = refs.filter(ref => {
    if (ref.fromParent) {
      lazyHints.push(
        `[群聊历史图片] — 未自动加载。如需查看，可调用 feishu_download_message_image 工具（参数: message_id="${ref.messageId}", image_key="${ref.imageKey}"）`,
      );
      return false;
    }
    // 话题首条图片由 fetchTopicRootImages 单独处理(走多模态),这里跳过避免重复下载
    if (topicRootMessageId && ref.messageId === topicRootMessageId) {
      return false;
    }
    return true;
  });

  if (lazyHints.length > 0) {
    logger.info({ parentImageCount: lazyHints.length }, 'Parent chat images skipped (lazy loading), metadata injected');
  }

  if (downloadable.length === 0) return { historyImagePaths: [], lazyHints };

  const toDownload = downloadable.slice(-MAX_HISTORY_IMAGES);

  // 历史图片仅落盘 → 文本路径提示;不再嵌入多模态,避免污染上下文
  const results = await Promise.all(toDownload.map(async (ref) => {
    try {
      const buf = await feishuClient.downloadMessageImage(ref.messageId, ref.imageKey);
      if (buf.length > 15 * 1024 * 1024) {
        logger.warn({ messageId: ref.messageId, size: buf.length }, 'History image too large, skipping');
        return null;
      }
      const mediaType = detectImageMediaType(buf);
      try {
        const savedPath = await saveMessageFileToCache(
          ref.messageId,
          ref.imageKey,
          buf,
          `image${mediaTypeToExt(mediaType)}`,
        );
        return savedPath;
      } catch (saveErr) {
        logger.debug({ err: saveErr, messageId: ref.messageId, imageKey: ref.imageKey }, 'Failed to persist history image to cache (non-fatal)');
        return null;
      }
    } catch (err) {
      logger.warn({ err, messageId: ref.messageId, imageKey: ref.imageKey }, 'Failed to download history image, skipping');
      return null;
    }
  }));
  const historyImagePaths = results.filter((p): p is string => !!p);

  if (historyImagePaths.length > 0) {
    logger.info({ count: historyImagePaths.length, totalRefs: refs.length, parentSkipped: lazyHints.length }, 'Persisted history images (text-hint only)');
  }

  return { historyImagePaths, lazyHints };
}

/**
 * 话题首条消息的图片单独 fetch + 下载,作为多模态图片(带标签)注入。
 * 只在话题模式下调用(threadId 有值)。返回的图片自带 label='话题首条消息的图片'。
 *
 * 用 threadId 单独取根消息比依赖历史窗口更稳定 —— 历史窗口在 resume 时可能已经把根消息滑出去了,
 * 而根消息往往承载用户问题的核心图片(如"看这张图有什么问题")。
 *
 * 进程内 LRU 缓存按 threadId 缓存结果,避免每轮 resume 都重复 fetch。
 */
const topicRootImagesCache = new Map<string, { rootMessageId: string; images: ImageAttachment[]; savedPaths: string[] }>();
const TOPIC_ROOT_CACHE_MAX = 100;

async function fetchTopicRootImages(threadId: string): Promise<{
  rootMessageId?: string;
  images: ImageAttachment[];
  savedPaths: string[];
}> {
  const cached = topicRootImagesCache.get(threadId);
  if (cached) {
    // LRU: 命中后移到最近
    topicRootImagesCache.delete(threadId);
    topicRootImagesCache.set(threadId, cached);
    // '' 是哨兵 (表示"已确认无可用首条图片"),对外暴露为 undefined
    return {
      rootMessageId: cached.rootMessageId || undefined,
      images: cached.images,
      savedPaths: cached.savedPaths,
    };
  }

  // 负面缓存哨兵:任何无法定位/无图片/失败的情况都用空 entry 占位,
  // 避免每轮 resume 都重复打 Feishu API。rootMessageId 为空串表示"已确认无图"
  const cacheEmpty = (): { rootMessageId?: string; images: ImageAttachment[]; savedPaths: string[] } => {
    const empty = { rootMessageId: '', images: [] as ImageAttachment[], savedPaths: [] as string[] };
    _putTopicRootCache(threadId, empty);
    return { rootMessageId: undefined, images: [], savedPaths: [] };
  };

  try {
    const items = await feishuClient.getMessageById(threadId);
    if (!items || items.length === 0) return cacheEmpty();
    const rootMsg = items.find(m => m.message_id === threadId) ?? items[0];
    if (!rootMsg) return cacheEmpty();

    const rootMessageId = rootMsg.message_id;
    if (!rootMessageId) return cacheEmpty();
    const msgType = rootMsg.msg_type || 'text';
    const imageKeys: string[] = [];

    if (msgType === 'image') {
      try {
        const body = JSON.parse(rootMsg.body?.content ?? '{}') as Record<string, unknown>;
        const key = body.image_key;
        if (typeof key === 'string' && key.length > 0) imageKeys.push(key);
      } catch { /* ignore */ }
    } else if (msgType === 'post') {
      try {
        const body = JSON.parse(rootMsg.body?.content ?? '{}') as Record<string, unknown>;
        // 飞书 post 可能直接含 content 数组,也可能按语言 key (zh_cn/en_us/ja_jp) 嵌套
        const localized = (body.zh_cn || body.en_us || body.ja_jp) as Record<string, unknown> | undefined;
        const postBody: Record<string, unknown> | undefined = Array.isArray(body.content)
          ? body
          : (localized && typeof localized === 'object' ? localized : undefined);
        const paragraphs = postBody?.content;
        if (Array.isArray(paragraphs)) {
          for (const para of paragraphs) {
            if (!Array.isArray(para)) continue;
            for (const el of para) {
              if (el && typeof el === 'object' && (el as Record<string, unknown>).tag === 'img') {
                const key = (el as Record<string, unknown>).image_key;
                if (typeof key === 'string' && key.length > 0) imageKeys.push(key);
              }
            }
          }
        }
      } catch { /* ignore */ }
    }

    if (imageKeys.length === 0) {
      const empty = { rootMessageId, images: [] as ImageAttachment[], savedPaths: [] as string[] };
      _putTopicRootCache(threadId, empty);
      return { rootMessageId, images: [], savedPaths: [] };
    }

    // 防御:截断异常的超长 imageKeys 列表,避免 post 携带巨量 img 元素时
    // 把多模态 payload 撑爆 + 拖慢首条加载
    const cappedKeys = imageKeys.slice(0, MAX_HISTORY_IMAGES);
    if (cappedKeys.length < imageKeys.length) {
      logger.warn({ threadId, total: imageKeys.length, kept: cappedKeys.length }, 'Topic-root image count capped');
    }
    const results = await Promise.all(cappedKeys.map(async (imageKey) => {
      try {
        const buf = await feishuClient.downloadMessageImage(rootMessageId, imageKey);
        if (buf.length > MAX_IMAGE_SIZE_BYTES) {
          logger.warn({ rootMessageId, imageKey, sizeBytes: buf.length }, 'Topic-root image too large, skipping');
          return null;
        }
        const mediaType = detectImageMediaType(buf);
        const compressed = await compressImageForHistory(buf, mediaType);
        let savedPath: string | undefined;
        try {
          savedPath = await saveMessageFileToCache(
            rootMessageId,
            imageKey,
            buf,
            `image${mediaTypeToExt(mediaType)}`,
          );
        } catch (saveErr) {
          logger.debug({ err: saveErr, rootMessageId, imageKey }, 'Failed to persist topic-root image to cache (non-fatal)');
        }
        const image: ImageAttachment = {
          data: compressed.data.toString('base64'),
          mediaType: compressed.mediaType,
          label: '话题首条消息的图片',
        };
        return { image, savedPath };
      } catch (err) {
        logger.warn({ err, rootMessageId, imageKey }, 'Failed to download topic-root image');
        return null;
      }
    }));

    const ok = results.filter((r): r is { image: ImageAttachment; savedPath: string | undefined } => r !== null);
    const images = ok.map(r => r.image);
    const savedPaths = ok.map(r => r.savedPath).filter((p): p is string => !!p);

    if (images.length > 0) {
      logger.info({ threadId, rootMessageId, count: images.length }, 'Fetched topic-root images');
    }

    const result = { rootMessageId, images, savedPaths };
    _putTopicRootCache(threadId, result);
    return result;
  } catch (err) {
    logger.warn({ err, threadId }, 'Failed to fetch topic-root message');
    // 失败也缓存哨兵 - 避免 transient 错误每轮 resume 都重复 hit Feishu API
    return cacheEmpty();
  }
}

function _putTopicRootCache(
  threadId: string,
  value: { rootMessageId: string; images: ImageAttachment[]; savedPaths: string[] },
): void {
  if (topicRootImagesCache.size >= TOPIC_ROOT_CACHE_MAX) {
    const oldest = topicRootImagesCache.keys().next().value;
    if (oldest) topicRootImagesCache.delete(oldest);
  }
  topicRootImagesCache.set(threadId, value);
}

/** mediaType → 文件扩展名（与 detectImageMediaType 配对） */
function mediaTypeToExt(mediaType: ImageAttachment['mediaType']): string {
  switch (mediaType) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    default: return '.png';
  }
}

/** 支持下载并嵌入 prompt 的文本类文件扩展名 */
const TEXT_FILE_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.log', '.yaml', '.yml',
  '.csv', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.jsx', '.tsx',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.toml', '.ini', '.cfg', '.conf',
  '.sql', '.graphql', '.proto', '.lua', '.rb', '.php', '.swift',
  '.kt', '.kts', '.scala', '.r', '.m', '.mm',
  '.gitignore', '.dockerfile', '.makefile',
]);

/** 无扩展名但属于文本文件的文件名（大小写不敏感匹配） */
const EXTENSIONLESS_TEXT_FILES = /^(makefile|dockerfile|readme|license|changelog|todo)$/i;

/** 判断文件是否为文本类文件（统一入口，所有路径共用） */
function isTextFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const ext = lower.includes('.') ? '.' + lower.split('.').pop()! : '';
  return TEXT_FILE_EXTENSIONS.has(ext) || (ext === '' && EXTENSIONLESS_TEXT_FILES.test(lower));
}

/** 最多从历史消息中下载的文件数 */
const MAX_HISTORY_FILES = 3;

/**
 * 文档 payload 大小上限（base64 字节数）。
 * Anthropic API 的 message size 上限为 30MB，预留 10MB 给 system prompt + 对话历史 + 图片等。
 */
const MAX_TOTAL_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * 按 fileName 去重 + 总大小截断，防止重复文档撑爆 API 30MB 限制。
 * 优先保留靠前的文档（当前消息 > 历史消息）。
 */
export function deduplicateDocuments(docs: DocumentAttachment[]): DocumentAttachment[] {
  const seen = new Set<string>();
  const result: DocumentAttachment[] = [];
  let totalBytes = 0;
  for (const doc of docs) {
    const key = doc.fileName;
    if (seen.has(key)) {
      logger.info({ fileName: doc.fileName }, 'Skipping duplicate document');
      continue;
    }
    const docBytes = doc.data.length; // base64 string length ≈ bytes
    if (totalBytes + docBytes > MAX_TOTAL_DOCUMENT_BYTES) {
      logger.warn({ fileName: doc.fileName, totalBytes, docBytes, limit: MAX_TOTAL_DOCUMENT_BYTES }, 'Document payload size limit reached, skipping');
      continue;
    }
    seen.add(key);
    result.push(doc);
    totalBytes += docBytes;
  }
  if (result.length < docs.length) {
    logger.info({ original: docs.length, deduplicated: result.length, totalBytes }, 'Documents deduplicated');
  }
  return result;
}

/**
 * 从历史消息中下载文件附件（PDF → DocumentAttachment, 文本类 → 嵌入文本）
 *
 * @returns { documents, fileTexts } — documents 供多模态传入, fileTexts 拼入 prompt
 */
async function downloadHistoryFiles(
  messages: Array<{ messageId: string; fileRefs?: Array<{ fileKey: string; fileName: string }> }>,
  parentMsgCount = 0,
): Promise<{ documents: DocumentAttachment[]; fileTexts: string[] }> {
  const refs: Array<{ messageId: string; fileKey: string; fileName: string; fromParent: boolean }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.fileRefs) {
      const fromParent = i < parentMsgCount;
      for (const ref of msg.fileRefs) {
        refs.push({ messageId: msg.messageId, ...ref, fromParent });
      }
    }
  }
  if (refs.length === 0) return { documents: [], fileTexts: [] };

  // 按 fileKey 去重（同一文件可能在多条历史消息中出现，如话题内引用同一文件）
  const seenKeys = new Set<string>();
  const uniqueRefs = refs.filter(ref => {
    if (seenKeys.has(ref.fileKey)) return false;
    seenKeys.add(ref.fileKey);
    return true;
  });

  const toProcess = uniqueRefs.slice(-MAX_HISTORY_FILES);
  const MAX_PDF_SIZE = 30 * 1024 * 1024;
  const MAX_TEXT_SIZE = 30 * 1024 * 1024;
  const INLINE_HISTORY_TEXT_THRESHOLD = 64 * 1024;

  const documents: DocumentAttachment[] = [];
  const fileTexts: string[] = [];

  await Promise.all(toProcess.map(async (ref) => {
    // 父群消息的文件：只输出元数据，不下载实际内容（lazy loading）
    if (ref.fromParent) {
      fileTexts.push(
        `[群聊历史文件: ${ref.fileName}] — 未自动加载。如需查看，可调用 feishu_download_message_file 工具（参数: message_id="${ref.messageId}", file_key="${ref.fileKey}"）`,
      );
      logger.info({ messageId: ref.messageId, fileName: ref.fileName }, 'Parent chat file skipped (lazy loading), metadata injected');
      return;
    }

    try {
      if (ref.fileName.toLowerCase().endsWith('.pdf')) {
        const buf = await feishuClient.downloadMessageFile(ref.messageId, ref.fileKey);
        if (buf.length <= MAX_PDF_SIZE) {
          documents.push({ data: buf.toString('base64'), mediaType: 'application/pdf', fileName: ref.fileName });
          logger.info({ messageId: ref.messageId, fileName: ref.fileName, sizeBytes: buf.length }, 'History PDF downloaded');
        }
      } else if (isTextFile(ref.fileName)) {
        const buf = await feishuClient.downloadMessageFile(ref.messageId, ref.fileKey);
        if (buf.length > MAX_TEXT_SIZE) {
          logger.warn({ messageId: ref.messageId, fileName: ref.fileName, sizeBytes: buf.length }, 'History text file too large, skipping');
          return;
        }
        if (buf.length <= INLINE_HISTORY_TEXT_THRESHOLD) {
          const content = buf.toString('utf-8');
          fileTexts.push(`[历史消息中的文件: ${ref.fileName}]\n\n<file name="${ref.fileName}">\n${content}\n</file>`);
          logger.info({ messageId: ref.messageId, fileName: ref.fileName, sizeBytes: buf.length }, 'History text file embedded inline');
        } else {
          const filePath = await saveMessageFileToCache(ref.messageId, ref.fileKey, buf, ref.fileName);
          const sizeKB = (buf.length / 1024).toFixed(1);
          fileTexts.push(`[历史消息中的文件: ${ref.fileName}（${sizeKB} KB），已保存到本地: ${filePath}\n请使用 Read 工具按需读取该文件，支持 offset/limit 分段；文件保留 24 小时。]`);
          logger.info({ messageId: ref.messageId, fileName: ref.fileName, sizeBytes: buf.length, filePath }, 'History text file saved to cache for lazy read');
        }
      }
    } catch (err) {
      logger.warn({ err, messageId: ref.messageId, fileName: ref.fileName }, 'Failed to download history file, skipping');
    }
  }));

  if (documents.length > 0 || fileTexts.length > 0) {
    logger.info({ docCount: documents.length, textCount: fileTexts.length, totalRefs: refs.length, parentSkipped: toProcess.filter(r => r.fromParent).length }, 'Downloaded history files');
  }

  return { documents, fileTexts };
}

/**
 * buildHistoryContext 的可选行为参数。
 *
 * 两个公开入口（buildChatHistoryContext / buildDirectTaskHistory）共用同一份
 * fork + 去重 + 附件下载逻辑，只通过 options 区分诊断细节。
 */
interface BuildHistoryOptions {
  /** direct 任务路径打印额外的 pipeline 日志，便于排查上下文注入问题 */
  verboseLogging?: boolean;
  /** 出错时的日志 message,便于在日志里区分入口 */
  errorLabel?: string;
}

/**
 * 统一的飞书聊天历史构建实现。
 *
 * 逻辑：fork 语义 + 增量去重 + 父群懒加载附件，详见 buildChatHistoryContext / buildDirectTaskHistory 的 doc。
 */
async function buildHistoryContext(
  chatId: string,
  threadId?: string,
  currentMessageId?: string,
  afterMsgId?: string,
  selfBotOpenIds?: Set<string>,
  options: BuildHistoryOptions = {},
): Promise<HistoryResult> {
  const { verboseLogging = false, errorLabel = 'Failed to build chat history context' } = options;
  try {
    type HistoryMsg = { messageId: string; senderId: string; senderType: 'user' | 'app'; content: string; msgType: string; createTime?: string; imageRefs?: Array<{ imageKey: string }> };
    let messages: HistoryMsg[];
    let parentMsgCount = 0;

    if (!threadId) {
      messages = await feishuClient.fetchRecentMessages(chatId, 'chat', config.chat.historyMaxCount);
    } else {
      const threadMsgs = await feishuClient.fetchRecentMessages(threadId, 'thread', 50, chatId);
      const filtered = currentMessageId
        ? threadMsgs.filter(m => m.messageId !== currentMessageId)
        : threadMsgs;

      if (filtered.length === 0) {
        messages = await feishuClient.fetchRecentMessages(chatId, 'chat', config.chat.historyMaxCount);
      } else if (filtered.length <= config.chat.historyMaxCount) {
        const remaining = config.chat.historyMaxCount - filtered.length;
        if (remaining > 0) {
          const parentMsgs = await feishuClient.fetchRecentMessages(chatId, 'chat', remaining);
          parentMsgCount = parentMsgs.length;
          messages = [...parentMsgs, ...filtered];
        } else {
          messages = filtered;
        }
      } else {
        const first = filtered[0];
        const latest = filtered.slice(-(config.chat.historyMaxCount - 1));
        messages = [first, ...latest];
      }
    }

    const beforeCurrentFilter = messages.length;
    if (!threadId && currentMessageId) {
      messages = messages.filter(m => m.messageId !== currentMessageId);
    }

    const newestMsgId = messages.length > 0 ? messages[messages.length - 1].messageId : undefined;

    const beforeDedupFilter = messages.length;
    if (afterMsgId && messages.length > 0) {
      const idx = messages.findIndex(m => m.messageId === afterMsgId);
      if (idx >= 0) {
        messages = messages.slice(idx + 1);
        parentMsgCount = Math.max(0, parentMsgCount - (idx + 1));
      }
      if (verboseLogging) {
        logger.info(
          { chatId, afterMsgId, foundIdx: messages.length !== beforeDedupFilter ? 'found' : 'not_found', beforeDedup: beforeDedupFilter, afterDedup: messages.length },
          'History afterMsgId dedup applied',
        );
      }
    }

    if (verboseLogging) {
      logger.info(
        {
          chatId,
          threadId,
          currentMessageId,
          afterMsgId,
          newestMsgId,
          fetchedCount: beforeCurrentFilter,
          afterCurrentFilter: beforeDedupFilter,
          afterDedupFilter: messages.length,
          msgIds: messages.map(m => m.messageId),
          msgTypes: messages.map(m => m.msgType),
          msgContentLens: messages.map(m => m.content.length),
        },
        'buildDirectTaskHistory message pipeline',
      );
    }

    // 话题模式下先单独 fetch 话题首条消息的图片(走多模态,带标签),
    // 并把首条 messageId 传给 downloadHistoryImages 用于排重(避免重复下载/落盘)。
    const topicRoot = threadId
      ? await fetchTopicRootImages(threadId)
      : { rootMessageId: undefined as string | undefined, images: [] as ImageAttachment[], savedPaths: [] as string[] };

    const [text, imagesResult, historyFiles] = await Promise.all([
      formatHistoryMessages(messages, chatId, selfBotOpenIds, parentMsgCount > 0 ? { parentMsgCount } : undefined),
      downloadHistoryImages(messages, parentMsgCount, topicRoot.rootMessageId),
      downloadHistoryFiles(messages, parentMsgCount),
    ]);
    const fileTexts = [...historyFiles.fileTexts, ...imagesResult.lazyHints];
    const historyImagePaths = [...topicRoot.savedPaths, ...imagesResult.historyImagePaths];
    return {
      text: text ?? undefined,
      newestMsgId,
      ...(topicRoot.images.length > 0 ? { topicRootImages: topicRoot.images } : {}),
      ...(historyFiles.documents.length > 0 ? { documents: historyFiles.documents } : {}),
      ...(fileTexts.length > 0 ? { fileTexts } : {}),
      ...(historyImagePaths.length > 0 ? { historyImagePaths } : {}),
    };
  } catch (err) {
    logger.error({ err, chatId, threadId }, errorLabel);
    return {};
  }
}

/**
 * 构建飞书聊天历史上下文（首次 @bot 时注入，帮助 Claude 理解对话背景）
 *
 * @param chatId - 群聊 ID
 * @param threadId - 话题 ID（话题内消息时传入）
 * @param currentMessageId - 当前消息 ID（用于过滤，避免把自己也算进历史）
 * @param afterMsgId - 增量去重锚点：只返回比此 ID 更新的消息（resume 时使用）
 * @returns { text, newestMsgId }，无消息时 text 为 undefined
 */
async function buildChatHistoryContext(
  chatId: string,
  threadId?: string,
  currentMessageId?: string,
  afterMsgId?: string,
  selfBotOpenIds?: Set<string>,
): Promise<HistoryResult> {
  return buildHistoryContext(chatId, threadId, currentMessageId, afterMsgId, selfBotOpenIds);
}

/** 用户名缓存：open_id → 用户名（TTL 由 Map 生命周期管理，进程重启清空） */
const _userNameCache = new Map<string, string>();

/**
 * 给话题/群聊中的消息添加发送者前缀 `[姓名]: 消息`。
 * 非话题模式或用户名未知时原样返回。
 */
export async function tagSenderIdentity(
  prompt: string,
  userId: string,
  chatId: string,
  isThread: boolean,
): Promise<string> {
  if (!isThread) return prompt;
  await resolveUserNames([userId], chatId);
  const name = _userNameCache.get(userId);
  return name ? `[${name}]: ${prompt}` : prompt;
}

/** 仅测试用：操作 _userNameCache */
export function _testSetUserNameCache(userId: string, name: string): void {
  _userNameCache.set(userId, name);
}
export function _testClearUserNameCache(): void {
  _userNameCache.clear();
}

/**
 * 批量解析 open_id → 用户名（带缓存，去重后只查未命中的）
 */
async function resolveUserNames(
  openIds: string[],
  chatId?: string,
): Promise<void> {
  const unknown = [...new Set(openIds)].filter(id => id && !_userNameCache.has(id));
  if (unknown.length === 0) return;

  // 并行查询，best-effort（失败的保持 open_id 不影响流程）
  await Promise.all(unknown.map(async (id) => {
    try {
      const name = await feishuClient.getUserName(id, chatId);
      if (name) _userNameCache.set(id, name);
    } catch {
      // ignore — fallback to [用户]
    }
  }));
}

/**
 * 将飞书毫秒级时间戳格式化为可读时间字符串。
 * 同一天只显示 "HH:MM"，跨天显示 "MM-DD HH:MM"，跨年显示 "YYYY-MM-DD HH:MM"。
 * 使用 UTC+8（中国标准时间）。
 */
function formatCreateTime(createTimeMs?: string): string | undefined {
  if (!createTimeMs) return undefined;
  const ms = Number(createTimeMs);
  if (!ms || isNaN(ms)) return undefined;

  const date = new Date(ms);
  const now = new Date();

  // 转换为 UTC+8 的各分量
  const utc8Offset = 8 * 60 * 60 * 1000;
  const d = new Date(date.getTime() + utc8Offset);
  const n = new Date(now.getTime() + utc8Offset);

  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');

  // 同一天：只显示时间
  if (d.getUTCFullYear() === n.getUTCFullYear() &&
      d.getUTCMonth() === n.getUTCMonth() &&
      d.getUTCDate() === n.getUTCDate()) {
    return `[${hh}:${mm}]`;
  }

  const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');

  // 同一年：显示月-日 时间
  if (d.getUTCFullYear() === n.getUTCFullYear()) {
    return `[${mon}-${day} ${hh}:${mm}]`;
  }

  // 跨年：显示完整日期
  return `[${d.getUTCFullYear()}-${mon}-${day} ${hh}:${mm}]`;
}

/** 仅测试用：导出 formatCreateTime */
export const _testFormatCreateTime = formatCreateTime;

/** 仅测试用：导出 formatHistoryMessages */
export const _testFormatHistoryMessages = formatHistoryMessages;

/** 仅测试用：导出 downloadHistoryFiles */
export const _testDownloadHistoryFiles = downloadHistoryFiles;
export const _testDownloadHistoryImages = downloadHistoryImages;
export const _testFetchTopicRootImages = fetchTopicRootImages;
/** 仅测试用：清空话题首条图片缓存,防止用例之间相互干扰 */
export const _testClearTopicRootCache = () => topicRootImagesCache.clear();

/**
 * 格式化历史消息为上下文文本（共享逻辑）。
 *
 * 保护策略：
 * 1. 单条消息截断：用户消息 500 字符，自己的 bot 150 字符（resume 里有完整版），其他 bot 4000 字符
 * 2. 总字符数超 CHAT_HISTORY_MAX_CHARS（默认 8000）时，从最旧的消息开始丢弃
 *
 * 当前 @bot 的消息不在 history 中（调用前已过滤），rawPrompt 始终完整保留。
 *
 * @param chatId 群聊 ID（用于解析用户名的 fallback 查询）
 * @param selfBotOpenIds 所有自己管理的 bot open_id 集合（用于区分自己的回复和其他 bot 的回复）
 */
async function formatHistoryMessages(
  messages: Array<{ messageId: string; senderId: string; senderType: 'user' | 'app'; content: string; msgType: string; createTime?: string }>,
  chatId?: string,
  selfBotOpenIds?: Set<string>,
  options?: { parentMsgCount?: number },
): Promise<string | undefined> {
  if (messages.length === 0) return undefined;

  // 批量解析用户名（只查 user 类型，bot 显示 [Bot]）
  const userIds = messages.filter(m => m.senderType === 'user' && m.senderId).map(m => m.senderId);
  if (userIds.length > 0) {
    await resolveUserNames(userIds, chatId);
  }

  const USER_MSG_MAX = 500;
  // noResume agent 不 resume，历史注入是唯一的自我记忆来源，需保留较完整的自身回复；
  // resume 场景下 SDK 已有完整版，这里偏大也只是少量冗余（受 historyMaxChars 硬顶约束）
  const SELF_BOT_MSG_MAX = 1500;
  const OTHER_BOT_MSG_MAX = 4000; // 其他 bot 的回复需要较完整保留
  const parentMsgCount = options?.parentMsgCount ?? 0;
  const hasStructuredSections = parentMsgCount > 0;

  const header = hasStructuredSections
    ? '## 飞书聊天近期上下文'
    : [
        '## 飞书聊天近期上下文',
        '以下是用户 @bot 之前的聊天记录，帮助你理解当前对话的背景：',
        '',
      ].join('\n');

  // 1. 格式化每条消息，按角色差异化截断
  const lines = messages.map(m => {
    let role: string;
    let maxLen: number;
    if (m.senderType === 'app') {
      const isSelf = selfBotOpenIds && selfBotOpenIds.has(m.senderId);
      role = isSelf ? '[Bot(self)]' : '[Bot]';
      maxLen = isSelf ? SELF_BOT_MSG_MAX : OTHER_BOT_MSG_MAX;
    } else {
      const name = m.senderId ? _userNameCache.get(m.senderId) : undefined;
      role = name ? `[${name}]` : '[用户]';
      maxLen = USER_MSG_MAX;
    }
    const text = m.content.length > maxLen
      ? m.content.slice(0, maxLen) + '...'
      : m.content;
    // 时间前缀：毫秒时间戳 → "HH:MM" (UTC+8)
    const timePrefix = formatCreateTime(m.createTime);
    return timePrefix ? `${timePrefix} ${role}: ${text}` : `${role}: ${text}`;
  });

  // 2. 总量保护：如果超出预算，从最旧的消息开始丢弃（保留最近的）
  const maxChars = config.chat.historyMaxChars;
  let totalLen = header.length;
  // 从最新（末尾）向最旧（开头）累加，找到截断点
  let keepFrom = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    totalLen += lines[i].length + 1; // +1 for newline
    if (totalLen > maxChars) {
      keepFrom = i + 1;
      break;
    }
  }

  const kept = keepFrom > 0 ? lines.slice(keepFrom) : lines;
  if (kept.length === 0) return undefined;

  const parts = [header];

  if (hasStructuredSections) {
    // 结构化分区：父群背景 + 当前话题
    const adjustedSplit = Math.max(0, parentMsgCount - keepFrom);
    const parentLines = kept.slice(0, adjustedSplit);
    const threadLines = kept.slice(adjustedSplit);

    if (parentLines.length > 0) {
      parts.push('', '### 群主聊天（当前话题创建前的背景）', '');
      if (keepFrom > 0) {
        parts.push(`_(已省略 ${keepFrom} 条较早消息)_`);
      }
      parts.push(...parentLines);
    }
    if (threadLines.length > 0) {
      if (parentLines.length > 0) parts.push('', '---');
      parts.push('', '### 当前话题', '');
      parts.push(...threadLines);
    } else if (parentLines.length === 0) {
      // 全部被截断
      return undefined;
    }
  } else {
    if (keepFrom > 0) {
      parts.push(`_(已省略 ${keepFrom} 条较早消息)_`);
    }
    parts.push(...kept);
  }

  return parts.join('\n');
}

/** 历史去重缓存：sessionKey → 上次注入的最新 messageId。
 *  resume 时只注入比这个 ID 更新的消息，避免重复。
 *  进程重启时自动清空（conversationId 也丢，不会 resume）。
 *  dev agent 和 chat agent 共享（sessionKey 含 agent 维度，不冲突）。 */
const _historyDedup = new Map<string, string>();

/**
 * 获取被引用消息的内容并注入到 prompt 前缀。
 * 当用户回复某条消息并 @bot 时，确保 agent 能看到被引用消息的内容，
 * 即使它不在历史窗口内（如 merge_forward 或较早的消息）。
 * 支持 text/post/merge_forward/image 类型。
 */
async function injectQuotedMessage(
  effectivePrompt: string,
  rootId: string | undefined,
  messageId: string,
  chatId: string,
  existingImages?: ImageAttachment[],
): Promise<{ prompt: string; images?: ImageAttachment[]; savedImagePath?: string }> {
  if (!rootId || rootId === messageId) return { prompt: effectivePrompt, images: existingImages };

  try {
    const rootItems = await feishuClient.getMessageById(rootId);
    if (!rootItems || rootItems.length === 0) return { prompt: effectivePrompt, images: existingImages };

    const rootMsg = rootItems.find(m => m.message_id === rootId);
    if (!rootMsg) return { prompt: effectivePrompt, images: existingImages };

    const rootMsgType = rootMsg.msg_type || 'text';
    let rootContent = '';
    let quotedImage: ImageAttachment | undefined;
    let quotedSavedPath: string | undefined;

    if (rootMsgType === 'image') {
      // 图片消息：下载图片并追加到 images
      try {
        const content = JSON.parse(rootMsg.body?.content ?? '{}');
        const imageKey = content.image_key as string | undefined;
        if (imageKey) {
          const buf = await feishuClient.downloadMessageImage(rootId, imageKey);
          if (buf.length <= MAX_IMAGE_SIZE_BYTES) {
            const mediaType = detectImageMediaType(buf);
            const compressed = await compressImage(buf, mediaType);
            quotedImage = { data: compressed.data.toString('base64'), mediaType: compressed.mediaType, label: '用户引用的消息中的图片' };
            rootContent = '[用户引用了一张图片]';
            logger.info({ rootId, imageSize: buf.length, compressedSize: compressed.data.length }, 'Downloaded quoted image');
            // 同时落盘原图，工作区切换 restart 时通过 Read 工具兜底加载
            try {
              quotedSavedPath = await saveMessageFileToCache(
                rootId,
                imageKey,
                buf,
                `image${mediaTypeToExt(mediaType)}`,
              );
            } catch (saveErr) {
              logger.debug({ err: saveErr, rootId, imageKey }, 'Failed to persist quoted image to cache (non-fatal)');
            }
          } else {
            rootContent = '[用户引用了一张图片，但图片过大无法加载]';
          }
        }
      } catch (err) {
        logger.warn({ err, rootId }, 'Failed to download quoted image');
        rootContent = '[用户引用了一张图片，但下载失败]';
      }
    } else if (rootMsgType === 'merge_forward') {
      const subMessages = rootItems
        .filter(sub => sub.upper_message_id && sub.message_id !== rootId)
        .sort((a, b) => parseInt(a.create_time || '0', 10) - parseInt(b.create_time || '0', 10))
        .slice(0, 20);
      if (subMessages.length > 0) {
        const senderIds = [...new Set(subMessages.map(s => s.sender?.id).filter(Boolean))] as string[];
        const senderNameMap = new Map<string, string>();
        await Promise.all(senderIds.map(async (sid) => {
          try {
            const name = await feishuClient.getUserName(sid, chatId);
            if (name) senderNameMap.set(sid, name);
          } catch { /* skip */ }
        }));
        const lines = ['[合并转发的聊天记录]'];
        for (const sub of subMessages) {
          const subContent = formatMergeForwardSubMessage(sub.body?.content ?? '{}', sub.msg_type || 'text', sub.mentions);
          if (subContent.trim()) {
            const senderId = sub.sender?.id ?? '';
            const senderName = senderNameMap.get(senderId) ?? '未知用户';
            lines.push(`- [${senderName}](${senderId || '?'}): ${subContent.trim()}`);
          }
        }
        rootContent = lines.join('\n');
      } else {
        rootContent = '[合并转发的聊天记录]';
      }
    } else if (rootMsgType === 'text' || rootMsgType === 'post') {
      rootContent = formatMergeForwardSubMessage(rootMsg.body?.content ?? '{}', rootMsgType, rootMsg.mentions);
    }

    if (rootContent.trim()) {
      logger.info({ rootId, rootMsgType, rootContentLen: rootContent.length, hasImage: !!quotedImage }, 'Injected rootId quoted message content into prompt');
      const newPrompt = `<quoted-message>\n${rootContent}\n</quoted-message>\n\n${effectivePrompt}`;
      const mergedImages = quotedImage
        ? [...(existingImages || []), quotedImage]
        : existingImages;
      return { prompt: newPrompt, images: mergedImages, savedImagePath: quotedSavedPath };
    }
  } catch (err) {
    logger.warn({ err, rootId }, 'Failed to fetch rootId message for injection');
  }

  return { prompt: effectivePrompt, images: existingImages };
}

/**
 * 构建 bot 身份上下文（注入到 user prompt prefix）
 *
 * 多 bot 群聊场景下，告诉 agent：
 * 1. 自己在飞书群中的显示名称（避免 @ 自己）
 * 2. 群内其他 bot 的名称（可通过 @名称 与其交互）
 * 3. 与其他 bot 交互的正确方式（在回复中 @，而非 send_to_chat）
 */
export function buildBotIdentityContext(chatId: string, agentId?: string): string | undefined {
  if (!isMultiBotMode()) {
    // 单 bot 模式：从飞书 API 获取的 botName + agent displayName 构建身份
    const botName = feishuClient.botName;
    const agentCfg = agentId ? agentRegistry.get(agentId) : undefined;
    const displayName = agentCfg?.displayName;
    // 至少有一个名字才注入
    const name = displayName || botName;
    if (!name) return undefined;
    const lines = [`## 你的身份`];
    if (displayName && botName && displayName !== botName) {
      lines.push(`你的名字是"${displayName}"，在飞书中显示为"${botName}"。`);
    } else {
      lines.push(`你的名字是"${name}"。`);
    }
    return lines.join('\n');
  }

  const accountId = feishuClientContext.getStore();
  if (!accountId) return undefined;

  const selfAccount = accountManager.getAccount(accountId);
  if (!selfAccount) return undefined;

  const selfName = selfAccount.botName;
  const selfOpenId = selfAccount.botOpenId;

  // 从 chatBotRegistry 获取群内其他 bot（排除自己和同一系统下的其他 bot 账号）
  const _allManagedOpenIds = accountManager.getAllBotOpenIds();
  const registryBots = chatBotRegistry.getBots(chatId);
  const otherBots = registryBots.filter(b => {
    if (!b.name) return false;
    // 排除自己
    if (selfOpenId && b.openId === selfOpenId) return false;
    // 排除同系统管理的其他 bot（它们的 open_id 在 allManagedOpenIds 中，
    // 但 registry 中的 open_id 是跨 app 的，不一定在集合中）
    // 保留：registry 中的 bot 都是跨 app 视角发现的，都是"其他 bot"
    return true;
  });

  // 同系统管理的其他 bot 也加入列表（从 accountManager 获取）
  const managedOtherBots: { name: string }[] = [];
  for (const account of accountManager.allAccounts()) {
    if (account.accountId === accountId) continue; // 排除自己
    if (account.botName && account.botName !== 'default') {
      // 检查 registry 中是否已有同名 bot，避免重复
      if (!otherBots.some(b => b.name === account.botName)) {
        managedOtherBots.push({ name: account.botName });
      }
    }
  }

  const allOtherBots = [
    ...otherBots.map(b => b.name!),
    ...managedOtherBots.map(b => b.name),
  ];

  const lines: string[] = [
    `## 你的身份`,
    `你在飞书群中的名称是"${selfName}"。`,
  ];

  if (allOtherBots.length > 0) {
    lines.push('');
    lines.push('## 群内其他机器人');
    for (const name of allOtherBots) {
      lines.push(`- ${name}`);
    }
    lines.push('');
    lines.push('如果需要与其他机器人交流，在你的回复文本中使用 @机器人名 即可（如 @' + allOtherBots[0] + '）。');
    lines.push('不要使用 feishu_send_to_chat 工具来联系其他机器人——该工具仅用于向群主聊天发送重要通知。');
  }

  return lines.join('\n');
}

/**
 * 判断是否可以 resume 上一轮 SDK session。
 *
 * 三种情况不能 resume（改为全新会话 + 注入最近 N 条历史）：
 * - 无 activeConversationId：本会话还没有可续的 SDK session
 * - cwd 变更：workspace 切换后 Agent SDK 不支持跨 cwd resume（会 exit 1）
 * - agent 配置 noResume：强制每条消息全新会话，避免长会话逐轮累积把上下文
 *   推到数十万 token、成本失控
 *
 * 抽成纯函数便于单测。afterMsgId 增量去重也以此为准：只有真正 resume 时
 * SDK 端才存有前序 turn，此时才做"只注入新消息"的增量；否则注入完整最近 N 条。
 */
export function canResumeSession(params: {
  activeConversationId?: string;
  activeConversationCwd?: string;
  workingDir: string;
  noResume?: boolean;
}): boolean {
  const { activeConversationId, activeConversationCwd, workingDir, noResume } = params;
  if (!activeConversationId) return false;
  if (activeConversationCwd && activeConversationCwd !== workingDir) return false;
  if (noResume) return false;
  return true;
}

/**
 * 执行 Claude Agent SDK 任务
 * 支持 workspace 变更后自动 restart：第一次 query 触发 setup_workspace 后，
 * 自动以新 cwd 发起第二次 query，确保 CLAUDE.md 正确加载。
 *
 * Resume 策略：优先使用 thread_sessions 表（threadId → conversationId 映射），
 * 每个 thread 独立管理自己的 conversationId，互不干扰。
 */
export async function executeClaudeTask(
  rawPrompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
  eventThreadId?: string,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[],
  agentId: AgentId = 'dev',
  createTime?: string,
  messageType?: string,
  currentImagePaths?: string[],
): Promise<void> {
  // 1. 解析话题上下文（thread + workingDir + greeting）
  const resolved = await resolveThreadContext({
    prompt: rawPrompt,
    chatId,
    userId,
    messageId,
    rootId,
    threadId: eventThreadId,
    agentId,
  });

  if (resolved.status !== 'resolved') return;

  const { threadReplyMsgId, greetingMsgId, workingDir, threadId, threadSession, prompt } = resolved.ctx;
  const session = sessionManager.getOrCreate(chatId, userId, agentId);

  // 如果本次处理新建了话题（eventThreadId 为空但 threadId 已存在），
  // 锁定 per-thread queueKey 防止后续消息（携带 threadId、使用不同 queueKey）并发执行。
  // 场景：perMessageParallel 模式下第一条消息创建话题后，workspace 切换+restart 期间
  // 第二条消息不应并发读取到旧的 workingDir。
  let lockedThreadQueueKey: string | undefined;
  if (!eventThreadId && threadId) {
    lockedThreadQueueKey = makeQueueKey(chatId, threadId, agentId);
    taskQueue.markBusy(lockedThreadQueueKey);
  }

  // sessionKey 包含 threadId，per-thread 并行时各 query 有独立的 key
  const sessionKey = threadId ? `${chatId}:${userId}:${threadId}` : `${chatId}:${userId}`;

  // 发送初始进度卡片（即时反馈），后续原地更新为 tool call 进度卡片
  // 新话题首条消息时 ensureThread 已创建了一张问候卡片（greetingMsgId），
  // 直接复用避免残留空卡片（之前的 bug：第二张卡片更新，第一张永远停在"正在处理…"）
  let progressCardFailed = false;
  const progressCardMsgId = await initProgressCardMsgId(
    greetingMsgId,
    threadReplyMsgId,
    async (anchorMsgId) => (await feishuClient.replyCardInThread(
      anchorMsgId, buildCombinedProgressCard('', [], 0),
    )) ?? undefined,
  );
  if (threadReplyMsgId && !progressCardMsgId) {
    progressCardFailed = true;
  } else if (!threadReplyMsgId && !greetingMsgId) {
    await feishuClient.replyText(messageId, '🤖 处理中...');
  }

  // 标记会话为忙碌
  sessionManager.setStatus(chatId, userId, 'busy', agentId);

  // 提前计算 resume 状态，用于判断是否需要注入聊天历史
  const activeConversationId = threadId
    ? threadSession?.conversationId
    : session.conversationId;
  const activeConversationCwd = threadId
    ? threadSession?.conversationCwd
    : session.conversationCwd;
  const agentCfg = agentRegistry.get(agentId);
  // resume 开关：无会话 / cwd 变更 / agent noResume → 全新会话（注入最近 N 条历史）
  const canResume = canResumeSession({
    activeConversationId,
    activeConversationCwd,
    workingDir,
    noResume: agentCfg?.noResume,
  });

  // 构建历史上下文
  // Pipeline context → system prompt (historySummaries)，聊天历史 → user prompt 前缀
  let historySummaries: string | undefined;
  if (threadSession?.pipelineContext) {
    const ctx = threadSession.pipelineContext;
    const parts = [
      `## 本话题的 /dev Pipeline 上下文`,
      `**原始需求**: ${ctx.prompt}`,
      `**工作目录**: ${ctx.workingDir}`,
      `**执行摘要**:\n${ctx.summary}`,
    ];
    let combined = parts.join('\n\n');
    if (combined.length > 30000) {
      combined = combined.slice(0, 30000) + '\n\n[摘要已截断]';
    }
    historySummaries = combined;
  }

  // 群聊话题中标注发送者身份，与历史消息的 [姓名] 格式保持一致
  const senderTaggedPrompt = await tagSenderIdentity(prompt, userId, chatId, !!threadId);

  // 在用户消息末尾附带发送时间元数据（不放 system prompt，避免 cache miss）
  const msgTimeSuffix = formatCreateTime(createTime);
  const promptWithTime = msgTimeSuffix
    ? `${senderTaggedPrompt}\n\n<msg-time>${msgTimeSuffix}</msg-time>`
    : senderTaggedPrompt;

  // 每次都注入增量飞书聊天历史，拼入 user prompt（不是 system prompt）
  // resume 时通过 afterMsgId 去重，只注入上次交互后新增的消息
  // 确保 dev-bot 能看到中间 @其他bot 的对话等未直接参与的消息
  let effectivePrompt = promptWithTime;
  // workspace 切换 restart 时多模态 images 不会重传，需用落盘路径作为文本 fallback
  // 包含当前消息内图片 + 历史消息内图片，restart 时拼成提示注入新 prompt
  const restartImagePaths: string[] = [...(currentImagePaths ?? [])];
  if (!historySummaries) {
    // 收集所有自己管理的 bot open_id，用于历史消息差异化截断
    const selfBotOpenIds = accountManager.getAllBotOpenIds();
    if (feishuClient.botOpenId) selfBotOpenIds.add(feishuClient.botOpenId);

    // 仅在真正 resume 时做增量去重；不 resume（含 noResume/cwd 变更）时注入完整最近 N 条
    const afterMsgId = canResume ? _historyDedup.get(sessionKey) : undefined;
    const history = await buildChatHistoryContext(chatId, threadId, messageId, afterMsgId, selfBotOpenIds);
    if (history.historyImagePaths?.length) {
      restartImagePaths.push(...history.historyImagePaths);
    }
    if (history.text) {
      effectivePrompt = history.text + '\n\n---\n\n' + promptWithTime;
    }
    if (history.newestMsgId) {
      _historyDedup.set(sessionKey, history.newestMsgId);
    }
    // Resume 时跳过历史文件附件：SDK 会重放所有前序 turn，文件已在对话中，
    // 重复附加会导致 payload 累积膨胀（N turns × PDF size → 超 30MB 限制）。
    // 不 resume（含 noResume/cwd 变更）时 SDK 端无对话记忆，须正常合并历史文件。
    if (canResume) {
      if (history.topicRootImages?.length || history.documents?.length) {
        logger.info(
          { topicRootImages: history.topicRootImages?.length ?? 0, historyDocs: history.documents?.length ?? 0 },
          'Skipping history file attachments on resume — already in conversation',
        );
      }
      // 当前消息非文件上传时，documents 来自引用父消息，resume 时同样已在对话中
      if (documents?.length && messageType !== 'file') {
        logger.info(
          { docCount: documents.length, fileNames: documents.map(d => d.fileName) },
          'Clearing quoted-parent documents on resume — already sent in previous turn',
        );
        documents = undefined;
      }
    } else {
      // 非 resume：正常合并历史文件
      // 当前消息图片打标签(用户主动发的图片)
      if (images?.length) {
        images = images.map(img => ({ ...img, label: img.label ?? '用户当前消息的图片' }));
      }
      // 话题首条图片(自带 label)合并进多模态
      if (history.topicRootImages && history.topicRootImages.length > 0) {
        images = [...(images ?? []), ...history.topicRootImages];
      }
      // 纯历史图片转成文本提示,前置到 effectivePrompt(避免污染多模态)
      if (history.historyImagePaths && history.historyImagePaths.length > 0) {
        const hint = formatHistoryImageHints(history.historyImagePaths);
        if (hint) {
          effectivePrompt = hint + '\n\n---\n\n' + effectivePrompt;
        }
      }
      // 合并历史消息中的文档（PDF），按 fileName 去重 + 大小截断
      if (history.documents && history.documents.length > 0) {
        // 当前消息的文档优先（放前面），历史文档补充
        documents = deduplicateDocuments([...(documents ?? []), ...(history.documents)]);
      }
    }
    // 合并历史消息中的文本文件内容到 prompt（文本内容不占多模态空间，始终注入）
    if (history.fileTexts && history.fileTexts.length > 0) {
      effectivePrompt = history.fileTexts.join('\n\n') + '\n\n---\n\n' + effectivePrompt;
    }
  }

  // rootId 引用消息注入（仅主面板引用回复，话题内 rootId 是锚定消息不需要注入）
  if (!threadId) {
    const quoted = await injectQuotedMessage(effectivePrompt, rootId, messageId, chatId, images);
    effectivePrompt = quoted.prompt;
    images = quoted.images;
    // 引用图片同样纳入工作区切换后落盘路径，避免 restart 丢失
    if (quoted.savedImagePath) {
      restartImagePaths.push(quoted.savedImagePath);
    }
  }

  // 构造逐条 turn 回调
  // 策略：缓冲最后一个 turn，收到新 turn 时将前一个 turn 的 tool calls 和文本刷入累积器，
  // 原地更新合并进度卡片（文本 + 工具调用折叠面板）。结束时最后一个 turn 合并进结果卡片。
  let turnCount = 0;
  let pendingTurn: TurnInfo | undefined;
  const accumulatedToolCalls: ToolCallInfo[] = [];
  let accumulatedText = '';

  /** 将文本追加到累积文本 */
  const appendText = (text: string) => {
    accumulatedText += (accumulatedText ? '\n\n' : '') + text;
  };

  // 工作区信息写入合并卡片文本区域（不再单独发工作区卡片）
  {
    const { basename: bn } = await import('node:path');
    const repoName = parseRepoNameFromWorkspaceDir(bn(workingDir));
    let wsBranch: string | undefined;
    try {
      const { execFileSync } = await import('node:child_process');
      wsBranch = execFileSync('git', ['-C', workingDir, 'branch', '--show-current'],
        { encoding: 'utf-8', timeout: 3000 }).trim() || undefined;
    } catch { /* best-effort */ }
    appendText(`📂 ${repoName}${wsBranch ? ' · ' + wsBranch : ''}`);
    if (progressCardMsgId && !progressCardFailed) {
      feishuClient.updateCard(
        progressCardMsgId,
        buildCombinedProgressCard(accumulatedText, accumulatedToolCalls, turnCount),
      ).catch(() => {});
    }
  }

  const onTurn = async (turn: TurnInfo) => {
    turnCount = turn.turnIndex;
    // 将前一个 turn 的 tool calls 和文本刷入累积器，原地更新合并卡片
    if (pendingTurn) {
      accumulatedToolCalls.push(...pendingTurn.toolCalls);
      if (pendingTurn.textContent) appendText(pendingTurn.textContent);
      if (progressCardMsgId && !progressCardFailed) {
        try {
          await feishuClient.updateCard(
            progressCardMsgId,
            buildCombinedProgressCard(accumulatedText, accumulatedToolCalls, turnCount),
          );
        } catch (err) {
          logger.warn({ err }, 'Failed to update progress card');
          progressCardFailed = true;
        }
      }
    }
    // 缓冲当前 turn
    pendingTurn = turn;
  };

  // workspace 变更回调: MCP 工具 clone 后自动更新 session.workingDir
  const onWorkspaceChanged = (newDir: string) => {
    sessionManager.setWorkingDir(chatId, userId, newDir, agentId);
    logger.info({ chatId, userId, newDir }, 'Workspace changed via MCP tool');
  };

  const onProgress = (message: import('@anthropic-ai/claude-agent-sdk').SDKMessage) => {
    logger.debug({ messageType: message.type }, 'Claude SDK message');
  };

  try {
    // Resume 策略：canResume/activeConversationId/activeConversationCwd 已在上方提前计算
    const activePromptHash = threadId ? threadSession?.systemPromptHash : session.systemPromptHash;
    if (activeConversationId && !canResume) {
      logger.info(
        { sessionKey, threadId, sessionId: activeConversationId, sessionCwd: activeConversationCwd, currentCwd: workingDir, noResume: agentCfg?.noResume },
        'Skipping resume: cwd mismatch (workspace switched) or agent noResume, starting fresh session',
      );
    }
    // NOTE: 图片消息（AsyncIterable prompt）也支持 resume，SDK 的 resume 是 CLI 参数与 prompt 投递方式正交

    // readOnly: agent 配置优先，如果 agent 是 readonly 则强制只读；
    // 否则回退到 owner 检查（dev agent 中非 owner 也是只读）；agentCfg 已在上方提前取得
    const readOnly = agentCfg?.readOnly ?? !isOwner(userId);
    // /fable 强制模型：thread 级优先，其次 chat 级 session，都没有则用 agent 配置模型
    const forcedModel = resolveForcedModel(threadSession?.forcedModel, session.forcedModel);
    // 自定义 agent 支持 persona（dev agent 没配置时 → undefined → 使用默认 buildWorkspaceSystemPrompt）
    const customSystemPrompt = readPersonaFile(agentId);
    const knowledgeContent = loadKnowledgeContent(agentId);

    // 记忆注入：搜索相关记忆，格式化为 system prompt 片段
    // 使用 repo identity（而非带随机后缀的工作区路径）确保同仓库记忆互通
    const repoIdentity = getRepoIdentity(workingDir);
    const memoryContext = config.memory.enabled
      ? await injectMemories(rawPrompt, { agentId, userId, workspaceDir: repoIdentity, chatId, repository: resolveRepositoryForCwd(workingDir) })
      : '';

    // Bot 身份上下文（多 bot 模式下告诉 agent 自己是谁、群内有哪些其他 bot）
    const botIdentityContext = buildBotIdentityContext(chatId, agentId);

    // AskUserQuestion 回调：将 Claude 的提问渲染为飞书交互卡片
    const onAskUser = createAskUserHandler(chatId, () => threadReplyMsgId);

    const result = await claudeExecutor.execute({
      sessionKey,
      prompt: effectivePrompt,
      workingDir,
      readOnly,
      model: forcedModel ?? agentCfg?.model,
      maxTurns: agentCfg?.maxTurns,
      ...(agentCfg ? { maxBudgetUsd: agentCfg.maxBudgetUsd } : {}),
      settingSources: agentCfg?.settingSources,
      toolAllow: agentCfg?.toolAllow,
      toolDeny: agentCfg?.toolDeny,
      bashAllowPatterns: agentCfg?.bashAllowPatterns,
      editablePathPatterns: agentCfg?.editablePathPatterns,
      resumeSessionId: canResume ? activeConversationId : undefined,
      storedSystemPromptHash: activePromptHash,
      botIdentityContext,
      onProgress,
      onWorkspaceChanged,
      onTurn,
      onAskUser,
      historySummaries,
      memoryContext,
      images,
      documents,
      knowledgeContent,
      disableWorkspaceTool: false,
      inplaceEdit: threadSession?.inplaceEdit,
      agentId,
      threadId,
      threadRootMessageId: threadReplyMsgId,
      ...(customSystemPrompt ? { systemPromptOverride: customSystemPrompt } : {}),
    });

    // 检测是否需要 restart（workspace 变更后重新执行以加载 CLAUDE.md）
    // 优先级高于 resume 失败检查：即使 query 失败，只要 workspace 已变更就应重启
    if (result.needsRestart && result.newWorkingDir) {
      logger.info(
        { chatId, userId, newWorkingDir: result.newWorkingDir },
        'Workspace changed, restarting query with new cwd',
      );

      // 检查 session 是否已被用户 /stop 中断
      const currentSession = sessionManager.get(chatId, userId, agentId);
      if (!currentSession || currentSession.status !== 'busy') {
        logger.info({ chatId, userId }, 'Restart cancelled: session no longer busy');
        return;
      }

      // 验证新工作目录确实存在
      const { existsSync: dirExists } = await import('node:fs');
      if (!dirExists(result.newWorkingDir)) {
        logger.error({ newWorkingDir: result.newWorkingDir }, 'Restart cancelled: newWorkingDir does not exist');
        if (progressCardMsgId) {
          const allToolCalls = pendingTurn
            ? [...accumulatedToolCalls, ...pendingTurn.toolCalls]
            : accumulatedToolCalls;
          if (pendingTurn?.textContent) appendText(pendingTurn.textContent);
          await feishuClient.updateCard(
            progressCardMsgId,
            buildCombinedProgressCard(accumulatedText, allToolCalls, turnCount, true, undefined, {
              success: false,
              durationStr: formatDuration(result.durationMs),
              error: '工作区准备失败，目录不存在',
            }),
          );
        } else {
          await sendResultCard(
            { ...result, success: false, output: '', error: '工作区准备失败，目录不存在' },
            result.durationMs, result.costUsd,
            threadReplyMsgId, chatId,
          );
        }
        return;
      }

      // workspace 已变更：更新 thread session 的 workingDir，清空 conversationId
      // （cwd 变更后无法 resume 旧 session —— Agent SDK 不允许跨 cwd resume）
      if (threadId) {
        sessionManager.setThreadWorkingDir(threadId, result.newWorkingDir, agentId);
      }
      sessionManager.setConversationId(chatId, userId, '', undefined, agentId);

      // 工作区切换信息写入合并卡片文本区域
      {
        const { basename } = await import('node:path');
        const repoName = parseRepoNameFromWorkspaceDir(basename(result.newWorkingDir));
        let branch: string | undefined;
        try {
          const { execFileSync } = await import('node:child_process');
          branch = execFileSync('git', ['-C', result.newWorkingDir, 'branch', '--show-current'], { encoding: 'utf-8', timeout: 3000 }).trim() || undefined;
        } catch { /* best-effort */ }
        appendText(`📂 ${repoName}${branch ? ' · ' + branch : ''}`);
        if (progressCardMsgId && !progressCardFailed) {
          feishuClient.updateCard(
            progressCardMsgId,
            buildCombinedProgressCard(accumulatedText, accumulatedToolCalls, turnCount),
          ).catch(() => {});
        }
      }

      // ─── Restart 前重建完整 chat history ──────────────────────────────
      // S2 跨 cwd 启动，无法 resume S1 的 SDK session，SDK 端无任何对话记忆。
      // 若 S1 流程因 activeConversationId 命中走了 dedup（_historyDedup），
      // effectivePrompt 只含本轮增量消息 —— 直接拿去启动 S2 会丢失所有 thread
      // 历史 turn，导致 bot 失忆。这里无视 dedup，重新拉一次完整 thread 历史。
      let restartEffectivePrompt = effectivePrompt;
      if (activeConversationId) {
        const selfBotOpenIdsForRestart = accountManager.getAllBotOpenIds();
        if (feishuClient.botOpenId) selfBotOpenIdsForRestart.add(feishuClient.botOpenId);
        const fullHistory = await buildChatHistoryContext(
          chatId, threadId, messageId, undefined, selfBotOpenIdsForRestart,
        );
        const assembled = assembleRestartPromptFromFullHistory(
          promptWithTime, fullHistory, restartImagePaths,
        );
        restartEffectivePrompt = assembled.prompt;
        restartImagePaths.length = 0;
        restartImagePaths.push(...assembled.imagePaths);
        // 主面板模式需重新注入 rootId 引用消息（话题模式不需要，与 line 2515 处一致）
        if (!threadId) {
          const quoted = await injectQuotedMessage(restartEffectivePrompt, rootId, messageId, chatId, undefined);
          restartEffectivePrompt = quoted.prompt;
          if (quoted.savedImagePath && !restartImagePaths.includes(quoted.savedImagePath)) {
            restartImagePaths.push(quoted.savedImagePath);
          }
        }
        // dedup 锚点推进到完整历史最新一条，避免 S2 之后再拉重复内容
        if (fullHistory.newestMsgId) {
          _historyDedup.set(sessionKey, fullHistory.newestMsgId);
        }
        logger.info(
          {
            sessionKey,
            originalPromptLen: effectivePrompt.length,
            restartPromptLen: restartEffectivePrompt.length,
            historyImageCount: fullHistory.historyImagePaths?.length ?? 0,
          },
          'Rebuilt full chat history for restart query',
        );
      }

      // 第二次 query：以新 cwd 执行，CLAUDE.md 正确加载
      // - 不传 resumeSessionId（Agent SDK 不支持跨 cwd resume，会 exit code 1）
      // - 不传 onWorkspaceChanged（不触发二次 restart）
      // - disableWorkspaceTool: 完全移除 setup_workspace MCP tool，防止无限循环
      // - 使用 restartEffectivePrompt（含完整聊天历史），避免 restart 后丢失对话上下文
      // - restart 不重传多模态 images：将 S1 落盘的图片路径作为文本附加，让 agent 用 Read 工具按需查看
      const restartImageHints = formatRestartImageHints(restartImagePaths);
      const restartPromptWithImageHints = restartImageHints
        ? `${restartImageHints}\n\n---\n\n${restartEffectivePrompt}`
        : restartEffectivePrompt;
      const restartResult = await claudeExecutor.execute({
        sessionKey,
        prompt: restartPromptWithImageHints,
        workingDir: result.newWorkingDir,
        readOnly,
        model: forcedModel ?? agentCfg?.model,
        maxTurns: agentCfg?.maxTurns,
        ...(agentCfg ? { maxBudgetUsd: agentCfg.maxBudgetUsd } : {}),
        settingSources: agentCfg?.settingSources,
        toolAllow: agentCfg?.toolAllow,
        toolDeny: agentCfg?.toolDeny,
        editablePathPatterns: agentCfg?.editablePathPatterns,
        onProgress,
        onTurn,
        historySummaries,
        knowledgeContent,
        memoryContext,
        disableWorkspaceTool: true,
        isRestart: true,
        priorContext: formatConversationTrace(result.conversationTrace),
        agentId,
        threadId,
        threadRootMessageId: threadReplyMsgId,
        ...(customSystemPrompt ? { systemPromptOverride: customSystemPrompt } : {}),
      });

      // 保存 restart query 的 session_id 到 thread session
      // 仅保存 restart 自身的 sessionId，不 fallback 到 S1 的 sessionId
      // （S1 的 session 是在旧 cwd 创建的，跨 cwd resume 会 exit code 1）
      if (restartResult.sessionId) {
        if (threadId) {
          sessionManager.setThreadConversationId(threadId, restartResult.sessionId, result.newWorkingDir, agentId, restartResult.systemPromptHash);
        }
        sessionManager.setConversationId(chatId, userId, restartResult.sessionId, result.newWorkingDir, agentId, restartResult.systemPromptHash);
      } else {
        logger.warn(
          { chatId, userId, threadId },
          'Restart query produced no sessionId — next message will start fresh',
        );
      }

      // 合并两次 query 的耗时和花费
      const totalDurationMs = result.durationMs + restartResult.durationMs;
      const totalCostUsd = (result.costUsd ?? 0) + (restartResult.costUsd ?? 0);

      // 合并卡片切换为完成态（含最后一轮的全部内容）
      if (progressCardMsgId) {
        const allToolCalls = pendingTurn
          ? [...accumulatedToolCalls, ...pendingTurn.toolCalls]
          : accumulatedToolCalls;
        if (pendingTurn?.textContent) appendText(pendingTurn.textContent);
        const costInfo = totalCostUsd ? ` | 💰 $${totalCostUsd.toFixed(4)}` : '';
        await feishuClient.updateCard(
          progressCardMsgId,
          buildCombinedProgressCard(accumulatedText, allToolCalls, turnCount, true, undefined, {
            success: restartResult.success,
            durationStr: formatDuration(totalDurationMs) + costInfo,
            error: restartResult.error,
          }),
        );
      } else {
        await sendResultCard(
          restartResult, totalDurationMs, totalCostUsd,
          threadReplyMsgId, chatId, undefined, turnCount,
        );
      }

      // 记忆抽取 (fire-and-forget, restart 路径)
      if (config.memory.enabled && restartResult.success && restartResult.output) {
        extractMemories(prompt, restartResult.output, {
          agentId, userId, chatId, workspaceDir: getRepoIdentity(result.newWorkingDir!), messageId,
          userName: _userNameCache.get(userId),
          repository: resolveRepositoryForCwd(result.newWorkingDir!),
        }).catch((err) => logger.warn({ err }, 'Memory extraction failed'));
      }
      return;
    }

    // Resume 失败（非 workspace 变更场景）：报错给用户，保留 session ID 不动
    // 用 !result.output 区分 resume 失败和正常 query 失败：
    //   - resume 失败：子进程秒退，无 output
    //   - 正常失败（超时、预算等）：有 output，应走 sendResultCard 展示部分结果
    // 图片消息强制跳过 resume，不触发此检查
    const actuallyResumed = canResume && !images?.length;
    if (!result.success && actuallyResumed && !result.output) {
      logger.error(
        { sessionKey, threadId, error: result.error, sessionId: activeConversationId, durationMs: result.durationMs },
        'Resume failed — session ID preserved for user to decide',
      );

      const errorDetail = [
        '⚠️ 会话恢复失败',
        '',
        `**Session ID**: \`${activeConversationId}\``,
        `**工作目录**: \`${workingDir}\``,
        `**错误**: ${result.error || '未知错误'}`,
        `**耗时**: ${formatDuration(result.durationMs)}`,
        '',
        '再次发送消息会继续尝试恢复。如需放弃旧会话重新开始，请发送 `/reset`。',
      ].join('\n');

      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, errorDetail);
      } else {
        await feishuClient.replyText(messageId, errorDetail);
      }
      return;
    }

    // 无 restart，正常流程：保存 session ID 用于下次 resume
    // 即使失败也保存——下次 resume 可能成功（如超时但 session 数据完整）
    if (result.sessionId) {
      if (threadId) {
        sessionManager.setThreadConversationId(threadId, result.sessionId, workingDir, agentId, result.systemPromptHash);
      }
      sessionManager.setConversationId(chatId, userId, result.sessionId, workingDir, agentId, result.systemPromptHash);
    }

    // 合并卡片切换为完成态（含最后一轮的全部内容）
    if (progressCardMsgId) {
      const allToolCalls = pendingTurn
        ? [...accumulatedToolCalls, ...pendingTurn.toolCalls]
        : accumulatedToolCalls;
      if (pendingTurn?.textContent) appendText(pendingTurn.textContent);
      const costInfo = result.costUsd ? ` | 💰 $${result.costUsd.toFixed(4)}` : '';
      await feishuClient.updateCard(
        progressCardMsgId,
        buildCombinedProgressCard(accumulatedText, allToolCalls, turnCount, true, undefined, {
          success: result.success,
          durationStr: formatDuration(result.durationMs) + costInfo,
          error: result.error,
        }),
      );
    } else {
      await sendResultCard(
        result, result.durationMs, result.costUsd,
        threadReplyMsgId, chatId, undefined, turnCount,
      );
    }

    // 记忆抽取 (fire-and-forget)
    if (config.memory.enabled && result.success && result.output) {
      extractMemories(rawPrompt, result.output, {
        agentId, userId, chatId, workspaceDir: repoIdentity, messageId,
        userName: _userNameCache.get(userId),
        repository: resolveRepositoryForCwd(workingDir),
      }).catch((err) => logger.warn({ err }, 'Memory extraction failed'));
    }

  } catch (err) {
    logger.error({ err }, 'Error executing Claude Agent SDK query');
    // 合并卡片切换为失败态（best-effort，含 pendingTurn 内容）
    if (progressCardMsgId) {
      const allToolCalls = pendingTurn
        ? [...accumulatedToolCalls, ...pendingTurn.toolCalls]
        : accumulatedToolCalls;
      if (pendingTurn?.textContent) appendText(pendingTurn.textContent);
      await feishuClient.updateCard(
        progressCardMsgId,
        buildCombinedProgressCard(accumulatedText, allToolCalls, turnCount, true, undefined, {
          success: false,
          durationStr: '—',
          error: (err as Error).message,
        }),
      ).catch(() => {});
    } else {
      const errorReply = `❌ 执行出错: ${(err as Error).message}`;
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, errorReply);
      } else {
        await feishuClient.replyText(messageId, errorReply);
      }
    }
  } finally {
    try {
      sessionManager.setStatus(chatId, userId, 'idle', agentId);
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to reset session status');
    }
    // 释放 per-thread queueKey 锁，处理等待中的消息
    if (lockedThreadQueueKey) {
      taskQueue.complete(lockedThreadQueueKey);
      processQueue(lockedThreadQueueKey, agentId);
    }
  }
}

// ============================================================
// Direct 模式执行（Chat Agent 默认模式）
//
// 不创建话题，不发进度卡片。
// Agent 可通过 start_discussion_thread 工具升级为话题模式。
// ============================================================

/**
 * 直接回复模式执行（Chat Agent）
 *
 * 与 executeClaudeTask（话题模式）并行的简化执行路径：
 * - 不创建话题、不做 workspace routing
 * - 不发进度卡片（Chat Agent 响应通常较快）
 * - 固定使用 defaultWorkDir（Chat Agent 只读分析，不需要工作区隔离）
 * - 话题内也走此路径，通过 per-thread session 管理独立对话
 * - Agent 可通过 start_discussion_thread MCP 工具动态升级为话题模式
 */
export async function executeDirectTask(
  rawPrompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[],
  agentId: AgentId = 'pm',
  eventThreadId?: string,
  rootId?: string,
  createTime?: string,
  options?: { skipQuickAck?: boolean; forceThread?: boolean },
  messageType?: string,
): Promise<void> {
  const agentCfg = agentRegistry.getOrThrow(agentId);
  const session = sessionManager.getOrCreate(chatId, userId, agentId);
  const workingDir = config.claude.defaultWorkDir;

  sessionManager.setStatus(chatId, userId, 'busy', agentId);

  // /t 命令：强制创建话题，后续回复在话题中
  let threadReplyMsgId: string | undefined = eventThreadId ? rootId : undefined;
  let threadId: string | undefined = eventThreadId;
  // ensureThread 创建新话题时返回的初始进度卡片 ID，结果出来后原地更新为完成态
  let progressCardMsgId: string | undefined;

  if (options?.forceThread && !eventThreadId) {
    const threadResult = await ensureThread(chatId, userId, messageId, rootId, undefined, agentId);
    threadReplyMsgId = threadResult.threadReplyMsgId;
    progressCardMsgId = threadResult.greetingMsgId;
    if (threadReplyMsgId) {
      const s = sessionManager.getOrCreate(chatId, userId, agentId);
      threadId = s.threadId;
    }
  }

  const sessionKey = threadId
    ? `${chatId}:${userId}:${threadId}`
    : `${chatId}:${userId}`;

  // 即时表情反馈：话题内消息或主聊天未启用 quick-ack 时，先添加表情回复
  // 正式回复发出后再移除表情（在 finally 中清理）
  let pendingReactionId: string | undefined;
  const useEmojiFallback = !!threadId || (!config.quickAck.enabled && !options?.skipQuickAck);
  if (useEmojiFallback) {
    pendingReactionId = await feishuClient.addReaction(messageId, 'OnIt').catch(() => undefined);
  }

  try {
    // 快速确认：用小模型判断消息类型并生成短回复
    // 纯问候类消息直接回复后跳过 Claude，其他类型照常走完整查询
    // 话题内消息跳过 quick-ack：bot 可能是被 threadBypass 隐式触发的，不是被明确 @的
    // cron 定时任务跳过 quick-ack：占位消息已由 scheduler 发送，不需要额外确认
    // forceThread 也跳过 quick-ack（/t 命令的预期行为）
    let quickAckMsgId: string | undefined;
    const skipAck = !!threadId || !!options?.skipQuickAck || !!options?.forceThread;
    const quickAck = skipAck ? null : await generateQuickAck(rawPrompt);
    if (quickAck) {
      let ackSent = false;
      try {
        if (threadReplyMsgId) {
          quickAckMsgId = await feishuClient.replyTextInThread(threadReplyMsgId, quickAck.text);
        } else {
          quickAckMsgId = await feishuClient.replyText(messageId, quickAck.text);
        }
        ackSent = true;
      } catch (err) {
        logger.warn({ err }, 'Quick ack send failed (non-blocking)');
      }

      // 纯问候消息：仅在 ack 成功发送后才跳过 Claude，否则 fallthrough 让 Claude 兜底
      if (quickAck.type === 'greeting' && ackSent) {
        logger.info({ text: quickAck.text }, 'Greeting detected, skipping Claude query');
        sessionManager.setStatus(chatId, userId, 'idle', agentId);
        return;
      }
    }

    // Thread session 管理（话题内独立对话）
    // threadId 可能来自 eventThreadId（用户在话题中发消息）或 forceThread（/t 创建的新话题）
    let threadSession = threadId
      ? sessionManager.getThreadSession(threadId, agentId)
      : undefined;
    if (threadId && !threadSession) {
      sessionManager.upsertThreadSession(threadId, chatId, userId, workingDir, agentId);
      threadSession = sessionManager.getThreadSession(threadId, agentId);
    }

    // Resume 策略：per-thread 优先，否则使用全局 session
    const activeConversationId = eventThreadId
      ? threadSession?.conversationId
      : session.conversationId;
    const activeConversationCwd = eventThreadId
      ? threadSession?.conversationCwd
      : session.conversationCwd;
    const activePromptHash = eventThreadId ? threadSession?.systemPromptHash : session.systemPromptHash;
    // resume 开关：无会话 / cwd 变更 / agent noResume → 全新会话（注入最近 N 条历史）
    const canResume = canResumeSession({
      activeConversationId,
      activeConversationCwd,
      workingDir,
      noResume: agentCfg.noResume,
    });
    const resumeSessionId = canResume ? activeConversationId : undefined;

    // 群聊/话题中标注发送者身份，避免多用户共享 session 时模型混淆对话对象
    const senderTaggedPrompt = await tagSenderIdentity(rawPrompt, userId, chatId, !!(eventThreadId || chatId));

    // 在用户消息末尾附带发送时间元数据
    const msgTimeSuffix = formatCreateTime(createTime);
    const promptWithTime = msgTimeSuffix
      ? `${senderTaggedPrompt}\n\n<msg-time>${msgTimeSuffix}</msg-time>`
      : senderTaggedPrompt;

    // 每次 @bot 都注入最新聊天历史（resume 时通过 afterMsgId 去重，只注入新消息）
    const selfBotOpenIds = accountManager.getAllBotOpenIds();
    if (feishuClient.botOpenId) selfBotOpenIds.add(feishuClient.botOpenId);

    let effectivePrompt = promptWithTime;
    // 仅在真正 resume 时做增量去重；不 resume（含 noResume/cwd 变更）时注入完整最近 N 条
    const afterMsgId = canResume ? _historyDedup.get(sessionKey) : undefined;
    logger.info(
      { sessionKey, afterMsgId, hasConversationId: !!activeConversationId, canResume, currentMessageId: messageId, rootId },
      'History dedup state before buildDirectTaskHistory',
    );
    const history = await buildDirectTaskHistory(chatId, eventThreadId, messageId, afterMsgId, selfBotOpenIds);
    logger.info(
      { sessionKey, hasHistoryText: !!history.text, historyLen: history.text?.length, newestMsgId: history.newestMsgId },
      'buildDirectTaskHistory result',
    );
    if (history.text) {
      effectivePrompt = history.text + '\n\n---\n\n' + promptWithTime;
    }
    if (history.newestMsgId) {
      _historyDedup.set(sessionKey, history.newestMsgId);
    }
    // Resume 时跳过历史文件附件：SDK 会重放所有前序 turn，文件已在对话中，
    // 重复附加会导致 payload 累积膨胀（N turns × PDF size → 超 30MB 限制）
    if (canResume) {
      if (history.topicRootImages?.length || history.documents?.length) {
        logger.info(
          { topicRootImages: history.topicRootImages?.length ?? 0, historyDocs: history.documents?.length ?? 0 },
          'Skipping history file attachments on resume — already in conversation',
        );
      }
      // 当前消息非文件上传时，documents 来自引用父消息，resume 时同样已在对话中
      if (documents?.length && messageType !== 'file') {
        logger.info(
          { docCount: documents.length, fileNames: documents.map(d => d.fileName) },
          'Clearing quoted-parent documents on resume — already sent in previous turn',
        );
        documents = undefined;
      }
    } else {
      // 非 resume：正常合并历史文件
      // 当前消息图片打默认标签
      if (images?.length) {
        images = images.map(img => ({ ...img, label: img.label ?? '用户当前消息的图片' }));
      }
      // 话题首条图片走多模态（已带标签）
      if (history.topicRootImages && history.topicRootImages.length > 0) {
        images = [...(images ?? []), ...history.topicRootImages];
      }
      // 纯历史图片走文本路径提示，前置到 prompt
      if (history.historyImagePaths && history.historyImagePaths.length > 0) {
        const hint = formatHistoryImageHints(history.historyImagePaths);
        if (hint) effectivePrompt = hint + '\n\n---\n\n' + effectivePrompt;
      }
      // 合并历史消息中的文档（PDF），按 fileName 去重 + 大小截断
      if (history.documents && history.documents.length > 0) {
        documents = deduplicateDocuments([...(documents ?? []), ...(history.documents)]);
      }
    }
    // 合并历史消息中的文本文件内容到 prompt（文本内容不占多模态空间，始终注入）
    if (history.fileTexts && history.fileTexts.length > 0) {
      effectivePrompt = history.fileTexts.join('\n\n') + '\n\n---\n\n' + effectivePrompt;
    }

    // rootId 引用消息注入（仅主面板引用回复，话题内 rootId 是锚定消息不需要注入）
    if (!eventThreadId) {
      const quoted = await injectQuotedMessage(effectivePrompt, rootId, messageId, chatId, images);
      effectivePrompt = quoted.prompt;
      images = quoted.images;
    }

    // discussion MCP server：允许 agent 动态创建话题（仅在非话题场景下注入）
    // 如果消息已经在一个话题中（eventThreadId 或 forceThread 创建的），不需要再创建新话题
    const discussionMcp = threadId
      ? null
      : createDiscussionMcpServer({
          chatId, userId, messageId, agentId,
          onThreadCreated: (info) => {
            threadReplyMsgId = info.threadReplyMsgId;
            threadId = info.threadId;
            // 话题创建后撤回主群的 quick-ack 消息（正式回复会在话题中）
            if (quickAckMsgId) {
              feishuClient.deleteMessage(quickAckMsgId).then((ok) => {
                if (ok) logger.info({ quickAckMsgId }, 'Recalled quick-ack after thread creation');
              });
              quickAckMsgId = undefined;
            }
          },
        });

    const personaPrompt = readPersonaFile(agentId);

    // 记忆注入（使用 repo identity 确保同仓库记忆互通）
    const repoIdentity = getRepoIdentity(workingDir);
    const memoryContext = config.memory.enabled
      ? await injectMemories(rawPrompt, { agentId, userId, workspaceDir: repoIdentity, chatId, repository: resolveRepositoryForCwd(workingDir) })
      : '';

    // Bot 身份上下文（多 bot 模式下告诉 agent 自己是谁、群内有哪些其他 bot）
    const botIdentityContext = buildBotIdentityContext(chatId, agentId);

    // AskUserQuestion 回调（与 executeClaudeTask 共享逻辑）
    const onAskUserDirect = createAskUserHandler(chatId, () => threadReplyMsgId);

    // /fable 强制模型：thread 级优先，其次 chat 级 session
    const forcedModel = resolveForcedModel(threadSession?.forcedModel, session.forcedModel);

    const result = await claudeExecutor.execute({
      sessionKey,
      prompt: effectivePrompt,
      workingDir,
      readOnly: agentCfg.readOnly,
      model: forcedModel ?? agentCfg.model,
      maxTurns: agentCfg.maxTurns,
      maxBudgetUsd: agentCfg.maxBudgetUsd,
      toolAllow: agentCfg.toolAllow,
      toolDeny: agentCfg.toolDeny,
      editablePathPatterns: agentCfg.editablePathPatterns,
      settingSources: agentCfg.settingSources,
      knowledgeContent: loadKnowledgeContent(agentId),
      memoryContext,
      botIdentityContext,
      ...(personaPrompt ? { systemPromptOverride: personaPrompt } : {}),
      resumeSessionId,
      storedSystemPromptHash: activePromptHash,
      images,
      documents,
      agentId,
      onAskUser: onAskUserDirect,
      // 不需要 workspace-manager 工具（Chat Agent 不切换工作区）
      disableWorkspaceTool: true,
      // 注入 discussion-tools MCP server
      ...(discussionMcp ? { additionalMcpServers: { 'discussion-tools': discussionMcp } } : {}),
    });

    // 保存 conversationId（下次消息可 resume）
    if (result.sessionId) {
      if (threadId) {
        sessionManager.upsertThreadSession(threadId, chatId, userId, workingDir, agentId);
        sessionManager.setThreadConversationId(threadId, result.sessionId, workingDir, agentId, result.systemPromptHash);
      }
      // 非话题时也保存到全局 session（主面板后续消息可 resume）
      if (!eventThreadId) {
        sessionManager.setConversationId(chatId, userId, result.sessionId, workingDir, agentId, result.systemPromptHash);
      }
    }

    // 发送结果（统一走轻量回复，话题内通过 threadReplyMsgId 路由）
    // progressCardMsgId 仅在 /t 创建新话题时有值，原地更新为完成态合并卡片
    await sendDirectReply(messageId, chatId, result, threadReplyMsgId, progressCardMsgId);

    // 记忆抽取 (fire-and-forget)
    if (config.memory.enabled && result.success && result.output) {
      extractMemories(rawPrompt, result.output, {
        agentId, userId, chatId, workspaceDir: repoIdentity, messageId,
        userName: _userNameCache.get(userId),
        repository: resolveRepositoryForCwd(workingDir),
      }).catch((err) => logger.warn({ err }, 'Memory extraction failed'));
    }

  } catch (err) {
    logger.error({ err }, 'Error in executeDirectTask');
    const errorReply = `❌ 执行出错: ${(err as Error).message}`;
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, errorReply);
    } else {
      await feishuClient.replyText(messageId, errorReply);
    }
  } finally {
    // 移除话题内的待处理表情回复（无论成功/失败都要清理）
    if (pendingReactionId) {
      feishuClient.removeReaction(messageId, pendingReactionId).catch(() => {});
    }
    try {
      sessionManager.setStatus(chatId, userId, 'idle', agentId);
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to reset session status');
    }
  }
}

// ============================================================
// Direct 模式聊天历史构建（Fork 语义）
// ============================================================

/** buildDirectTaskHistory 的返回值 */
interface HistoryResult {
  /** 格式化的历史文本（无新消息时为 undefined） */
  text?: string;
  /** 本次注入的最新 messageId（用于下次去重） */
  newestMsgId?: string;
  /** 话题首条消息的图片(带 label,走多模态)。仅话题模式有值。 */
  topicRootImages?: ImageAttachment[];
  /** 历史消息中提取的文档附件（PDF） */
  documents?: DocumentAttachment[];
  /** 历史消息中提取的文本文件内容（已格式化，可拼入 prompt） */
  fileTexts?: string[];
  /** 历史消息中纯历史图片(含话题首条)的落盘路径,走文本提示 + restartImagePaths 兜底 */
  historyImagePaths?: string[];
}

/**
 * 构建 direct 模式的聊天上下文（fork 语义 + 增量去重）。
 *
 * max 由 CHAT_HISTORY_MAX_COUNT 控制（默认 10）。
 *
 * - 主聊天区（无 threadId）：取父群最近 max 条
 * - 话题内：
 *   - 话题消息 M < max → 补充父群消息至 max 条
 *   - 话题消息 M ≥ max → 首条 + 最近 (max - 1) 条
 *   - 话题为空 → 从父群 fork
 *
 * 与 buildChatHistoryContext 共用同一份实现，仅多打印一份 pipeline 诊断日志。
 *
 * @param afterMsgId 上次注入的最新 messageId，有值时只返回比它更新的消息
 */
async function buildDirectTaskHistory(
  chatId: string,
  threadId?: string,
  currentMessageId?: string,
  afterMsgId?: string,
  selfBotOpenIds?: Set<string>,
): Promise<HistoryResult> {
  return buildHistoryContext(chatId, threadId, currentMessageId, afterMsgId, selfBotOpenIds, {
    verboseLogging: true,
    errorLabel: 'Failed to build direct task history',
  });
}

/**
 * 直接回复结果（轻量模式，短文本纯文字、长文本或已有占位卡片走 combined card）
 *
 * @param threadReplyMsgId 话题内时传入，使用 replyTextInThread / replyCardInThread
 * @param progressCardMsgId /t 创建话题时 ensureThread 返回的占位卡片 ID，原地更新为完成态
 */
async function sendDirectReply(
  messageId: string,
  chatId: string,
  result: import('../claude/types.js').ClaudeResult,
  threadReplyMsgId?: string,
  progressCardMsgId?: string,
): Promise<void> {
  // progressCardMsgId 存在：始终原地更新占位卡片为完成态（避免遗留 "正在处理..."）
  if (progressCardMsgId) {
    const durationStr = formatDuration(result.durationMs);
    const costInfo = result.costUsd ? ` | 💰 $${result.costUsd.toFixed(4)}` : '';
    // 失败时也保留 partial output（执行器可能在 timeout/budget 触发前已产出文本）
    const text = result.success
      ? (result.output || '_(无输出)_')
      : (result.output || '');
    const card = buildCombinedProgressCard(text, [], 1, true, undefined, {
      success: result.success,
      durationStr: durationStr + costInfo,
      error: result.error,
    });
    await feishuClient.updateCard(progressCardMsgId, card).catch((err) => {
      logger.warn({ err, progressCardMsgId }, 'Failed to update direct-reply progress card');
    });
    return;
  }

  // 成功但无输出（如模型 thinking 后决定不回复）→ 静默，不发 "(无输出)"
  if (result.success && !result.output) {
    logger.debug({ messageId }, 'Direct reply skipped — empty output (silent)');
    return;
  }

  const output = result.output || result.error || '(无输出)';

  if (!result.success) {
    // 失败时显示错误
    const errorMsg = result.error || output;
    const truncated = errorMsg.length > 2000 ? errorMsg.slice(0, 2000) + '...' : errorMsg;
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, `❌ ${truncated}`);
    } else {
      await feishuClient.replyText(messageId, `❌ ${truncated}`);
    }
    return;
  }

  if (output.length <= 2000) {
    // 短文本：尝试解析 @mention，有则用 post 格式发送
    const postContent = await resolveMentions(output, chatId);
    if (postContent) {
      if (threadReplyMsgId) {
        await feishuClient.replyPostInThread(threadReplyMsgId, postContent);
      } else {
        await feishuClient.replyPost(messageId, postContent);
      }
    } else if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, output);
    } else {
      await feishuClient.replyText(messageId, output);
    }
  } else {
    // 长文本：合并卡片（无 header，含状态栏）
    const durationStr = formatDuration(result.durationMs);
    const costInfo = result.costUsd ? ` | 💰 $${result.costUsd.toFixed(4)}` : '';
    const card = buildCombinedProgressCard(output, [], 1, true, undefined, {
      success: result.success,
      durationStr: durationStr + costInfo,
    });
    if (threadReplyMsgId) {
      await feishuClient.replyCardInThread(threadReplyMsgId, card);
    } else {
      await feishuClient.sendCard(chatId, card);
    }
  }
}

/**
 * 发送结果卡片（提取为独立函数，避免 restart 和正常流程重复代码）
 *
 * 仅在 progressCardMsgId 缺失时（极少见的兜底场景）作为新卡片发送。
 * 统一使用合并卡片样式，与原地更新路径保持一致。
 */
async function sendResultCard(
  result: import('../claude/types.js').ClaudeResult,
  totalDurationMs: number,
  totalCostUsd: number | undefined,
  threadReplyMsgId: string | undefined,
  chatId: string,
  /** 最后一个缓冲的 turn（逐条模式），其内容合并进底部结果卡片 */
  lastTurn?: TurnInfo,
  /** 逐条模式的轮次计数 */
  turnCount?: number,
): Promise<void> {
  const durationStr = formatDuration(totalDurationMs);
  const costInfo = totalCostUsd
    ? ` | 💰 $${totalCostUsd.toFixed(4)}`
    : '';

  // 合并卡片：合并最后一轮文本 + 工具调用，附带状态栏
  const text = lastTurn?.textContent ?? result.output ?? '';
  const tools = lastTurn?.toolCalls ?? [];
  const turns = turnCount ?? 1;

  const resultCard = buildCombinedProgressCard(text, tools, turns, true, undefined, {
    success: result.success,
    durationStr: durationStr + costInfo,
    error: result.error,
  });

  if (threadReplyMsgId) {
    await feishuClient.replyCardInThread(threadReplyMsgId, resultCard);
  } else {
    await feishuClient.sendCard(chatId, resultCard);
  }

  // 非逐条模式下，如果输出特别长，额外发送完整文本
  if (!lastTurn && result.output && result.output.length > 3000) {
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, result.output);
    } else {
      await feishuClient.sendText(chatId, result.output);
    }
  }
}

/**
 * 执行自动开发管道（/dev 命令触发）
 * 通过 resolveThreadContext 解析话题上下文（路由 + 工作区隔离），然后创建待确认管道
 */
async function executePipelineTask(
  prompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
  eventThreadId?: string,
): Promise<void> {
  let threadReplyMsgId: string | undefined;

  try {
    // 1. 解析话题上下文（thread + workingDir + greeting）
    const resolved = await resolveThreadContext({
      prompt,
      chatId,
      userId,
      messageId,
      rootId,
      threadId: eventThreadId,
    });

    if (resolved.status !== 'resolved') return;

    threadReplyMsgId = resolved.ctx.threadReplyMsgId;
    const { workingDir } = resolved.ctx;

    // 2. 创建 pipeline，使用当前 workingDir（默认 defaultWorkDir 或已被 setup_workspace 切换的目录）
    await createPendingPipeline({
      chatId,
      userId,
      messageId,
      rootId,
      threadId: eventThreadId,
      prompt,
      workingDir,
      threadReplyMsgId,
    });
  } catch (err) {
    logger.error({ err }, 'Error in executePipelineTask');
    const errorMsg = `❌ 开发管道创建失败: ${(err as Error).message}`;
    try {
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, errorMsg);
      } else {
        await feishuClient.replyText(messageId, errorMsg);
      }
    } catch {
      // best-effort notification
    }
  }
}

/** 图片大小限制：15MB（base64 编码后约 20MB，接近 Anthropic API 限制） */
const MAX_IMAGE_SIZE_BYTES = 15 * 1024 * 1024;

/**
 * 根据 Buffer 前几个字节推断图片 MIME 类型
 */
function detectImageMediaType(buf: Buffer): ImageAttachment['mediaType'] {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/png'; // 默认 fallback
}

/**
 * 解析飞书消息 (使用 SDK 类型化的事件数据)
 * 异步：图片消息需要下载图片
 */
async function parseMessage(data: MessageEventData): Promise<ParsedMessage | null> {
  const { message, sender } = data;

  // 只处理文本、图片、文件、富文本（post）和合并转发（merge_forward）消息
  const supportedTypes = new Set(['text', 'image', 'file', 'post', 'merge_forward']);
  if (!supportedTypes.has(message.message_type)) {
    logger.debug({ messageType: message.message_type }, 'Ignoring unsupported message type');
    return null;
  }

  let text = '';
  let images: ImageAttachment[] | undefined;
  let documents: DocumentAttachment[] | undefined;
  // 当前消息内图片同步落盘：workspace 切换后 restart 不重传 images，落盘路径作为 fallback 文本注入
  const currentImagePaths: string[] = [];

  if (message.message_type === 'merge_forward') {
    // 合并转发消息：通过 API 获取子消息列表，解析后拼成可读文本
    try {
      const items = await feishuClient.getMessageById(message.message_id);
      if (!items || items.length === 0) {
        logger.warn({ messageId: message.message_id }, 'merge_forward: API returned no items');
        text = '[合并转发消息 - 无法获取内容]';
      } else {
        // 过滤出子消息（有 upper_message_id 的），排除 merge_forward 容器本身
        const subMessages = items.filter(item => item.upper_message_id && item.message_id !== message.message_id);
        if (subMessages.length === 0) {
          text = '[合并转发消息 - 无子消息]';
        } else {
          // 按 create_time 排序
          subMessages.sort((a, b) => {
            const timeA = parseInt(a.create_time || '0', 10);
            const timeB = parseInt(b.create_time || '0', 10);
            return timeA - timeB;
          });

          // 限制最多 50 条子消息
          const MAX_SUB_MESSAGES = 50;
          const limited = subMessages.slice(0, MAX_SUB_MESSAGES);

          // 批量解析发送者名称（去重后并行请求）
          const uniqueSenderIds = [...new Set(limited.map(item => item.sender?.id).filter(Boolean))] as string[];
          const senderNameMap = new Map<string, string>();
          await Promise.all(
            uniqueSenderIds.map(async (senderId) => {
              try {
                const name = await feishuClient.getUserName(senderId, message.chat_id);
                if (name) senderNameMap.set(senderId, name);
              } catch { /* 解析失败跳过，不影响主流程 */ }
            }),
          );


          const lines: string[] = ['[合并转发的聊天记录]'];

          // 收集合并转发中的 PDF 文件名
          // 注：飞书 API 不支持下载合并转发子消息的资源文件（返回 400），
          // 只能提示用户单条转发或直接上传
          const pdfFileNames: string[] = [];

          for (const item of limited) {
            const msgType = item.msg_type || 'text';

            // 记录 PDF 文件名（无法下载，仅用于提示）
            if (msgType === 'file') {
              try {
                const fileBody = JSON.parse(item.body?.content || '{}');
                const fileName = (fileBody.file_name as string) || '';
                if (fileName.toLowerCase().endsWith('.pdf')) {
                  pdfFileNames.push(fileName);
                }
              } catch { /* ignore parse errors */ }
            }

            const formatted = formatMergeForwardSubMessage(item.body?.content || '', msgType, item.mentions);
            if (!formatted) continue;
            const senderId = item.sender?.id ?? '';
            const senderName = senderNameMap.get(senderId) ?? '未知用户';
            lines.push(`- [${senderName}](${senderId || '?'}): ${formatted}`);
          }

          // 提示用户合并转发中的 PDF 无法读取
          if (pdfFileNames.length > 0) {
            lines.push(`\n⚠️ 合并转发中包含 ${pdfFileNames.length} 个 PDF 文件，因飞书 API 限制无法直接读取：`);
            for (const name of pdfFileNames) {
              lines.push(`  - ${name}`);
            }
            lines.push('💡 请将 PDF 文件逐条单独转发给我，或直接在对话框上传文件');
          }

          if (subMessages.length > MAX_SUB_MESSAGES) {
            lines.push(`- ... 还有 ${subMessages.length - MAX_SUB_MESSAGES} 条消息未显示`);
          }

          text = lines.join('\n');
          logger.info({ messageId: message.message_id, subMessageCount: subMessages.length, pdfCount: pdfFileNames.length }, 'merge_forward: parsed sub-messages');
        }
      }
    } catch (err) {
      logger.error({ err, messageId: message.message_id }, 'Failed to parse merge_forward message');
      text = '[合并转发消息 - 解析失败]';
    }
  } else if (message.message_type === 'post') {
    // 富文本消息：委托 extractPostText 统一解析,本地仅做 bot 过滤 + 图片下载
    const selfBotOpenId = feishuClient.botOpenId;
    const postAllBotIds = isMultiBotMode() ? accountManager.getAllBotOpenIds() : new Set<string>();
    try {
      const extracted = extractPostText(message.content, undefined, {
        separator: '',
        includeImagePlaceholder: false,
        isBot: (openId) => (!!selfBotOpenId && openId === selfBotOpenId) || postAllBotIds.has(openId),
      });
      text = extracted.text.trim();
      const imageKeys = extracted.imageRefs.map((r) => r.imageKey);

      // 下载所有图片
      if (imageKeys.length) {
        images = [];
        for (const imageKey of imageKeys) {
          try {
            const buf = await feishuClient.downloadMessageImage(message.message_id, imageKey);
            if (buf.length > MAX_IMAGE_SIZE_BYTES) {
              logger.warn({ messageId: message.message_id, imageKey, sizeBytes: buf.length }, 'Post image too large, skipping');
              await feishuClient.replyText(message.message_id, `⚠️ 图片太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），请压缩到 15MB 以内后重试`);
              continue;
            }
            const mediaType = detectImageMediaType(buf);
            const compressed = await compressImage(buf, mediaType);
            if (compressed.data.length < buf.length) {
              logger.info({ imageKey, originalSize: buf.length, compressedSize: compressed.data.length, ratio: `${(compressed.data.length / buf.length * 100).toFixed(0)}%` }, 'Image compressed');
            }
            images.push({ data: compressed.data.toString('base64'), mediaType: compressed.mediaType });
            try {
              const path = await saveMessageFileToCache(message.message_id, imageKey, buf, `image${mediaTypeToExt(mediaType)}`);
              currentImagePaths.push(path);
            } catch (saveErr) {
              logger.debug({ err: saveErr, messageId: message.message_id, imageKey }, 'Failed to persist post image to cache (non-fatal)');
            }
          } catch (err) {
            logger.error({ err, messageId: message.message_id, imageKey }, 'Failed to download post image');
          }
        }
        if (!images.length) images = undefined;
      }
    } catch (err) {
      logger.error({ err, content: message.content }, 'Failed to parse post message');
      return null;
    }
  } else if (message.message_type === 'image') {
    // 图片消息：解析 image_key 并下载
    try {
      const content = JSON.parse(message.content);
      const imageKey = content.image_key as string | undefined;
      if (!imageKey) {
        logger.error({ content: message.content }, 'Image message missing image_key');
        return null;
      }

      const buf = await feishuClient.downloadMessageImage(message.message_id, imageKey);

      // 大小检查
      if (buf.length > MAX_IMAGE_SIZE_BYTES) {
        logger.warn({ messageId: message.message_id, sizeBytes: buf.length }, 'Image too large, skipping');
        await feishuClient.replyText(message.message_id, `⚠️ 图片太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），请压缩到 15MB 以内后重试`);
        return null;
      }

      const mediaType = detectImageMediaType(buf);
      const compressed = await compressImage(buf, mediaType);
      if (compressed.data.length < buf.length) {
        logger.info({ messageId: message.message_id, originalSize: buf.length, compressedSize: compressed.data.length, ratio: `${(compressed.data.length / buf.length * 100).toFixed(0)}%` }, 'Image compressed');
      }
      images = [{ data: compressed.data.toString('base64'), mediaType: compressed.mediaType }];
      try {
        const path = await saveMessageFileToCache(message.message_id, imageKey, buf, `image${mediaTypeToExt(mediaType)}`);
        currentImagePaths.push(path);
      } catch (saveErr) {
        logger.debug({ err: saveErr, messageId: message.message_id, imageKey }, 'Failed to persist image to cache (non-fatal)');
      }
    } catch (err) {
      logger.error({ err, messageId: message.message_id }, 'Failed to process image message');
      await feishuClient.replyText(message.message_id, '⚠️ 图片下载失败，请稍后重试');
      return null;
    }
  } else if (message.message_type === 'file') {
    // 文件消息：支持 PDF（多模态）和文本类文件（小文件嵌入 prompt，大文件落盘 lazy load）
    const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024; // 30MB
    const INLINE_TEXT_FILE_THRESHOLD = 64 * 1024; // <= 64KB 直接嵌入 prompt，省一轮工具调用
    try {
      const content = JSON.parse(message.content);
      const fileKey = content.file_key as string | undefined;
      const fileName = (content.file_name as string) || '未知文件';

      if (!fileKey) {
        logger.error({ content: message.content }, 'File message missing file_key');
        return null;
      }

      if (fileName.toLowerCase().endsWith('.pdf')) {
        // PDF 文件：多模态 DocumentAttachment
        const buf = await feishuClient.downloadMessageFile(message.message_id, fileKey);

        if (buf.length > MAX_FILE_SIZE_BYTES) {
          logger.warn({ messageId: message.message_id, sizeBytes: buf.length, fileName }, 'File too large, skipping');
          await feishuClient.replyText(message.message_id, `⚠️ 文件太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），请压缩到 30MB 以内后重试`);
          return null;
        }

        documents = [{ data: buf.toString('base64'), mediaType: 'application/pdf', fileName }];
        logger.info({ messageId: message.message_id, fileName, sizeBytes: buf.length }, 'PDF file downloaded');
      } else if (isTextFile(fileName)) {
        // 文本类文件：小文件直接嵌入 prompt；大文件落盘，让 agent 用 Read 按需 offset/limit 分段读
        const buf = await feishuClient.downloadMessageFile(message.message_id, fileKey);

        if (buf.length > MAX_FILE_SIZE_BYTES) {
          logger.warn({ messageId: message.message_id, sizeBytes: buf.length, fileName }, 'Text file too large, skipping');
          await feishuClient.replyText(message.message_id, `⚠️ 文本文件太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`);
          return null;
        }

        if (buf.length <= INLINE_TEXT_FILE_THRESHOLD) {
          const fileContent = buf.toString('utf-8');
          text = `[用户发送了文件: ${fileName}]\n\n<file name="${fileName}">\n${fileContent}\n</file>`;
          logger.info({ messageId: message.message_id, fileName, sizeBytes: buf.length }, 'Text file embedded inline');
        } else {
          const filePath = await saveMessageFileToCache(message.message_id, fileKey, buf, fileName);
          const sizeKB = (buf.length / 1024).toFixed(1);
          text = `[用户发送了文件: ${fileName}（${sizeKB} KB），已保存到本地: ${filePath}\n请使用 Read 工具按需读取该文件，支持 offset/limit 分段；文件保留 24 小时。]`;
          logger.info({ messageId: message.message_id, fileName, sizeBytes: buf.length, filePath }, 'Text file saved to cache for lazy read');
        }
      } else {
        text = `[用户发送了文件: ${fileName}，该文件类型暂不支持。支持的类型：PDF、常见文本/代码文件（.md, .txt, .json, .log, .py, .ts 等）]`;
      }
    } catch (err) {
      logger.error({ err, messageId: message.message_id }, 'Failed to process file message');
      await feishuClient.replyText(message.message_id, '⚠️ 文件下载失败，请稍后重试');
      return null;
    }
  } else {
    // 文本消息：解析 text 字段
    try {
      const content = JSON.parse(message.content);
      text = content.text || '';
      // 飞书引用回复合并转发消息时，text 会被包裹在 <p> 标签中，需要剥离 HTML 标签
      if (text.includes('<')) {
        text = text.replace(/<[^>]+>/g, '').trim();
      }
    } catch {
      logger.error({ content: message.content }, 'Failed to parse message content');
      return null;
    }
  }

  // 引用回复：如果当前消息引用了文件消息（parent_id），尝试下载父消息的文件
  // 场景：群聊中用户先发文件，再引用回复该文件并 @bot
  if (message.parent_id && !documents?.length) {
    try {
      const parentItems = await feishuClient.getMessageById(message.parent_id);
      if (parentItems && parentItems.length > 0) {
        const parent = parentItems[0];
        if (parent.msg_type === 'file' && parent.message_id && parent.body?.content) {
          const parentContent = JSON.parse(parent.body.content);
          const fileKey = parentContent.file_key as string | undefined;
          const fileName = (parentContent.file_name as string) || '未知文件';
          if (fileKey) {
            if (fileName.toLowerCase().endsWith('.pdf')) {
              const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;
              const buf = await feishuClient.downloadMessageFile(parent.message_id, fileKey);
              if (buf.length <= MAX_FILE_SIZE_BYTES) {
                documents = [{ data: buf.toString('base64'), mediaType: 'application/pdf', fileName }];
                logger.info({ messageId: message.message_id, parentId: message.parent_id, fileName, sizeBytes: buf.length }, 'PDF downloaded from quoted parent message');
              } else {
                logger.warn({ messageId: message.message_id, sizeBytes: buf.length, fileName }, 'Quoted file too large, skipping');
              }
            } else if (isTextFile(fileName)) {
              const MAX_TEXT_SIZE = 30 * 1024 * 1024;
              const INLINE_THRESHOLD = 64 * 1024;
              const buf = await feishuClient.downloadMessageFile(parent.message_id, fileKey);
              if (buf.length > MAX_TEXT_SIZE) {
                logger.warn({ messageId: message.message_id, sizeBytes: buf.length, fileName }, 'Quoted text file too large, skipping');
              } else if (buf.length <= INLINE_THRESHOLD) {
                const fileContent = buf.toString('utf-8');
                text = `${text}\n\n[引用的文件: ${fileName}]\n\n<file name="${fileName}">\n${fileContent}\n</file>`;
                logger.info({ messageId: message.message_id, parentId: message.parent_id, fileName, sizeBytes: buf.length }, 'Quoted text file embedded inline');
              } else {
                const filePath = await saveMessageFileToCache(parent.message_id, fileKey, buf, fileName);
                const sizeKB = (buf.length / 1024).toFixed(1);
                text = `${text}\n\n[引用的文件: ${fileName}（${sizeKB} KB），已保存到本地: ${filePath}\n请使用 Read 工具按需读取该文件，支持 offset/limit 分段；文件保留 24 小时。]`;
                logger.info({ messageId: message.message_id, parentId: message.parent_id, fileName, sizeBytes: buf.length, filePath }, 'Quoted text file saved to cache for lazy read');
              }
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err, messageId: message.message_id, parentId: message.parent_id }, 'Failed to fetch quoted parent message file');
    }
  }

  // 清理 @mention 标记，检测是否 @了机器人
  // @自己 bot → 去掉（占位符无意义），@其他 bot → 去掉，@人类用户 → 替换成 @名字（保留语义给 Claude）
  let mentionedBot = false;
  const botOpenId = feishuClient.botOpenId;
  const allBotIds = isMultiBotMode() ? accountManager.getAllBotOpenIds() : new Set<string>();
  // 补充 chatBotRegistry 的跨 app bot open_id（与 handleMessageEvent 中的 anyBotMentioned 逻辑一致）
  const chatId = message.chat_id;
  if (chatId) {
    for (const b of chatBotRegistry.getBots(chatId)) {
      allBotIds.add(b.openId);
    }
  }
  if (message.mentions) {
    for (const mention of message.mentions) {
      const openId = mention.id.open_id ?? '';
      const isSelfBot = botOpenId ? openId === botOpenId : false;
      const isAnyBot = isSelfBot || allBotIds.has(openId);

      if (isAnyBot) {
        // bot mention：去掉占位符
        text = text.replace(mention.key, '').trim();
        if (isSelfBot) mentionedBot = true;
        // 从 @mention 元素中补充 bot 名字（被动收集 sender_type=app 时 name 不可用）
        if (chatId && openId && mention.name) {
          chatBotRegistry.addBot(chatId, openId, mention.name, 'message_sender');
        }
      } else {
        // 人类用户 @mention：替换为 @名字，让 Claude 看到被 @ 的人
        text = text.replace(mention.key, `@${mention.name}`);
      }
    }
  }

  // 纯文本消息需要有文字内容；图片/文档消息允许 text 为空
  // 例外：@bot 的空消息不丢弃（上下文会自动加载，bot 可以基于历史消息回复）
  if (!text.trim() && !images?.length && !documents?.length && !mentionedBot) return null;

  return {
    text: text.trim(),
    messageId: message.message_id,
    userId: sender.sender_id?.open_id || '',
    chatId: message.chat_id,
    chatType: message.chat_type,
    mentionedBot,
    mentions: (message.mentions ?? []).map(m => ({ id: { open_id: m.id.open_id } })),
    rootId: message.root_id || undefined,
    threadId: message.thread_id || undefined,
    images,
    documents,
    messageType: message.message_type,
    senderType: sender.sender_type,
    createTime: message.create_time || undefined,
    ...(currentImagePaths.length > 0 ? { currentImagePaths } : {}),
  };
}

// ============================================================
// Bot 入群 / 离群事件处理
// ============================================================

/**
 * 处理 bot 被加入群聊事件
 * 事件数据结构: { chat_id, operator_id, ... } + users 数组（每个 user 含 user_id/open_id/name）
 */
function handleBotAddedEvent(data: Record<string, unknown>, accountId: string): void {
  const chatId = (data as any)?.chat_id as string | undefined;
  const users = (data as any)?.users as Array<{ user_id?: { open_id?: string }; name?: string }> | undefined;
  if (!chatId || !users) {
    logger.warn({ data, accountId }, 'bot.added event missing chatId or users');
    return;
  }
  const selfBotOpenIds = accountManager.getAllBotOpenIds();
  // 单 bot 模式下 getAllBotOpenIds() 为空，需补充 feishuClient.botOpenId
  const selfBotOpenId = feishuClient.botOpenId;
  if (selfBotOpenId) selfBotOpenIds.add(selfBotOpenId);
  for (const user of users) {
    const openId = user.user_id?.open_id;
    if (!openId) continue;
    // 排除自身 bot（不需要追踪自己）
    if (selfBotOpenIds.has(openId)) continue;
    chatBotRegistry.addBot(chatId, openId, user.name, 'event_added');
    logger.info({ chatId, openId, name: user.name, accountId }, 'Bot added to chat (event)');
  }
}

/**
 * 处理 bot 被移出群聊事件
 *
 * 区分两种情况：
 * 1. 被移出的是其他 bot → removeBot
 * 2. 被移出的是本 bot → clearChat（不再能收到该群事件）
 */
function handleBotDeletedEvent(data: Record<string, unknown>, accountId: string): void {
  const chatId = (data as any)?.chat_id as string | undefined;
  const users = (data as any)?.users as Array<{ user_id?: { open_id?: string } }> | undefined;
  if (!chatId || !users) {
    logger.warn({ data, accountId }, 'bot.deleted event missing chatId or users');
    return;
  }
  const selfBotOpenIds = accountManager.getAllBotOpenIds();
  // 单 bot 模式下 getAllBotOpenIds() 为空，需补充 feishuClient.botOpenId
  const selfBotOpenId = feishuClient.botOpenId;
  if (selfBotOpenId) selfBotOpenIds.add(selfBotOpenId);
  for (const user of users) {
    const openId = user.user_id?.open_id;
    if (!openId) continue;
    if (selfBotOpenIds.has(openId)) {
      // 本 bot 被移出群 → 清空该群的全部 bot 记录
      chatBotRegistry.clearChat(chatId);
      logger.info({ chatId, accountId }, 'Self bot removed from chat, cleared bot registry');
      return;
    }
    chatBotRegistry.removeBot(chatId, openId);
    logger.info({ chatId, openId, accountId }, 'Bot removed from chat (event)');
  }
}

/** @internal 测试用导出 */
export const _testing = { handleBotAddedEvent, handleBotDeletedEvent, makeQueueKey, injectQuotedMessage, resolveMentionGate };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m${remainSec}s`;
}
