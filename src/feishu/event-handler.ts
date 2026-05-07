import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../utils/logger.js';
import { isUserAllowed, containsDangerousCommand, isOwner, autoDetectOwner } from '../utils/security.js';
import { sessionManager } from '../session/manager.js';
import { taskQueue } from '../session/queue.js';
import { claudeExecutor } from '../claude/executor.js';
import { DEFAULT_IMAGE_PROMPT, DEFAULT_DOCUMENT_PROMPT } from '../claude/types.js';
import type { TurnInfo, ToolCallInfo, ImageAttachment, DocumentAttachment, ConversationTurn } from '../claude/types.js';
import { buildResultCard, buildStatusCard, buildCancelledCard, buildPipelineCard, buildPipelineConfirmCard, buildCombinedProgressCard, buildSimpleResultCard, buildAskUserQuestionCard, buildAskUserAnsweredCard } from './message-builder.js';
import type { AskUserQuestionItem } from './message-builder.js';
import { TOTAL_PHASES } from '../pipeline/types.js';
import { feishuClient, feishuClientContext, runWithAccountId } from './client.js';
import { config, isMultiBotMode } from '../config.js';
import { checkAndRequestApproval, handleApprovalTextCommand, handleApprovalCardAction, setOnApproved } from './approval.js';
import { resolveThreadContext } from './thread-context.js';
import { ensureThread } from './thread-utils.js';
import { formatMergeForwardSubMessage } from './message-parser.js';
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
import { handleMemoryCommand, handleMemoryCardAction } from '../memory/commands.js';
import { getRepoIdentity } from '../workspace/identity.js';
import { parseRepoNameFromWorkspaceDir } from '../workspace/manager.js';
import { generateQuickAck } from '../utils/quick-ack.js';
import { checkThreadRelevance } from '../utils/thread-relevance.js';
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
const pendingQuestions = new Map<string, PendingQuestion>();

/** AskUserQuestion 等待超时（5 分钟） */
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000;

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

      pending.timeoutTimer = setTimeout(() => {
        pendingQuestions.delete(questionId);
        reject(new Error('AskUserQuestion timed out'));
      }, ASK_USER_TIMEOUT_MS);

      pendingQuestions.set(questionId, pending);

      // 发送卡片（在话题内回复或直接发到群）
      // 如果发送失败，立即 reject 而非等待 5 分钟超时
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
  const { chatType, mentionedBot, mentions, threadId, messageId, text, userId, chatId, agentId, accountId, images, documents } = input;

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
    const anyBotMentioned = mentions.some(m => knownBotIds.has(m.id.open_id ?? ''));

    // 话题内 thread bypass：话题创建者 bot 无需 @mention
    if (threadId && !anyBotMentioned && isThreadCreatorAgent(threadId, agentId)) {
      const ts = sessionManager.getThreadSession(threadId, agentId);
      if (ts && (isOwner(userId) || ts.userId === userId)) {
        const recentMsgs = await feishuClient.fetchRecentMessages(threadId, 'thread', 10);
        const humanSenders = new Set(recentMsgs.filter(m => m.senderType === 'user').map(m => m.senderId));

        if (humanSenders.size <= 1) {
          return 'thread_bypass_exclusive';
        }

        const botDisplayName = agentRegistry.get(agentId)?.displayName ?? 'bot';
        const context = await formatThreadContext(recentMsgs, botDisplayName, chatId, accountId);
        const relevant = await checkThreadRelevance(text, botDisplayName, context);
        if (relevant) {
          return 'thread_bypass';
        }
        logger.info({ threadId, agentId, text: text.slice(0, 100), humanCount: humanSenders.size }, 'Thread bypass skipped — message not directed at bot');
      }
    }

    // @mention / commander 路由
    const reason = getRespondReason(chatType, mentions, botOpenId, knownBotIds, commanderOpenId);
    if (reason) return reason;

    return undefined;
  }

  // 单 bot 模式
  if (mentionedBot) return 'mentioned';
  if (chatType !== 'group') return 'non_group';

  // 群聊未 @mention：仅话题内 session 创建者可放行
  const ts = threadId ? sessionManager.getThreadSession(threadId) : undefined;
  if (!ts || (!isOwner(userId) && ts.userId !== userId)) {
    return undefined;
  }

  if (images?.length || documents?.length) {
    logger.info({ messageId, threadId }, 'Thread session owner: image/doc bypass');
    return 'thread_session_media';
  }

  const recentMsgs = threadId ? await feishuClient.fetchRecentMessages(threadId, 'thread', 10) : [];
  const humanSenders = new Set(recentMsgs.filter(m => m.senderType === 'user').map(m => m.senderId));

  if (humanSenders.size <= 1) {
    return 'thread_session_owner';
  }

  const botDisplayName = agentRegistry.get(agentId)?.displayName ?? 'bot';
  const context = await formatThreadContext(recentMsgs, botDisplayName, chatId, accountId);
  const relevant = await checkThreadRelevance(text, botDisplayName, context);
  if (!relevant) {
    logger.info({ messageId, threadId, text: text?.slice(0, 100), humanCount: humanSenders.size }, 'Thread session owner: semantically not directed at bot');
    return undefined;
  }

  logger.info({ messageId, threadId }, 'Thread session owner: semantically relevant');
  return 'thread_session_owner';
}

