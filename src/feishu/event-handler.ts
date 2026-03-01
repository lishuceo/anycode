import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../utils/logger.js';
import { isUserAllowed, containsDangerousCommand, isOwner } from '../utils/security.js';
import { sessionManager } from '../session/manager.js';
import { taskQueue } from '../session/queue.js';
import { claudeExecutor } from '../claude/executor.js';
import { DEFAULT_IMAGE_PROMPT } from '../claude/types.js';
import type { TurnInfo, ToolCallInfo, ImageAttachment } from '../claude/types.js';
import { buildResultCard, buildStatusCard, buildCancelledCard, buildPipelineCard, buildPipelineConfirmCard, buildProgressCard, buildToolProgressCard, buildSimpleResultCard } from './message-builder.js';
import { TOTAL_PHASES } from '../pipeline/types.js';
import { feishuClient, runWithAccountId } from './client.js';
import { config, isMultiBotMode } from '../config.js';
import { setupWorkspace } from '../workspace/manager.js';
import { checkAndRequestApproval, handleApprovalTextCommand, handleApprovalCardAction, setOnApproved } from './approval.js';
import { resolveThreadContext } from './thread-context.js';
import { pipelineStore } from '../pipeline/store.js';
import {
  createPendingPipeline,
  startPipeline,
  abortPipeline,
  cancelPipeline,
  retryPipeline,
} from '../pipeline/runner.js';
import { resolveAgent, shouldRespond } from '../agent/router.js';
import { agentRegistry } from '../agent/registry.js';
import { accountManager } from './multi-account.js';
import { chatBotRegistry } from './bot-registry.js';
import type { AgentId, AgentConfig } from '../agent/types.js';
import { readPersonaFile, loadKnowledgeContent } from '../agent/config-loader.js';
import { createDiscussionMcpServer } from '../agent/tools/discussion.js';
import { generateAuthUrl, isOAuthConfigured, hasCallbackUrl, handleManualCode } from './oauth.js';
import { injectMemories } from '../memory/injector.js';
import { extractMemories } from '../memory/extractor.js';
import { handleMemoryCommand, handleMemoryCardAction } from '../memory/commands.js';
import { getRepoIdentity } from '../workspace/identity.js';
import { generateQuickAck } from '../utils/quick-ack.js';

