import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../utils/logger.js';
import { isUserAllowed, containsDangerousCommand, isOwner } from '../utils/security.js';
import { sessionManager } from '../session/manager.js';
import { taskQueue } from '../session/queue.js';
import { claudeExecutor } from '../claude/executor.js';
import { routeWorkspace } from '../claude/router.js';
import type { TurnInfo, ToolCallInfo } from '../claude/types.js';
import { buildResultCard, buildStatusCard, buildCancelledCard, buildPipelineCard, buildPipelineConfirmCard, buildProgressCard, buildToolProgressCard, buildSimpleResultCard, buildGreetingCardReady } from './message-builder.js';
import { feishuClient } from './client.js';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { setupWorkspace } from '../workspace/manager.js';
import { isAutoWorkspacePath, ensureIsolatedWorkspace } from '../workspace/isolation.js';
import { ensureThread } from './thread-utils.js';
import { checkAndRequestApproval, handleApprovalTextCommand, handleApprovalCardAction, setOnApproved, consumePreApproved } from './approval.js';
import { pipelineStore } from '../pipeline/store.js';
import {
  createPendingPipeline,
  startPipeline,
  abortPipeline,
  cancelPipeline,
  retryPipeline,
} from '../pipeline/runner.js';

// 注册审批通过后的消息重新入队回调（避免 approval.ts → event-handler.ts 循环依赖）
setOnApproved((chatId, userId, text, messageId, rootId) => {
  const queueKey = makeQueueKey(chatId, rootId);
  taskQueue.enqueue(queueKey, chatId, userId, text, messageId, rootId).catch(() => {});
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

// 消息去重缓存 (message_id → 时间戳)，防止飞书重试导致重复处理
const processedMessages = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 分钟过期

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  // 清理过期条目
  if (processedMessages.size > 500) {
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL_MS) processedMessages.delete(id);
    }
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  return false;
}

/**
 * 创建飞书事件分发器
 */