/**
 * 将话题最近消息格式化为 Qwen 可读的对话记录。
 * 用于多人话题场景的语义判断，让 Qwen 看清谁在跟谁说话。
 */
async function formatThreadContext(
  messages: Array<{ senderId: string; senderType: string; content: string }>,
  botName: string,
  chatId: string,
  accountId: string,
): Promise<string> {
  const userIds = [...new Set(messages.filter(m => m.senderType === 'user').map(m => m.senderId))];
  await resolveUserNames(userIds, chatId);

  const selfBotOpenId = accountManager.getBotOpenId(accountId) ?? '';
  const botNameMap = new Map<string, string>();
  for (const acc of accountManager.allAccounts()) {
    if (acc.botOpenId) botNameMap.set(acc.botOpenId, acc.botName);
  }
  const lines: string[] = [];
  let totalLen = 0;
  for (const m of messages) {
    let name: string;
    if (m.senderType === 'app') {
      name = m.senderId === selfBotOpenId
        ? `${botName}(bot)`
        : `${botNameMap.get(m.senderId) ?? chatBotRegistry.getBots(chatId).find(b => b.openId === m.senderId)?.name ?? '其他bot'}(bot)`;
    } else {
      name = _userNameCache.get(m.senderId) ?? '用户';
    }
    const content = m.senderType === 'app' ? m.content.slice(0, 100) : m.content;
    const line = `[${name}]: ${content}`;
    if (totalLen + line.length > 1500) break;
    lines.push(line);
    totalLen += line.length;
  }
  return lines.join('\n');
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
      : executeClaudeTask(task.message, task.chatId, task.userId, task.messageId, task.rootId, task.threadId, task.images, task.documents, agentId, task.createTime, task.messageType);

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

  const { text, messageId, userId, chatId, chatType, mentionedBot, rootId, threadId, images, documents, messageType, mentions, createTime } = parsed;

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
  taskQueue.enqueue(queueKey, chatId, userId, effectiveText, messageId, rootId, effectiveThreadId, images, documents, createTime, forceThread, messageType, accountId).catch(() => {});
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
    const session = sessionManager.getOrCreate(chatId, userId);
    const card = buildStatusCard(
      session.workingDir,
      session.status,
      taskQueue.pendingCountForChat(chatId),
    );
    if (threadReplyMsgId) {
      await feishuClient.replyCardInThread(threadReplyMsgId, card);
    } else {
      await feishuClient.sendCard(chatId, card);
    }
    return true;
  }

  // /auth 已在 @mention 过滤之前处理（无需 @ 即可触发），此处不再重复

  // /reset - 重置会话（清除所有 agent 的 session + thread conversation）
  if (trimmed === '/reset') {
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
      `**预算**: $${agentCfg?.maxBudgetUsd ?? '?'} / ${agentCfg?.maxTurns ?? '?'} turns`,
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

  // /help - 帮助
  if (trimmed === '/help') {
    const helpLines: string[] = [
      '🤖 **Anycode 使用帮助**',
      '',
      '直接发送消息即可与 Agent 对话。支持文本、图片、PDF 文件。',
      '',
      '**── 基础命令 ──**',
      '`/status` — 查看当前会话状态（工作目录、队列）',
      '`/reset` — 重置会话，清除对话历史',
      '`/stop` — 中断当前正在执行的任务',
      '`/config` — 查看当前 Agent 配置和人设 🔒',
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
): Promise<{ images: ImageAttachment[]; lazyHints: string[] }> {
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
  if (refs.length === 0) return { images: [], lazyHints: [] };

  // 父群图片：lazy loading（注入元数据，不下载）
  const lazyHints: string[] = [];
  const downloadable = refs.filter(ref => {
    if (ref.fromParent) {
      lazyHints.push(
        `[群聊历史图片] — 未自动加载。如需查看，可调用 feishu_download_message_image 工具（参数: message_id="${ref.messageId}", image_key="${ref.imageKey}"）`,
      );
      return false;
    }
    return true;
  });

  if (lazyHints.length > 0) {
    logger.info({ parentImageCount: lazyHints.length }, 'Parent chat images skipped (lazy loading), metadata injected');
  }

  if (downloadable.length === 0) return { images: [], lazyHints };

  const toDownload = downloadable.slice(-MAX_HISTORY_IMAGES);

  const results = await Promise.all(toDownload.map(async (ref) => {
    try {
      const buf = await feishuClient.downloadMessageImage(ref.messageId, ref.imageKey);
      if (buf.length > 15 * 1024 * 1024) {
        logger.warn({ messageId: ref.messageId, size: buf.length }, 'History image too large, skipping');
        return null;
      }
      const mediaType = detectImageMediaType(buf);
      const compressed = await compressImageForHistory(buf, mediaType);
      return {
        data: compressed.data.toString('base64'),
        mediaType: compressed.mediaType,
      } as ImageAttachment;
    } catch (err) {
      logger.warn({ err, messageId: ref.messageId, imageKey: ref.imageKey }, 'Failed to download history image, skipping');
      return null;
    }
  }));
  const images = results.filter((img): img is ImageAttachment => img !== null);

  if (images.length > 0) {
    logger.info({ count: images.length, totalRefs: refs.length, parentSkipped: lazyHints.length }, 'Downloaded history images');
  }

  return { images, lazyHints };
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
  const MAX_TEXT_SIZE = 1 * 1024 * 1024;

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
        if (buf.length <= MAX_TEXT_SIZE) {
          const content = buf.toString('utf-8');
          fileTexts.push(`[历史消息中的文件: ${ref.fileName}]\n\n<file name="${ref.fileName}">\n${content}\n</file>`);
          logger.info({ messageId: ref.messageId, fileName: ref.fileName, sizeBytes: buf.length }, 'History text file downloaded');
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

    const [text, imagesResult, historyFiles] = await Promise.all([
      formatHistoryMessages(messages, chatId, selfBotOpenIds, parentMsgCount > 0 ? { parentMsgCount } : undefined),
      downloadHistoryImages(messages, parentMsgCount),
      downloadHistoryFiles(messages, parentMsgCount),
    ]);
    const fileTexts = [...historyFiles.fileTexts, ...imagesResult.lazyHints];
    return {
      text: text ?? undefined,
      newestMsgId,
      ...(imagesResult.images.length > 0 ? { images: imagesResult.images } : {}),
      ...(historyFiles.documents.length > 0 ? { documents: historyFiles.documents } : {}),
      ...(fileTexts.length > 0 ? { fileTexts } : {}),
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
  const SELF_BOT_MSG_MAX = 150;   // resume 上下文里有完整版，这里只需定位
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
): Promise<{ prompt: string; images?: ImageAttachment[] }> {
  if (!rootId || rootId === messageId) return { prompt: effectivePrompt, images: existingImages };

  try {
    const rootItems = await feishuClient.getMessageById(rootId);
    if (!rootItems || rootItems.length === 0) return { prompt: effectivePrompt, images: existingImages };

    const rootMsg = rootItems.find(m => m.message_id === rootId);
    if (!rootMsg) return { prompt: effectivePrompt, images: existingImages };

    const rootMsgType = rootMsg.msg_type || 'text';
    let rootContent = '';
    let quotedImage: ImageAttachment | undefined;

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
            quotedImage = { data: compressed.data.toString('base64'), mediaType: compressed.mediaType };
            rootContent = '[用户引用了一张图片]';
            logger.info({ rootId, imageSize: buf.length, compressedSize: compressed.data.length }, 'Downloaded quoted image');
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
      return { prompt: newPrompt, images: mergedImages };
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

  const { threadReplyMsgId, workingDir, threadId, threadSession, prompt } = resolved.ctx;
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
  let progressCardMsgId: string | undefined;
  let progressCardFailed = false;
  if (threadReplyMsgId) {
    progressCardMsgId = await feishuClient.replyCardInThread(
      threadReplyMsgId, buildCombinedProgressCard('', [], 0),
    ) ?? undefined;
    if (!progressCardMsgId) progressCardFailed = true;
  } else {
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
  if (!historySummaries) {
    // 收集所有自己管理的 bot open_id，用于历史消息差异化截断
    const selfBotOpenIds = accountManager.getAllBotOpenIds();
    if (feishuClient.botOpenId) selfBotOpenIds.add(feishuClient.botOpenId);

    const afterMsgId = activeConversationId ? _historyDedup.get(sessionKey) : undefined;
    const history = await buildChatHistoryContext(chatId, threadId, messageId, afterMsgId, selfBotOpenIds);
    if (history.text) {
      effectivePrompt = history.text + '\n\n---\n\n' + promptWithTime;
    }
    if (history.newestMsgId) {
      _historyDedup.set(sessionKey, history.newestMsgId);
    }
    // Resume 时清理引用父消息的 documents：那是上一个 turn 已发送的文件，重复附加会膨胀 payload
    if (activeConversationId && documents?.length && messageType !== 'file') {
      logger.info(
        { docCount: documents.length, fileNames: documents.map(d => d.fileName) },
        'Clearing quoted-parent documents on resume — already sent in previous turn',
      );
      documents = undefined;
    }
    // 历史消息中的图片/文档：afterMsgId 已确保只返回上次注入之后的新消息，可安全合并
    // （非 resume 时 afterMsgId=undefined，返回完整历史窗口；resume 时只返回新消息）
    if (history.images && history.images.length > 0) {
      images = [...(history.images), ...(images ?? [])];
    }
    if (history.documents && history.documents.length > 0) {
      documents = deduplicateDocuments([...(documents ?? []), ...(history.documents)]);
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
    // Resume 策略：activeConversationId/activeConversationCwd 已在上方提前计算
    const activePromptHash = threadId ? threadSession?.systemPromptHash : session.systemPromptHash;
    const canResume = activeConversationId
      && (!activeConversationCwd || activeConversationCwd === workingDir);
    if (activeConversationId && !canResume) {
      logger.info(
        { sessionKey, threadId, sessionId: activeConversationId, sessionCwd: activeConversationCwd, currentCwd: workingDir },
        'Skipping resume: cwd mismatch (workspace switched), starting fresh session',
      );
    }
    // NOTE: 图片消息（AsyncIterable prompt）也支持 resume，SDK 的 resume 是 CLI 参数与 prompt 投递方式正交

    // readOnly: agent 配置优先，如果 agent 是 readonly 则强制只读；
    // 否则回退到 owner 检查（dev agent 中非 owner 也是只读）
    const agentCfg = agentRegistry.get(agentId);
    const readOnly = agentCfg?.readOnly ?? !isOwner(userId);
    // 自定义 agent 支持 persona（dev agent 没配置时 → undefined → 使用默认 buildWorkspaceSystemPrompt）
    const customSystemPrompt = readPersonaFile(agentId);
    const knowledgeContent = loadKnowledgeContent(agentId);

    // 记忆注入：搜索相关记忆，格式化为 system prompt 片段
    // 使用 repo identity（而非带随机后缀的工作区路径）确保同仓库记忆互通
    const repoIdentity = getRepoIdentity(workingDir);
    const memoryContext = config.memory.enabled
      ? await injectMemories(rawPrompt, { agentId, userId, workspaceDir: repoIdentity, chatId })
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
      model: agentCfg?.model,
      maxTurns: agentCfg?.maxTurns,
      maxBudgetUsd: agentCfg?.maxBudgetUsd,
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
            prompt, { ...result, success: false, output: '', error: '工作区准备失败，目录不存在' },
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

      // 第二次 query：以新 cwd 执行，CLAUDE.md 正确加载
      // - 不传 resumeSessionId（Agent SDK 不支持跨 cwd resume，会 exit code 1）
      // - 不传 onWorkspaceChanged（不触发二次 restart）
      // - disableWorkspaceTool: 完全移除 setup_workspace MCP tool，防止无限循环
      // - 使用 effectivePrompt（含聊天历史）而非裸 prompt，避免 restart 后丢失对话上下文
      const restartResult = await claudeExecutor.execute({
        sessionKey,
        prompt: effectivePrompt,
        workingDir: result.newWorkingDir,
        readOnly,
        model: agentCfg?.model,
        maxTurns: agentCfg?.maxTurns,
        maxBudgetUsd: agentCfg?.maxBudgetUsd,
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
          prompt, restartResult, totalDurationMs, totalCostUsd,
          threadReplyMsgId, chatId, undefined, turnCount,
        );
      }

      // 记忆抽取 (fire-and-forget, restart 路径)
      if (config.memory.enabled && restartResult.success && restartResult.output) {
        extractMemories(prompt, restartResult.output, {
          agentId, userId, chatId, workspaceDir: getRepoIdentity(result.newWorkingDir!), messageId,
          userName: _userNameCache.get(userId),
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
        prompt, result, result.durationMs, result.costUsd,
        threadReplyMsgId, chatId, undefined, turnCount,
      );
    }

    // 记忆抽取 (fire-and-forget)
    if (config.memory.enabled && result.success && result.output) {
      extractMemories(rawPrompt, result.output, {
        agentId, userId, chatId, workspaceDir: repoIdentity, messageId,
        userName: _userNameCache.get(userId),
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

  if (options?.forceThread && !eventThreadId) {
    const threadResult = await ensureThread(chatId, userId, messageId, rootId, undefined, agentId);
    threadReplyMsgId = threadResult.threadReplyMsgId;
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
    const canResume = activeConversationId
      && (!activeConversationCwd || activeConversationCwd === workingDir);
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
    const afterMsgId = activeConversationId ? _historyDedup.get(sessionKey) : undefined;
    logger.info(
      { sessionKey, afterMsgId, hasConversationId: !!activeConversationId, currentMessageId: messageId, rootId },
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
    // Resume 时清理引用父消息的 documents：那是上一个 turn 已发送的文件，重复附加会膨胀 payload
    if (canResume && documents?.length && messageType !== 'file') {
      logger.info(
        { docCount: documents.length, fileNames: documents.map(d => d.fileName) },
        'Clearing quoted-parent documents on resume — already sent in previous turn',
      );
      documents = undefined;
    }
    // 历史消息中的图片/文档：afterMsgId 已确保只返回上次注入之后的新消息，可安全合并
    // （非 resume 时 afterMsgId=undefined，返回完整历史窗口；resume 时只返回新消息）
    if (history.images && history.images.length > 0) {
      images = [...(history.images), ...(images ?? [])];
    }
    if (history.documents && history.documents.length > 0) {
      documents = deduplicateDocuments([...(documents ?? []), ...(history.documents)]);
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
      ? await injectMemories(rawPrompt, { agentId, userId, workspaceDir: repoIdentity, chatId })
      : '';

    // Bot 身份上下文（多 bot 模式下告诉 agent 自己是谁、群内有哪些其他 bot）
    const botIdentityContext = buildBotIdentityContext(chatId, agentId);

    // AskUserQuestion 回调（与 executeClaudeTask 共享逻辑）
    const onAskUserDirect = createAskUserHandler(chatId, () => threadReplyMsgId);

    const result = await claudeExecutor.execute({
      sessionKey,
      prompt: effectivePrompt,
      workingDir,
      readOnly: agentCfg.readOnly,
      model: agentCfg.model,
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
    await sendDirectReply(messageId, chatId, result, threadReplyMsgId);

    // 记忆抽取 (fire-and-forget)
    if (config.memory.enabled && result.success && result.output) {
      extractMemories(rawPrompt, result.output, {
        agentId, userId, chatId, workspaceDir: repoIdentity, messageId,
        userName: _userNameCache.get(userId),
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
  /** 历史消息中提取的图片（已压缩） */
  images?: ImageAttachment[];
  /** 历史消息中提取的文档附件（PDF） */
  documents?: DocumentAttachment[];
  /** 历史消息中提取的文本文件内容（已格式化，可拼入 prompt） */
  fileTexts?: string[];
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
 * 直接回复结果（轻量模式，短文本纯文字、长文本才用卡片）
 *
 * @param threadReplyMsgId 话题内时传入，使用 replyTextInThread / replyCardInThread
 */
async function sendDirectReply(
  messageId: string,
  chatId: string,
  result: import('../claude/types.js').ClaudeResult,
  threadReplyMsgId?: string,
): Promise<void> {
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
    // 长文本：卡片
    const durationStr = formatDuration(result.durationMs);
    const costInfo = result.costUsd ? ` | 💰 $${result.costUsd.toFixed(4)}` : '';
    const card = buildResultCard(output, output, true, durationStr + costInfo);
    if (threadReplyMsgId) {
      await feishuClient.replyCardInThread(threadReplyMsgId, card);
    } else {
      await feishuClient.sendCard(chatId, card);
    }
  }
}

/**
 * 发送结果卡片（提取为独立函数，避免 restart 和正常流程重复代码）
 */
async function sendResultCard(
  prompt: string,
  result: import('../claude/types.js').ClaudeResult,
  totalDurationMs: number,
  totalCostUsd: number | undefined,
  threadReplyMsgId: string | undefined,
  chatId: string,
  /** 最后一个缓冲的 turn（逐条模式），其内容合并进底部结果卡片 */
  lastTurn?: TurnInfo,
  /** 逐条模式的轮次计数 */
  _turnCount?: number,
): Promise<void> {
  const durationStr = formatDuration(totalDurationMs);
  const costInfo = totalCostUsd
    ? ` | 💰 $${totalCostUsd.toFixed(4)}`
    : '';

  // 结果卡片：逐条模式包含最后一轮内容，否则包含完整输出
  const resultCard = lastTurn
    ? buildSimpleResultCard(prompt, result.success, durationStr + costInfo, result.error, lastTurn)
    : buildResultCard(
        prompt,
        result.output || result.error || '(无输出)',
        result.success,
        durationStr + costInfo,
      );

  // 发送到话题底部（作为新消息）
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
    // 富文本消息：解析 content 中的 text、at、img 元素
    // at 元素需要区分 bot（跳过）和人类（保留 @名字给 Claude）
    const selfBotOpenId = feishuClient.botOpenId;
    const postAllBotIds = isMultiBotMode() ? accountManager.getAllBotOpenIds() : new Set<string>();
    try {
      const content = JSON.parse(message.content);
      // post 内容结构有两种形式:
      //   1. 直接: { "title": "...", "content": [[elements]] }
      //   2. 带语言键: { "zh_cn": { "title": "...", "content": [[elements]] } }
      let postBody: Record<string, unknown> | undefined;
      if (Array.isArray(content.content)) {
        postBody = content;
      } else {
        postBody = (content.zh_cn || content.en_us || content.ja_jp || Object.values(content)[0]) as Record<string, unknown> | undefined;
      }
      const paragraphs = postBody?.content as Array<Array<Record<string, unknown>>> | undefined;

      if (!paragraphs) {
        logger.error({ content: message.content }, 'Post message missing content paragraphs');
        return null;
      }

      const textParts: string[] = [];
      const imageKeys: string[] = [];

      for (const paragraph of paragraphs) {
        for (const element of paragraph) {
          if (element.tag === 'text') {
            textParts.push(element.text as string || '');
          } else if (element.tag === 'at') {
            // @mention：人类用户保留为 @名字（让 Claude 看到），bot 的跳过
            // post 中 at 元素不含 mention.key 占位符，后续 text.replace(mention.key) 不会清理
            const atName = element.user_name as string || '';
            const atUserId = element.user_id as string || '';
            // 直接用 user_id（open_id）判断是否为 bot，比 name 匹配更可靠
            const isBot = (selfBotOpenId && atUserId === selfBotOpenId) || postAllBotIds.has(atUserId);
            if (!isBot && atName) {
              textParts.push(`@${atName}`);
            }
          } else if (element.tag === 'a') {
            const linkText = (element.text as string) || '';
            const href = (element.href as string) || '';
            textParts.push(linkText && href ? `[${linkText}](${href})` : href || linkText);
          } else if (element.tag === 'img') {
            const imageKey = element.image_key as string | undefined;
            if (imageKey) imageKeys.push(imageKey);
          } else if (element.tag === 'media') {
            textParts.push('[视频]');
          } else if (element.tag === 'emotion') {
            const emojiType = (element.emoji_type as string) || '';
            textParts.push(emojiType ? `[${emojiType}]` : '[表情]');
          } else if (element.tag === 'code_block') {
            const lang = (element.language as string) || '';
            const code = (element.text as string) || '';
            textParts.push(lang ? `\`\`\`${lang}\n${code}\`\`\`` : `\`\`\`\n${code}\`\`\``);
          } else if (element.tag === 'md') {
            textParts.push((element.text as string) || '');
          } else if (element.tag === 'hr') {
            textParts.push('---');
          }
        }
      }

      text = textParts.join('').trim();

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
    } catch (err) {
      logger.error({ err, messageId: message.message_id }, 'Failed to process image message');
      await feishuClient.replyText(message.message_id, '⚠️ 图片下载失败，请稍后重试');
      return null;
    }
  } else if (message.message_type === 'file') {
    // 文件消息：支持 PDF（多模态）和文本类文件（嵌入 prompt）
    const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024; // 30MB
    const MAX_TEXT_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1MB for text files
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
        // 文本类文件：下载后作为文本嵌入 prompt
        const buf = await feishuClient.downloadMessageFile(message.message_id, fileKey);

        if (buf.length > MAX_TEXT_FILE_SIZE_BYTES) {
          logger.warn({ messageId: message.message_id, sizeBytes: buf.length, fileName }, 'Text file too large, skipping');
          await feishuClient.replyText(message.message_id, `⚠️ 文本文件太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），请压缩到 1MB 以内后重试`);
          return null;
        }

        const fileContent = buf.toString('utf-8');
        text = `[用户发送了文件: ${fileName}]\n\n<file name="${fileName}">\n${fileContent}\n</file>`;
        logger.info({ messageId: message.message_id, fileName, sizeBytes: buf.length }, 'Text file downloaded and embedded in prompt');
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
              const MAX_TEXT_SIZE = 1 * 1024 * 1024;
              const buf = await feishuClient.downloadMessageFile(parent.message_id, fileKey);
              if (buf.length <= MAX_TEXT_SIZE) {
                const fileContent = buf.toString('utf-8');
                text = `${text}\n\n[引用的文件: ${fileName}]\n\n<file name="${fileName}">\n${fileContent}\n</file>`;
                logger.info({ messageId: message.message_id, parentId: message.parent_id, fileName, sizeBytes: buf.length }, 'Text file downloaded from quoted parent message');
              } else {
                logger.warn({ messageId: message.message_id, sizeBytes: buf.length, fileName }, 'Quoted text file too large, skipping');
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