// 注册审批通过后的消息重新入队回调（避免 approval.ts → event-handler.ts 循环依赖）
setOnApproved((chatId, userId, text, messageId, rootId, threadId) => {
  // threadId 由 handleMessageEvent 校验后传入（有 rootId 时必有 threadId）
  const queueKey = makeQueueKey(chatId, threadId);
  taskQueue.enqueue(queueKey, chatId, userId, text, messageId, rootId, threadId).catch(() => {});
  processQueue(queueKey);
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
        const cardBody = await handleCardAction(data);
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
// 话题创建者判定：option B — 只有话题创建者 bot 自动响应无 @mention 的后续消息
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
// ============================================================

/**
 * 构建队列 key，包含 agentId 维度
 * 同 thread 同 agent 串行，不同 agent 可并行
 *
 * direct 模式（无 thread）加入 userId，不同用户可并行
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

  const agentCfg = agentRegistry.get(agentId);
  // direct 模式 → executeDirectTask（话题内也走 direct 路径）
  const useDirectMode = agentCfg?.replyMode === 'direct';

  const executeFn = useDirectMode
    ? executeDirectTask(task.message, task.chatId, task.userId, task.messageId, task.images, agentId, task.threadId, task.rootId)
    : executeClaudeTask(task.message, task.chatId, task.userId, task.messageId, task.rootId, task.threadId, task.images, agentId);

  // 注册 task promise：graceful shutdown 时等待结果卡片发送完成
  claudeExecutor.registerTask(executeFn);

  executeFn
    .then(() => task.resolve('done'))
    .catch((err) => task.reject(err instanceof Error ? err : new Error(String(err))))
    .finally(() => {
      taskQueue.complete(queueKey);
      // 处理队列中的下一个任务
      processQueue(queueKey, agentId);
    });
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
  /** 原始 mentions 数组（多 bot 模式 shouldRespond 使用） */
  mentions: Array<{ id: { open_id?: string } }>;
  /** message.root_id — 回复链根消息 ID */
  rootId?: string;
  /** message.thread_id — 飞书话题 ID（可靠的话题标识） */
  threadId?: string;
  /** 图片附件列表 (用户发送图片消息时) */
  images?: ImageAttachment[];
  /** 发送者类型: 'user' = 人类用户, 'app' = 应用/机器人 */
  senderType?: string;
}

/**
 * 处理消息事件 (由 EventDispatcher 回调)
 *
 * 多 Agent 模式处理流程：
 * ① shouldRespond — @mention 过滤
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

  const parsed = await parseMessage(data);
  if (!parsed) return;

  const { text, messageId, userId, chatId, chatType, mentionedBot, rootId, threadId, images, mentions, senderType } = parsed;

  // -- 被动收集：消息发送者为 bot 时记录到 registry --
  if (senderType === 'app' && userId && chatId) {
    const selfBotOpenIds = accountManager.getAllBotOpenIds();
    // 单 bot 模式下 getAllBotOpenIds() 为空，需补充 feishuClient.botOpenId
    const selfBotOpenId = feishuClient.botOpenId;
    if (selfBotOpenId) selfBotOpenIds.add(selfBotOpenId);
    if (!selfBotOpenIds.has(userId)) {
      // 非自身 bot → 记录为已知 bot（name 在此处不可用，后续可通过事件补充）
      chatBotRegistry.addBot(chatId, userId, undefined, 'message_sender');
    }
  }

  logger.info({ userId, chatId, chatType, rootId, threadId, accountId, text: text.slice(0, 100), hasImages: !!images?.length }, 'Received message');

  // ── 多 Agent: Binding Router 选 agent 角色（提前解析，供 @mention 过滤使用） ──
  const agentId: AgentId = isMultiBotMode()
    ? resolveAgent(config.agent.bindings, { accountId, chatId, userId, chatType: chatType as 'group' | 'p2p' })
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

  // ── @mention 过滤（必须在所有副作用之前，避免对不该响应的消息发送错误提示） ──
  if (isMultiBotMode()) {
    const botOpenId = accountManager.getBotOpenId(accountId) ?? '';
    const allBotOpenIds = accountManager.getAllBotOpenIds();
    const groupConfig = config.agent.groupConfigs[chatId];
    const commanderOpenId = groupConfig?.commander
      ? accountManager.getBotOpenId(groupConfig.commander)
      : undefined;

    // 话题内消息：话题创建者 bot 无需 @mention 即可响应后续消息
    // 前提：消息没有 @任何 bot —— 显式 @mention 是明确的意图信号，
    //       @了别的 bot 时话题创建者不应抢答（@人类用户不算，可能只是 tag 提醒）
    // 仅限话题发起用户或 owner — 非 owner 的旁观者无 @mention 时静默忽略，
    // 避免好奇路人的消息干扰 dev-bot 正在进行的工作
    // allBotOpenIds 仅包含各 bot 自身 fetchBotInfo 返回的 open_id（同一 app 视角）。
    // 但飞书 open_id 是 app 级别的：pm-bot 收到的 @张全栈 mention 的 open_id ≠ dev-bot 自己的 open_id。
    // 补充 chatBotRegistry 中通过被动收集（sender_type=app）记录的跨 app bot open_id。
    const registryBotIds = chatBotRegistry.getBots(chatId).map(b => b.openId);
    const knownBotIds = new Set([...allBotOpenIds, ...registryBotIds]);
    const anyBotMentioned = mentions.some(m => knownBotIds.has(m.id.open_id ?? ''));
    let threadBypass = false;
    if (threadId && !anyBotMentioned && isThreadCreatorAgent(threadId, agentId)) {
      const ts = sessionManager.getThreadSession(threadId, agentId);
      if (ts && (isOwner(userId) || ts.userId === userId)) {
        threadBypass = true;
        logger.debug({ threadId, agentId, accountId }, 'Thread creator bypass: responding without @mention');
      }
    }

    if (!threadBypass && !shouldRespond(chatType, mentions, botOpenId, knownBotIds, commanderOpenId)) {
      return;
    }
  } else {
    // 单 bot 模式：群聊中需要 @机器人 才响应
    // 例外：话题内后续消息（文本或图片）有活跃 thread session 则放行
    if (chatType === 'group' && !mentionedBot) {
      const inActiveThread = threadId && sessionManager.getThreadSession(threadId);
      if (!inActiveThread) {
        return;
      }
      logger.debug({ messageId, threadId }, 'Message allowed in group thread: active thread session exists');
    }
  }

  // root_id 单独出现（无 thread_id）= 主面板引用回复，不是话题内消息，正常处理即可

  const effectiveThreadId = threadId;

  const agentConfig = agentRegistry.get(agentId);
  logger.debug({ agentId, accountId }, 'Agent resolved');

  // 用户权限检查
  if (!isUserAllowed(userId)) {
    logger.warn({ userId }, 'Unauthorized user');
    await feishuClient.replyText(messageId, '⚠️ 你没有权限使用此机器人');
    return;
  }

  // 斜杠命令、管道确认、审批命令仅对文本消息有效
  if (text) {
    // 处理斜杠命令（在 agent 角色确定后执行）
    const commandResult = await handleSlashCommand(text, chatId, userId, messageId, rootId, effectiveThreadId, agentId);
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
      userId, chatId, chatType, text, messageId,
      rootId, rootId, threadIdForApproval,
    );
    if (!approved) return;
  }

  // 安全检查（图片消息无文本，跳过）
  if (text && containsDangerousCommand(text)) {
    await feishuClient.replyText(messageId, '⚠️ 检测到危险命令，已拒绝执行');
    return;
  }

  // 图片消息无文字时使用默认 prompt
  const effectiveText = text || (images?.length ? DEFAULT_IMAGE_PROMPT : '');

  // 通过 taskQueue 串行化：queue key 包含 agentId，不同 agent 可并行
  // direct 模式加 userId，不同用户可并行
  // enqueue 返回的 Promise 的错误处理在 processQueue/executeClaudeTask 中完成
  const isDirectMode = agentConfig?.replyMode === 'direct';
  const queueKey = makeQueueKey(chatId, effectiveThreadId, agentId, isDirectMode ? userId : undefined);
  taskQueue.enqueue(queueKey, chatId, userId, effectiveText, messageId, rootId, effectiveThreadId, images).catch(() => {});
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
): Promise<boolean> {
  const trimmed = text.trim();

  // 仅当用户确实在话题内发消息时（有 threadId），才回复到话题
  // rootId 单独出现（无 threadId）= 主面板引用回复，不应跟进话题
  // 不 fallback 到 session 的 threadRootMessageId，避免群主界面的命令被发到旧话题
  const threadReplyMsgId = effectiveThreadId ? rootId : undefined;

  // /project <path> - 切换工作目录
  if (trimmed.startsWith('/project ')) {
    const dir = trimmed.slice('/project '.length).trim();
    // 安全校验：路径必须在允许的基目录下（用 realpathSync 跟踪 symlink）
    const { resolve } = await import('node:path');
    const { existsSync, realpathSync } = await import('node:fs');
    const resolved = resolve(dir);
    if (!existsSync(resolved)) {
      const reply = `⚠️ 路径不存在: ${dir}`;
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }
    const realResolved = realpathSync(resolved);
    const allowedBase = existsSync(resolve(config.claude.defaultWorkDir))
      ? realpathSync(resolve(config.claude.defaultWorkDir))
      : resolve(config.claude.defaultWorkDir);
    if (!realResolved.startsWith(allowedBase + '/') && realResolved !== allowedBase) {
      const reply = `⚠️ 路径不在允许的目录范围内 (允许: ${allowedBase})`;
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }
    sessionManager.getOrCreate(chatId, userId);
    sessionManager.setWorkingDir(chatId, userId, realResolved);
    const reply = `📂 工作目录已切换到: ${realResolved}`;
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, reply);
    } else {
      await feishuClient.replyText(messageId, reply);
    }
    return true;
  }

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

  // /workspace <url-or-path> [branch] - 创建隔离工作区
  if (trimmed.startsWith('/workspace ')) {
    const args = trimmed.slice('/workspace '.length).trim().split(/\s+/);
    const source = args[0];
    const sourceBranch = args[1];

    if (!source) {
      const reply = '⚠️ 用法: `/workspace <repo-url-or-local-path> [branch]`';
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }

    try {
      const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(source);
      const result = setupWorkspace({
        ...(isUrl ? { repoUrl: source } : { localPath: source }),
        sourceBranch,
      });

      sessionManager.getOrCreate(chatId, userId);
      sessionManager.setWorkingDir(chatId, userId, result.workspacePath);

      const reply = [
        '📂 工作区已创建',
        `路径: ${result.workspacePath}`,
        `分支: ${result.branch}`,
        `仓库: ${result.repoName}`,
      ].join('\n');
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const reply = `❌ 工作区创建失败: ${errorMsg}`;
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
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

  // /help - 帮助
  if (trimmed === '/help') {
    const helpText = [
      '🤖 **Claude Code Bridge 使用帮助**',
      '',
      '直接发送文本消息即可让 Claude Code 执行任务。',
      '',
      '**可用命令:**',
      '`/project <path>` - 切换工作目录',
      '`/workspace <url|path> [branch]` - 创建隔离工作区 (自动 clone + 创建分支)',
      '`/dev <task>` - 自动开发管道 (方案→审查→实现→审查→推送)',
      '`/memory` - 查看/管理记忆',
      '`/status` - 查看当前会话状态',
      '`/reset` - 重置会话',
      '`/stop` - 中断当前执行',
      '`/help` - 显示此帮助',
      '',
      '**自动工作区:** 直接发消息包含仓库 URL，Claude 会自动创建隔离工作区。',
    ].join('\n');
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, helpText);
    } else {
      await feishuClient.replyText(messageId, helpText);
    }
    return true;
  }

  return false;
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
): Promise<HistoryResult> {
  try {
    const containerId = threadId ?? chatId;
    const containerType = threadId ? 'thread' as const : 'chat' as const;
    const messages = await feishuClient.fetchRecentMessages(containerId, containerType, config.chat.historyMaxCount);

    // 过滤掉当前消息
    let filtered = currentMessageId
      ? messages.filter(m => m.messageId !== currentMessageId)
      : messages;

    // 记录最新 messageId（去重锚点，在过滤 afterMsgId 之前取）
    const newestMsgId = filtered.length > 0 ? filtered[filtered.length - 1].messageId : undefined;

    // 增量去重：只保留 afterMsgId 之后的新消息
    if (afterMsgId && filtered.length > 0) {
      const idx = filtered.findIndex(m => m.messageId === afterMsgId);
      if (idx >= 0) {
        filtered = filtered.slice(idx + 1);
      }
      // afterMsgId 不在列表中 → 可能消息已过期滚动，注入全部
    }

    const text = await formatHistoryMessages(filtered, chatId);
    return { text: text ?? undefined, newestMsgId };
  } catch (err) {
    logger.error({ err, chatId, threadId }, 'Failed to build chat history context');
    return {};
  }
}

/** 用户名缓存：open_id → 用户名（TTL 由 Map 生命周期管理，进程重启清空） */
const _userNameCache = new Map<string, string>();

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
 * 格式化历史消息为上下文文本（共享逻辑）。
 *
 * 保护策略：
 * 1. 单条消息 > 500 字符时截断
 * 2. 总字符数超 CHAT_HISTORY_MAX_CHARS（默认 4000）时，从最旧的消息开始丢弃
 *
 * 当前 @bot 的消息不在 history 中（调用前已过滤），rawPrompt 始终完整保留。
 *
 * @param chatId 群聊 ID（用于解析用户名的 fallback 查询）
 */
async function formatHistoryMessages(
  messages: Array<{ messageId: string; senderId: string; senderType: 'user' | 'app'; content: string; msgType: string }>,
  chatId?: string,
): Promise<string | undefined> {
  if (messages.length === 0) return undefined;

  // 批量解析用户名（只查 user 类型，bot 显示 [Bot]）
  const userIds = messages.filter(m => m.senderType === 'user' && m.senderId).map(m => m.senderId);
  if (userIds.length > 0) {
    await resolveUserNames(userIds, chatId);
  }

  const PER_MSG_MAX = 500;
  const header = [
    '## 飞书聊天近期上下文',
    '以下是用户 @bot 之前的聊天记录，帮助你理解当前对话的背景：',
    '',
  ].join('\n');

  // 1. 格式化每条消息，单条截断
  const lines = messages.map(m => {
    let role: string;
    if (m.senderType === 'app') {
      role = '[Bot]';
    } else {
      const name = m.senderId ? _userNameCache.get(m.senderId) : undefined;
      role = name ? `[${name}]` : '[用户]';
    }
    const text = m.content.length > PER_MSG_MAX
      ? m.content.slice(0, PER_MSG_MAX) + '...'
      : m.content;
    return `${role}: ${text}`;
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
  if (keepFrom > 0) {
    parts.push(`_(已省略 ${keepFrom} 条较早消息)_`);
  }
  parts.push(...kept);
  return parts.join('\n');
}

/** 历史去重缓存：sessionKey → 上次注入的最新 messageId。
 *  resume 时只注入比这个 ID 更新的消息，避免重复。
 *  进程重启时自动清空（conversationId 也丢，不会 resume）。
 *  dev agent 和 chat agent 共享（sessionKey 含 agent 维度，不冲突）。 */
const _historyDedup = new Map<string, string>();

/**
 * 执行 Claude Agent SDK 任务
 * 支持 workspace 变更后自动 restart：第一次 query 触发 setup_workspace 后，
 * 自动以新 cwd 发起第二次 query，确保 CLAUDE.md 正确加载。
 *
 * Resume 策略：优先使用 thread_sessions 表（threadId → conversationId 映射），
 * 每个 thread 独立管理自己的 conversationId，互不干扰。
 */
async function executeClaudeTask(
  rawPrompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
  eventThreadId?: string,
  images?: ImageAttachment[],
  agentId: AgentId = 'dev',
): Promise<void> {
  // 1. 解析话题上下文（thread + 路由 + 工作区隔离 + greeting）
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

  // clarification 恢复后发现原始请求是 /dev pipeline → 转交 pipeline 执行
  if (resolved.pipelineMode) {
    const { workingDir, threadReplyMsgId, prompt } = resolved.ctx;
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
    return;
  }

  const { threadReplyMsgId, workingDir, threadId, threadSession, prompt } = resolved.ctx;
  const session = sessionManager.getOrCreate(chatId, userId, agentId);

  // sessionKey 包含 threadId，per-thread 并行时各 query 有独立的 key
  const sessionKey = threadId ? `${chatId}:${userId}:${threadId}` : `${chatId}:${userId}`;

  // 发送初始进度卡片（即时反馈），后续原地更新为 tool call 进度卡片
  let progressCardMsgId: string | undefined;
  let progressCardFailed = false;
  if (threadReplyMsgId) {
    progressCardMsgId = await feishuClient.replyCardInThread(
      threadReplyMsgId, buildProgressCard(prompt),
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

  // 每次都注入增量飞书聊天历史，拼入 user prompt（不是 system prompt）
  // resume 时通过 afterMsgId 去重，只注入上次交互后新增的消息
  // 确保 dev-bot 能看到中间 @其他bot 的对话等未直接参与的消息
  let effectivePrompt = prompt;
  if (!historySummaries) {
    const afterMsgId = activeConversationId ? _historyDedup.get(sessionKey) : undefined;
    const history = await buildChatHistoryContext(chatId, threadId, messageId, afterMsgId);
    if (history.text) {
      effectivePrompt = history.text + '\n\n---\n\n' + prompt;
    }
    if (history.newestMsgId) {
      _historyDedup.set(sessionKey, history.newestMsgId);
    }
  }

  // 构造逐条 turn 回调
  // 策略：缓冲最后一个 turn，收到新 turn 时将前一个 turn 的 tool calls 刷入累积器，
  // 原地更新进度卡片。结束时最后一个 turn 合并进结果卡片。
  let turnCount = 0;
  let pendingTurn: TurnInfo | undefined;
  const accumulatedToolCalls: ToolCallInfo[] = [];

  const onTurn = async (turn: TurnInfo) => {
    turnCount = turn.turnIndex;
    // 将前一个 turn 的 tool calls 刷入累积器，原地更新进度卡片
    if (pendingTurn) {
      accumulatedToolCalls.push(...pendingTurn.toolCalls);
      if (progressCardMsgId && !progressCardFailed) {
        try {
          await feishuClient.updateCard(
            progressCardMsgId,
            buildToolProgressCard(accumulatedToolCalls, turnCount),
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
    // 额外检查 systemPromptHash：代码部署后 prompt 变化时自动使旧 session 失效
    const activePromptHash = threadId ? threadSession?.systemPromptHash : session.systemPromptHash;
    const canResume = activeConversationId
      && (!activeConversationCwd || activeConversationCwd === workingDir);
    if (activeConversationId && !canResume) {
      logger.info(
        { sessionKey, threadId, sessionId: activeConversationId, sessionCwd: activeConversationCwd, currentCwd: workingDir },
        'Skipping resume: cwd mismatch (workspace switched), starting fresh session',
      );
    }
    if (images?.length && canResume) {
      logger.info(
        { sessionKey, threadId, imageCount: images.length },
        'Skipping resume: image message uses AsyncIterable prompt (incompatible with resume)',
      );
    }

    // readOnly: agent 配置优先，如果 agent 是 readonly 则强制只读；
    // 否则回退到 owner 检查（dev agent 中非 owner 也是只读）
    const agentCfg = agentRegistry.get(agentId);
    const readOnly = agentCfg?.readOnly ?? !isOwner(userId);
    // 自定义 agent 支持 persona（dev agent 没配置时 → undefined → 使用默认 buildWorkspaceSystemPrompt）
    const customSystemPrompt = readPersonaFile(agentId);
    const knowledgeContent = loadKnowledgeContent(agentId);

    // 后续消息（有 conversationId）不允许切换工作区：
    // 首条消息的路由已确定 workingDir，后续切换会触发 restart 导致上下文丢失
    // （Agent SDK 不支持跨 cwd resume，restart 只能起新 session）
    const isFirstMessage = !activeConversationId;

    // 记忆注入：搜索相关记忆，格式化为 system prompt 片段
    // 使用 repo identity（而非带随机后缀的工作区路径）确保同仓库记忆互通
    const repoIdentity = getRepoIdentity(workingDir);
    const memoryContext = config.memory.enabled
      ? await injectMemories(rawPrompt, { agentId, userId, workspaceDir: repoIdentity })
      : '';

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
      // 有图片时不 resume（AsyncIterable prompt 模式与 resume 不兼容）
      resumeSessionId: images?.length ? undefined : (canResume ? activeConversationId : undefined),
      storedSystemPromptHash: activePromptHash,
      onProgress,
      onWorkspaceChanged: isFirstMessage ? onWorkspaceChanged : undefined,
      onTurn,
      historySummaries,
      memoryContext,
      images,
      knowledgeContent,
      disableWorkspaceTool: !isFirstMessage,
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
        await sendResultCard(
          prompt, { ...result, success: false, output: '', error: '工作区准备失败，目录不存在' },
          result.durationMs, result.costUsd,
          threadReplyMsgId, chatId,
        );
        return;
      }

      // workspace 已变更：更新 thread session 的 workingDir，清空 conversationId
      // （cwd 变更后无法 resume 旧 session —— Agent SDK 不允许跨 cwd resume）
      if (threadId) {
        sessionManager.setThreadWorkingDir(threadId, result.newWorkingDir, agentId);
      }
      sessionManager.setConversationId(chatId, userId, '', undefined, agentId);

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
        onProgress,
        onTurn,
        historySummaries,
        knowledgeContent,
        memoryContext,
        disableWorkspaceTool: true,
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

      // 进度卡片切换为完成态（含最后一轮的 tool calls）
      if (progressCardMsgId) {
        const allToolCalls = pendingTurn
          ? [...accumulatedToolCalls, ...pendingTurn.toolCalls]
          : accumulatedToolCalls;
        await feishuClient.updateCard(
          progressCardMsgId,
          buildToolProgressCard(allToolCalls, turnCount, undefined, true),
        );
      }

      await sendResultCard(
        prompt, restartResult, totalDurationMs, totalCostUsd,
        threadReplyMsgId, chatId, threadReplyMsgId ? pendingTurn : undefined, turnCount,
      );

      // 记忆抽取 (fire-and-forget, restart 路径)
      if (config.memory.enabled && restartResult.success && restartResult.output) {
        extractMemories(prompt, restartResult.output, {
          agentId, userId, chatId, workspaceDir: getRepoIdentity(result.newWorkingDir!), messageId,
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

    // 进度卡片切换为完成态
    if (progressCardMsgId) {
      await feishuClient.updateCard(
        progressCardMsgId,
        buildToolProgressCard(accumulatedToolCalls, turnCount, undefined, true),
      );
    }

    await sendResultCard(
      prompt, result, result.durationMs, result.costUsd,
      threadReplyMsgId, chatId, threadReplyMsgId ? pendingTurn : undefined, turnCount,
    );

    // 记忆抽取 (fire-and-forget)
    if (config.memory.enabled && result.success && result.output) {
      extractMemories(rawPrompt, result.output, {
        agentId, userId, chatId, workspaceDir: repoIdentity, messageId,
      }).catch((err) => logger.warn({ err }, 'Memory extraction failed'));
    }

  } catch (err) {
    logger.error({ err }, 'Error executing Claude Agent SDK query');
    // 进度卡片切换为完成态（best-effort，含最后一轮的 tool calls）
    if (progressCardMsgId) {
      const allToolCalls = pendingTurn
        ? [...accumulatedToolCalls, ...pendingTurn.toolCalls]
        : accumulatedToolCalls;
      await feishuClient.updateCard(
        progressCardMsgId,
        buildToolProgressCard(allToolCalls, turnCount, undefined, true),
      ).catch(() => {});
    }
    const errorReply = `❌ 执行出错: ${(err as Error).message}`;
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, errorReply);
    } else {
      await feishuClient.replyText(messageId, errorReply);
    }
  } finally {
    try {
      sessionManager.setStatus(chatId, userId, 'idle', agentId);
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to reset session status');
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
async function executeDirectTask(
  rawPrompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  images?: ImageAttachment[],
  agentId: AgentId = 'pm',
  eventThreadId?: string,
  rootId?: string,
): Promise<void> {
  const agentCfg = agentRegistry.getOrThrow(agentId);
  const session = sessionManager.getOrCreate(chatId, userId, agentId);
  const workingDir = config.claude.defaultWorkDir;
  const sessionKey = eventThreadId
    ? `${chatId}:${userId}:${eventThreadId}`
    : `${chatId}:${userId}`;

  sessionManager.setStatus(chatId, userId, 'busy', agentId);

  // 话题升级标志（由 start_discussion_thread MCP 工具设置）
  // 仅在真正处于话题内时（eventThreadId 存在）初始化；
  // rootId 单独出现（无 eventThreadId）= 主面板引用回复，不是话题
  let threadReplyMsgId: string | undefined = eventThreadId ? rootId : undefined;
  let threadId: string | undefined = eventThreadId;

  try {
    // 快速确认：用小模型立即生成自然短回复，与主流程并行
    // fire-and-forget，不阻塞主流程
    void generateQuickAck(rawPrompt).then((ackText) => {
      if (!ackText) return;
      if (threadReplyMsgId) {
        return feishuClient.replyTextInThread(threadReplyMsgId, ackText);
      }
      return feishuClient.replyText(messageId, ackText);
    }).catch((err) => {
      logger.debug({ err }, 'Quick ack failed (non-blocking)');
    });

    // Thread session 管理（话题内独立对话）
    let threadSession = eventThreadId
      ? sessionManager.getThreadSession(eventThreadId, agentId)
      : undefined;
    if (eventThreadId && !threadSession) {
      sessionManager.upsertThreadSession(eventThreadId, chatId, userId, workingDir, agentId);
      threadSession = sessionManager.getThreadSession(eventThreadId, agentId);
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
    // 有图片时不 resume（AsyncIterable 与 resume 不兼容）
    const resumeSessionId = (images?.length || !canResume) ? undefined : activeConversationId;

    // 每次 @bot 都注入最新聊天历史（resume 时通过 afterMsgId 去重，只注入新消息）
    let effectivePrompt = rawPrompt;
    const afterMsgId = activeConversationId ? _historyDedup.get(sessionKey) : undefined;
    const history = await buildDirectTaskHistory(chatId, eventThreadId, messageId, afterMsgId);
    if (history.text) {
      effectivePrompt = history.text + '\n\n---\n\n' + rawPrompt;
    }
    if (history.newestMsgId) {
      _historyDedup.set(sessionKey, history.newestMsgId);
    }

    // discussion MCP server：允许 agent 动态创建话题
    const discussionMcp = createDiscussionMcpServer({
      chatId, userId, messageId, agentId,
      onThreadCreated: (info) => {
        threadReplyMsgId = info.threadReplyMsgId;
        threadId = info.threadId;
      },
    });

    const personaPrompt = readPersonaFile(agentId);

    // 记忆注入（使用 repo identity 确保同仓库记忆互通）
    const repoIdentity = getRepoIdentity(workingDir);
    const memoryContext = config.memory.enabled
      ? await injectMemories(rawPrompt, { agentId, userId, workspaceDir: repoIdentity })
      : '';

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
      settingSources: agentCfg.settingSources,
      knowledgeContent: loadKnowledgeContent(agentId),
      memoryContext,
      ...(personaPrompt ? { systemPromptOverride: personaPrompt } : {}),
      resumeSessionId,
      storedSystemPromptHash: activePromptHash,
      images,
      // 不需要 workspace-manager 工具（Chat Agent 不切换工作区）
      disableWorkspaceTool: true,
      // 注入 discussion-tools MCP server
      additionalMcpServers: { 'discussion-tools': discussionMcp },
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
 * @param afterMsgId 上次注入的最新 messageId，有值时只返回比它更新的消息
 */
async function buildDirectTaskHistory(
  chatId: string,
  threadId?: string,
  currentMessageId?: string,
  afterMsgId?: string,
): Promise<HistoryResult> {
  try {
    let messages: Array<{ messageId: string; senderId: string; senderType: 'user' | 'app'; content: string; msgType: string }>;

    if (!threadId) {
      // 主聊天区：直接取父群最近消息
      messages = await feishuClient.fetchRecentMessages(chatId, 'chat', config.chat.historyMaxCount);
    } else {
      // 话题模式：fork 语义
      const threadMsgs = await feishuClient.fetchRecentMessages(threadId, 'thread', 50);
      const filtered = currentMessageId
        ? threadMsgs.filter(m => m.messageId !== currentMessageId)
        : threadMsgs;

      if (filtered.length === 0) {
        // 话题为空，从父群 fork
        messages = await feishuClient.fetchRecentMessages(chatId, 'chat', config.chat.historyMaxCount);
      } else if (filtered.length <= config.chat.historyMaxCount) {
        // 话题消息不足 max，补充父群消息
        const remaining = config.chat.historyMaxCount - filtered.length;
        if (remaining > 0) {
          const parentMsgs = await feishuClient.fetchRecentMessages(chatId, 'chat', remaining);
          messages = [...parentMsgs, ...filtered];
        } else {
          messages = filtered;
        }
      } else {
        // 话题消息 > max：首条 + 最近 (max - 1) 条
        const first = filtered[0];
        const latest = filtered.slice(-(config.chat.historyMaxCount - 1));
        messages = [first, ...latest];
      }
    }

    // 过滤当前消息（主聊天区路径，话题路径已在上面过滤）
    if (!threadId && currentMessageId) {
      messages = messages.filter(m => m.messageId !== currentMessageId);
    }

    // 记录最新 messageId（去重锚点，在过滤 afterMsgId 之前取）
    const newestMsgId = messages.length > 0 ? messages[messages.length - 1].messageId : undefined;

    // 增量去重：只保留 afterMsgId 之后的新消息
    if (afterMsgId && messages.length > 0) {
      const idx = messages.findIndex(m => m.messageId === afterMsgId);
      if (idx >= 0) {
        messages = messages.slice(idx + 1);
      }
      // afterMsgId 不在列表中 → 可能消息已过期滚动，注入全部
    }

    const text = await formatHistoryMessages(messages, chatId);
    return { text: text ?? undefined, newestMsgId };
  } catch (err) {
    logger.error({ err, chatId, threadId }, 'Failed to build direct task history');
    return {};
  }
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
    // 短文本：纯文字回复
    if (threadReplyMsgId) {
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
    // 1. 解析话题上下文（共享逻辑：thread + 路由 + 工作区隔离 + greeting）
    const resolved = await resolveThreadContext({
      prompt,
      chatId,
      userId,
      messageId,
      rootId,
      threadId: eventThreadId,
      pipelineMode: true,
    });

    if (resolved.status !== 'resolved') return;

    threadReplyMsgId = resolved.ctx.threadReplyMsgId;
    const { workingDir } = resolved.ctx;

    // 2. 创建 pipeline，使用路由确定的工作目录
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

  // 只处理文本、图片和富文本（post）消息
  if (message.message_type !== 'text' && message.message_type !== 'image' && message.message_type !== 'post') {
    logger.debug({ messageType: message.message_type }, 'Ignoring unsupported message type');
    return null;
  }

  let text = '';
  let images: ImageAttachment[] | undefined;

  if (message.message_type === 'post') {
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
          } else if (element.tag === 'img') {
            const imageKey = element.image_key as string | undefined;
            if (imageKey) imageKeys.push(imageKey);
          }
          // a/emotion 等标签忽略
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
            images.push({ data: buf.toString('base64'), mediaType });
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
      images = [{ data: buf.toString('base64'), mediaType }];
    } catch (err) {
      logger.error({ err, messageId: message.message_id }, 'Failed to process image message');
      await feishuClient.replyText(message.message_id, '⚠️ 图片下载失败，请稍后重试');
      return null;
    }
  } else {
    // 文本消息：解析 text 字段
    try {
      const content = JSON.parse(message.content);
      text = content.text || '';
    } catch {
      logger.error({ content: message.content }, 'Failed to parse message content');
      return null;
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
      } else {
        // 人类用户 @mention：替换为 @名字，让 Claude 看到被 @ 的人
        text = text.replace(mention.key, `@${mention.name}`);
      }
    }
  }

  // 纯文本消息需要有文字内容；图片消息允许 text 为空
  // 例外：@bot 的空消息不丢弃（上下文会自动加载，bot 可以基于历史消息回复）
  if (!text.trim() && !images?.length && !mentionedBot) return null;

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
    senderType: sender.sender_type,
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
export const _testing = { handleBotAddedEvent, handleBotDeletedEvent };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m${remainSec}s`;
}