export function createEventDispatcher(): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({
    encryptKey: config.feishu.encryptKey || undefined,
    verificationToken: config.feishu.verifyToken || undefined,
  });

  // 注册消息接收事件 (im.message.receive_v1)
  dispatcher.register({
    'im.message.receive_v1': async (data) => {
      try {
        await handleMessageEvent(data);
      } catch (err) {
        logger.error({ err }, 'Error handling message event');
      }
    },
  });

  // 注册卡片交互回调 (card.action.trigger)
  // WebSocket 长连接模式下，卡片回调也通过 EventDispatcher 接收
  // （CardActionHandler 仅适用于 HTTP Webhook 模式）
  dispatcher.register({
    'card.action.trigger': async (data: Record<string, unknown>) => {
      try {
        const cardBody = await handleCardAction(data);
        // card.action.trigger 返回格式与 CardActionHandler 不同：
        // 需要用 { card: { type: "raw", data: ... } } 包装
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

  logger.info('Feishu EventDispatcher created with im.message.receive_v1 + card.action.trigger handlers');
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

  // 立即返回初始进度卡片
  return buildPipelineCard(record.prompt, 'plan', 1, 5, 0, undefined, undefined, pipelineId);
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
// 队列驱动：同一 thread 内串行执行，不同 thread 间可并行
// queueKey = rootId 存在时用 `chatId:rootId`，否则用 `chatId`
// ============================================================

function makeQueueKey(chatId: string, rootId?: string): string {
  return rootId ? `${chatId}:${rootId}` : chatId;
}

function processQueue(queueKey: string): void {
  const task = taskQueue.dequeue(queueKey);
  if (!task) return;

  executeClaudeTask(task.message, task.chatId, task.userId, task.messageId, task.rootId)
    .then(() => task.resolve('done'))
    .catch((err) => task.reject(err instanceof Error ? err : new Error(String(err))))
    .finally(() => {
      taskQueue.complete(queueKey);
      // 处理队列中的下一个任务
      processQueue(queueKey);
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
      const progressCard = buildPipelineCard(pending.prompt, 'plan', 1, 5, 0, undefined, undefined, pending.id);
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
  mentionedBot: boolean;
  rootId?: string;
}

/**
 * 处理消息事件 (由 EventDispatcher 回调)
 */
async function handleMessageEvent(data: MessageEventData): Promise<void> {
  const parsed = parseMessage(data);
  if (!parsed) return;

  // 消息去重：飞书可能在未及时收到响应时重试推送
  if (isDuplicate(parsed.messageId)) {
    logger.debug({ messageId: parsed.messageId }, 'Duplicate message ignored');
    return;
  }

  const { text, messageId, userId, chatId, chatType, mentionedBot, rootId } = parsed;

  logger.info({ userId, chatId, chatType, rootId, text: text.slice(0, 100) }, 'Received message');

  // 群聊中需要 @机器人 才响应
  if (chatType === 'group' && !mentionedBot) {
    return;
  }

  // 用户权限检查
  if (!isUserAllowed(userId)) {
    logger.warn({ userId }, 'Unauthorized user');
    await feishuClient.replyText(messageId, '⚠️ 你没有权限使用此机器人');
    return;
  }

  // 处理斜杠命令
  const commandResult = await handleSlashCommand(text, chatId, userId, messageId, rootId);
  if (commandResult) return;

  // 处理管道消息确认（卡片按钮的文本 fallback）
  const pipelineHandled = await handlePipelineTextConfirm(text, chatId, userId);
  if (pipelineHandled) return;

  // 处理审批文本命令（owner 回复 "允许"/"拒绝"）
  if (handleApprovalTextCommand(text, userId, chatId, rootId)) return;

  // 非 owner 用户审批检查（per-thread：首条消息需审批，审批后同 thread 自动放行）
  const session = sessionManager.get(chatId, userId);
  const threadIdForApproval = rootId || session?.threadId;
  const approved = await checkAndRequestApproval(
    userId, chatId, chatType, text, messageId,
    rootId, rootId, threadIdForApproval,
  );
  if (!approved) return;

  // 安全检查
  if (containsDangerousCommand(text)) {
    await feishuClient.replyText(messageId, '⚠️ 检测到危险命令，已拒绝执行');
    return;
  }

  // 通过 taskQueue 串行化执行：同一 thread 内串行，不同 thread 可并行
  // enqueue 返回的 Promise 的错误处理在 processQueue/executeClaudeTask 中完成
  const queueKey = makeQueueKey(chatId, rootId);
  taskQueue.enqueue(queueKey, chatId, userId, text, messageId, rootId).catch(() => {});
  processQueue(queueKey);
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
): Promise<boolean> {
  const trimmed = text.trim();

  // 获取当前会话的话题锚点消息 ID（用于将命令响应发到话题内）
  // 如果用户在话题内发消息，优先使用该话题的 rootId
  const currentSession = sessionManager.get(chatId, userId);
  const threadRootMsgId = rootId || currentSession?.threadRootMessageId;

  // /project <path> - 切换工作目录
  if (trimmed.startsWith('/project ')) {
    const dir = trimmed.slice('/project '.length).trim();
    // 安全校验：路径必须在允许的基目录下（用 realpathSync 跟踪 symlink）
    const { resolve } = await import('node:path');
    const { existsSync, realpathSync } = await import('node:fs');
    const resolved = resolve(dir);
    if (!existsSync(resolved)) {
      const reply = `⚠️ 路径不存在: ${dir}`;
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, reply);
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
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }
    sessionManager.getOrCreate(chatId, userId);
    sessionManager.setWorkingDir(chatId, userId, realResolved);
    const reply = `📂 工作目录已切换到: ${realResolved}`;
    if (threadRootMsgId) {
      await feishuClient.replyTextInThread(threadRootMsgId, reply);
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
    if (threadRootMsgId) {
      await feishuClient.replyCardInThread(threadRootMsgId, card);
    } else {
      await feishuClient.sendCard(chatId, card);
    }
    return true;
  }

  // /reset - 重置会话
  if (trimmed === '/reset') {
    claudeExecutor.killSessionsForChat(chatId, userId);
    // 先在旧话题内回复确认，再清除 session
    const reply = '🔄 会话已重置';
    if (threadRootMsgId) {
      await feishuClient.replyTextInThread(threadRootMsgId, reply);
    } else {
      await feishuClient.replyText(messageId, reply);
    }
    sessionManager.reset(chatId, userId);
    return true;
  }

  // /stop - 中断执行
  if (trimmed === '/stop') {
    claudeExecutor.killSessionsForChat(chatId, userId);
    taskQueue.cancelAllForChat(chatId);
    sessionManager.setStatus(chatId, userId, 'idle');
    const reply = '🛑 已中断当前会话的执行';
    if (threadRootMsgId) {
      await feishuClient.replyTextInThread(threadRootMsgId, reply);
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
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, reply);
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
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const reply = `❌ 工作区创建失败: ${errorMsg}`;
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, reply);
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
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, reply);
      } else {
        await feishuClient.replyText(messageId, reply);
      }
      return true;
    }
    const task = trimmed.slice('/dev '.length).trim();
    if (!task) {
      const reply = '⚠️ 用法: `/dev <开发任务描述>`';
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, reply);
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
    await executePipelineTask(task, chatId, userId, messageId, rootId);
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
      '`/status` - 查看当前会话状态',
      '`/reset` - 重置会话',
      '`/stop` - 中断当前执行',
      '`/help` - 显示此帮助',
      '',
      '**自动工作区:** 直接发消息包含仓库 URL，Claude 会自动创建隔离工作区。',
    ].join('\n');
    if (threadRootMsgId) {
      await feishuClient.replyTextInThread(threadRootMsgId, helpText);
    } else {
      await feishuClient.replyText(messageId, helpText);
    }
    return true;
  }

  return false;
}

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
): Promise<void> {
  // prompt 可被路由追问流程替换为原始请求（用户的路由回复如 "1" 不作为任务 prompt）
  let prompt = rawPrompt;

  // sessionKey 包含 rootId，per-thread 并行时各 query 有独立的 key
  const sessionKey = rootId ? `${chatId}:${userId}:${rootId}` : `${chatId}:${userId}`;

  // 确保话题存在，返回话题锚点消息 ID 和问候卡片消息 ID
  const { threadRootMsgId, greetingMsgId } = await ensureThread(chatId, userId, messageId, rootId);
  const session = sessionManager.getOrCreate(chatId, userId);

  // 获取 thread 级别的 session（优先于全局 session 的 conversationId）
  const threadId = session.threadId;
  let threadSession = threadId ? sessionManager.getThreadSession(threadId) : undefined;

  // 确保 thread_sessions 中有该 thread 的记录（首条消息时创建）
  // 必须在 consumePreApproved 之前，否则 setThreadApproved 的 UPDATE 会命中空表
  if (threadId && !threadSession) {
    sessionManager.upsertThreadSession(threadId, chatId, userId, session.workingDir);
    threadSession = sessionManager.getThreadSession(threadId);
  }

  // 如果用户是预审批通过的（审批时 thread 尚未创建），将审批持久化到 thread
  if (threadId && consumePreApproved(chatId, userId)) {
    sessionManager.setThreadApproved(threadId, true);
  }

  // 刷新 thread session 的 updated_at，防止活跃 thread 被 cleanup 清理
  if (threadId && threadSession) {
    sessionManager.touchThreadSession(threadId);
  }

  // ============================================================
  // Routing Agent：决定工作目录
  // ============================================================
  let workingDir: string;
  const needsRouting = (threadId && threadSession?.routingState?.status === 'pending_clarification')
    || (threadId && !threadSession?.routingCompleted);

  // 路由可能耗时较长，先给用户发送即时反馈
  if (needsRouting && threadRootMsgId) {
    await feishuClient.replyTextInThread(threadRootMsgId, '🔍 正在分析工作目录...');
  }

  if (threadId && threadSession?.routingState?.status === 'pending_clarification') {
    const retryCount = threadSession.routingState.retryCount ?? 0;
    const MAX_ROUTING_RETRIES = 3;

    // 超过最大追问次数，放弃路由，使用默认目录
    if (retryCount >= MAX_ROUTING_RETRIES) {
      logger.warn({ chatId, userId, threadId, retryCount }, 'Routing clarification limit reached, using default workdir');
      workingDir = config.claude.defaultWorkDir;
      sessionManager.clearThreadRoutingState(threadId);
      sessionManager.setThreadWorkingDir(threadId, workingDir);
      sessionManager.markThreadRoutingCompleted(threadId);
      threadSession = sessionManager.getThreadSession(threadId);
      // 继续执行主查询，不 return
    } else {
      // 用户回复了路由问题，拼接上下文重新路由
      const context = [
        `[原始请求] ${threadSession.routingState.originalPrompt}`,
        `[路由问题] ${threadSession.routingState.question}`,
        `[用户回复] ${prompt}`,
      ].join('\n');

      logger.info({ chatId, userId, threadId, retryCount }, 'Re-routing with clarification context');
      const decision = await routeWorkspace(context, chatId, userId, rootId);

      if (decision.decision === 'need_clarification') {
        // 再次需要澄清，更新 routingState（递增 retryCount）
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
        return;
      }

      workingDir = decision.workdir || config.claude.defaultWorkDir;
      // 确保工作区隔离：use_existing 指向源仓库时自动 clone 到独立工作区
      try {
        workingDir = ensureIsolatedWorkspace(workingDir, decision.mode || 'writable');
      } catch (err) {
        const errorMsg = `❌ 无法创建隔离工作区: ${(err as Error).message}`;
        if (threadRootMsgId) {
          await feishuClient.replyTextInThread(threadRootMsgId, errorMsg);
        } else {
          await feishuClient.replyText(messageId, errorMsg);
        }
        return;
      }
      // 路由成功后恢复原始请求作为主查询 prompt（用户的路由回复如 "1" 不应作为任务 prompt）
      prompt = threadSession.routingState.originalPrompt;
      sessionManager.clearThreadRoutingState(threadId);
      sessionManager.setThreadWorkingDir(threadId, workingDir);
      sessionManager.markThreadRoutingCompleted(threadId);
      // 重新读取 threadSession 以获得更新后的数据
      threadSession = sessionManager.getThreadSession(threadId);
    }

  } else if (threadId && !threadSession?.routingCompleted && !threadSession?.conversationId) {
    // Thread 首条消息（路由尚未完成，且无已有会话），需要路由
    logger.info({ chatId, userId, threadId }, 'First message in thread, running routing agent');
    const decision = await routeWorkspace(prompt, chatId, userId, rootId);

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
      return;
    }

    workingDir = decision.workdir || config.claude.defaultWorkDir;
    // 确保工作区隔离：use_existing 指向源仓库时自动 clone 到独立工作区
    try {
      workingDir = ensureIsolatedWorkspace(workingDir, decision.mode || 'writable');
    } catch (err) {
      const errorMsg = `❌ 无法创建隔离工作区: ${(err as Error).message}`;
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, errorMsg);
      } else {
        await feishuClient.replyText(messageId, errorMsg);
      }
      return;
    }
    sessionManager.setThreadWorkingDir(threadId, workingDir);
    sessionManager.markThreadRoutingCompleted(threadId);
    // 同步更新全局 session 的 workingDir
    sessionManager.setWorkingDir(chatId, userId, workingDir);
    // 重新读取 threadSession
    threadSession = sessionManager.getThreadSession(threadId);

  } else {
    // Thread 后续消息，使用已绑定的 workdir
    workingDir = threadSession?.workingDir ?? session.workingDir;
  }

  // 过期工作区检测：如果自动创建的工作区目录已被清理，通知用户开新话题
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
    return;
  }

  // 更新问候卡片：显示话题 ID 和工作目录（仅新建话题时有 greetingMsgId）
  if (greetingMsgId && threadId) {
    feishuClient.updateCard(
      greetingMsgId,
      buildGreetingCardReady(threadId, workingDir),
    ).catch((err) => {
      logger.warn({ err }, 'Failed to update greeting card');
    });
  }

  // 发送初始进度卡片（即时反馈），后续原地更新为 tool call 进度卡片
  let progressCardMsgId: string | undefined;
  let progressCardFailed = false;
  if (threadRootMsgId) {
    progressCardMsgId = await feishuClient.replyCardInThread(
      threadRootMsgId, buildProgressCard(prompt),
    ) ?? undefined;
    if (!progressCardMsgId) progressCardFailed = true;
  } else {
    await feishuClient.replyText(messageId, '🤖 处理中...');
  }

  // 标记会话为忙碌
  sessionManager.setStatus(chatId, userId, 'busy');

  // 构建历史上下文：仅 pipeline thread 注入 pipeline 上下文，其他场景不注入
  // （不同 thread 通常是不同项目/话题，全局摘要反而是噪声）
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
    // 限制 ~10000 tokens ≈ 30000 chars
    if (combined.length > 30000) {
      combined = combined.slice(0, 30000) + '\n\n[摘要已截断]';
    }
    historySummaries = combined;
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
    sessionManager.setWorkingDir(chatId, userId, newDir);
    logger.info({ chatId, userId, newDir }, 'Workspace changed via MCP tool');
  };

  const onProgress = (message: import('@anthropic-ai/claude-agent-sdk').SDKMessage) => {
    logger.debug({ messageType: message.type }, 'Claude SDK message');
  };

  try {
    // Resume 策略：有 threadId 时只用该 thread 自己的 conversationId，
    // 避免跨 thread 串台（如 pipeline thread 回退到另一 thread 的全局 session）。
    // 无 threadId（主聊天）时使用全局 session 的 conversationId。
    const activeConversationId = threadId
      ? threadSession?.conversationId
      : session.conversationId;
    const activeConversationCwd = threadId
      ? threadSession?.conversationCwd
      : session.conversationCwd;
    const canResume = activeConversationId
      && (!activeConversationCwd || activeConversationCwd === workingDir);
    if (activeConversationId && !canResume) {
      logger.info(
        { sessionKey, threadId, sessionId: activeConversationId, sessionCwd: activeConversationCwd, currentCwd: workingDir },
        'Skipping resume: cwd mismatch (workspace switched), starting fresh session',
      );
    }

    const readOnly = !isOwner(userId);

    const result = await claudeExecutor.execute({
      sessionKey,
      prompt,
      workingDir,
      readOnly,
      resumeSessionId: canResume ? activeConversationId : undefined,
      onProgress,
      onWorkspaceChanged,
      onTurn,
      historySummaries,
    });

    // 检测是否需要 restart（workspace 变更后重新执行以加载 CLAUDE.md）
    // 优先级高于 resume 失败检查：即使 query 失败，只要 workspace 已变更就应重启
    if (result.needsRestart && result.newWorkingDir) {
      logger.info(
        { chatId, userId, newWorkingDir: result.newWorkingDir },
        'Workspace changed, restarting query with new cwd',
      );

      // 检查 session 是否已被用户 /stop 中断
      const currentSession = sessionManager.get(chatId, userId);
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
          threadRootMsgId, chatId,
        );
        return;
      }

      // workspace 已变更：更新 thread session 的 workingDir，同时清空旧 conversationId
      // （S1 只做了 workspace setup，其 session 不应被 resume）
      if (threadId) {
        sessionManager.setThreadWorkingDir(threadId, result.newWorkingDir);
      }
      sessionManager.setConversationId(chatId, userId, '');

      // 第二次 query：以新 cwd 执行，CLAUDE.md 正确加载
      // - 不传 resumeSessionId（全新 session）
      // - 不传 onWorkspaceChanged（不触发二次 restart）
      // - disableWorkspaceTool: 完全移除 setup_workspace MCP tool，防止无限循环
      const restartResult = await claudeExecutor.execute({
        sessionKey,
        prompt,
        workingDir: result.newWorkingDir,
        readOnly,
        onProgress,
        onTurn,
        historySummaries,
        disableWorkspaceTool: true,
      });

      // 保存 restart query 的 session_id 到 thread session
      // 如果 restart query 失败未返回 sessionId，用第一次 query 的作为 fallback
      const finalSessionId = restartResult.sessionId || result.sessionId;
      if (finalSessionId) {
        if (threadId) {
          sessionManager.setThreadConversationId(threadId, finalSessionId, result.newWorkingDir);
        }
        sessionManager.setConversationId(chatId, userId, finalSessionId, result.newWorkingDir);
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
        threadRootMsgId, chatId, threadRootMsgId ? pendingTurn : undefined, turnCount,
      );
      return;
    }

    // Resume 失败（非 workspace 变更场景）：报错给用户，保留 session ID 不动
    // 用 !result.output 区分 resume 失败和正常 query 失败：
    //   - resume 失败：子进程秒退，无 output
    //   - 正常失败（超时、预算等）：有 output，应走 sendResultCard 展示部分结果
    if (!result.success && canResume && !result.output) {
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

      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, errorDetail);
      } else {
        await feishuClient.replyText(messageId, errorDetail);
      }
      return;
    }

    // 无 restart，正常流程：保存 session ID 用于下次 resume
    // 即使失败也保存——下次 resume 可能成功（如超时但 session 数据完整）
    if (result.sessionId) {
      if (threadId) {
        sessionManager.setThreadConversationId(threadId, result.sessionId, workingDir);
      }
      sessionManager.setConversationId(chatId, userId, result.sessionId, workingDir);
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
      threadRootMsgId, chatId, threadRootMsgId ? pendingTurn : undefined, turnCount,
    );

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
    if (threadRootMsgId) {
      await feishuClient.replyTextInThread(threadRootMsgId, errorReply);
    } else {
      await feishuClient.replyText(messageId, errorReply);
    }
  } finally {
    try {
      sessionManager.setStatus(chatId, userId, 'idle');
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to reset session status');
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
  threadRootMsgId: string | undefined,
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
  if (threadRootMsgId) {
    await feishuClient.replyCardInThread(threadRootMsgId, resultCard);
  } else {
    await feishuClient.sendCard(chatId, resultCard);
  }

  // 非逐条模式下，如果输出特别长，额外发送完整文本
  if (!lastTurn && result.output && result.output.length > 3000) {
    if (threadRootMsgId) {
      await feishuClient.replyTextInThread(threadRootMsgId, result.output);
    } else {
      await feishuClient.sendText(chatId, result.output);
    }
  }
}

/**
 * 执行自动开发管道（/dev 命令触发）
 * 创建待确认管道，等待用户卡片确认后再开始执行
 */
async function executePipelineTask(
  prompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
): Promise<void> {
  const session = sessionManager.getOrCreate(chatId, userId);
  await createPendingPipeline({
    chatId,
    userId,
    messageId,
    rootId,
    prompt,
    workingDir: session.workingDir,
  });
}

/**
 * 解析飞书消息 (使用 SDK 类型化的事件数据)
 */
function parseMessage(data: MessageEventData): ParsedMessage | null {
  const { message, sender } = data;

  // 只处理文本消息
  if (message.message_type !== 'text') {
    logger.debug({ messageType: message.message_type }, 'Ignoring non-text message');
    return null;
  }

  // 解析消息内容
  let text: string;
  try {
    const content = JSON.parse(message.content);
    text = content.text || '';
  } catch {
    logger.error({ content: message.content }, 'Failed to parse message content');
    return null;
  }

  // 清理 @mention 标记，检测是否 @了机器人
  let mentionedBot = false;
  const botOpenId = feishuClient.botOpenId;
  if (message.mentions) {
    for (const mention of message.mentions) {
      text = text.replace(mention.key, '').trim();
      if (botOpenId) {
        // botOpenId 已知：精确匹配
        if (mention.id.open_id === botOpenId) mentionedBot = true;
      } else {
        // botOpenId 未知（API 调用失败）：回退到旧行为
        mentionedBot = true;
      }
    }
  }

  if (!text.trim()) return null;

  return {
    text: text.trim(),
    messageId: message.message_id,
    userId: sender.sender_id?.open_id || '',
    chatId: message.chat_id,
    chatType: message.chat_type,
    mentionedBot,
    rootId: message.root_id || undefined,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m${remainSec}s`;
}
