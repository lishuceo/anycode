import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../utils/logger.js';
import { isUserAllowed, containsDangerousCommand } from '../utils/security.js';
import { sessionManager } from '../session/manager.js';
import { taskQueue } from '../session/queue.js';
import { claudeExecutor } from '../claude/executor.js';
import { buildProgressCard, buildResultCard, buildStreamingCard, buildStatusCard, buildCancelledCard, buildPipelineCard, buildPipelineConfirmCard } from './message-builder.js';
import { feishuClient } from './client.js';
import { config } from '../config.js';
import { setupWorkspace } from '../workspace/manager.js';
import { ensureThread } from './thread-utils.js';
import { pipelineStore } from '../pipeline/store.js';
import {
  createPendingPipeline,
  startPipeline,
  abortPipeline,
  cancelPipeline,
  retryPipeline,
} from '../pipeline/runner.js';

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

  logger.info('Feishu EventDispatcher created with im.message.receive_v1 handler');
  return dispatcher;
}

/**
 * 创建飞书卡片交互处理器
 */
export function createCardActionHandler(): lark.CardActionHandler {
  const handler = new lark.CardActionHandler({
    encryptKey: config.feishu.encryptKey || undefined,
    verificationToken: config.feishu.verifyToken || undefined,
  }, async (data: Record<string, unknown>) => {
    const action = data.action as { value?: Record<string, unknown> } | undefined;
    const actionType = action?.value?.action as string | undefined;
    const pipelineId = action?.value?.pipelineId as string | undefined;

    // 提取操作者 user ID
    const operatorId = (data.operator as { open_id?: string } | undefined)?.open_id;

    logger.info({ actionType, pipelineId, operatorId }, 'Card action received');

    if (!actionType || !pipelineId) return {};

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
  });

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
// 队列驱动：确保同一 chat 的 query 串行执行
// ============================================================

function processQueue(chatId: string): void {
  const task = taskQueue.dequeue(chatId);
  if (!task) return;

  executeClaudeTask(task.message, task.chatId, task.userId, task.messageId, task.rootId)
    .then(() => task.resolve('done'))
    .catch((err) => task.reject(err instanceof Error ? err : new Error(String(err))))
    .finally(() => {
      taskQueue.complete(chatId);
      // 处理队列中的下一个任务
      processQueue(chatId);
    });
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

  // 安全检查
  if (containsDangerousCommand(text)) {
    await feishuClient.replyText(messageId, '⚠️ 检测到危险命令，已拒绝执行');
    return;
  }

  // 通过 taskQueue 串行化执行，确保同一 chat 同一时间只有一个 query
  // enqueue 返回的 Promise 的错误处理在 processQueue/executeClaudeTask 中完成
  taskQueue.enqueue(chatId, userId, text, messageId, rootId).catch(() => {});
  processQueue(chatId);
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
      taskQueue.pendingCount(chatId),
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
    const sessionKey = `${chatId}:${userId}`;
    claudeExecutor.killSession(sessionKey);
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
    const sessionKey = `${chatId}:${userId}`;
    claudeExecutor.killSession(sessionKey);
    taskQueue.cancelPending(chatId);
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
 */
async function executeClaudeTask(
  prompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
): Promise<void> {
  const sessionKey = `${chatId}:${userId}`;

  // 确保话题存在，返回话题锚点消息 ID
  // ensureThread 在新话题场景下会清空 conversationId，需要之后重新读取 session
  const threadRootMsgId = await ensureThread(chatId, userId, messageId, rootId);
  const session = sessionManager.getOrCreate(chatId, userId);

  // 发送 "处理中" 卡片（优先发到话题内）
  let progressMsgId: string | undefined;
  if (threadRootMsgId) {
    progressMsgId = await feishuClient.replyCardInThread(threadRootMsgId, buildProgressCard(prompt));
  }
  if (!progressMsgId) {
    progressMsgId = await feishuClient.sendCard(chatId, buildProgressCard(prompt));
  }

  // 标记会话为忙碌
  sessionManager.setStatus(chatId, userId, 'busy');

  // 获取历史摘要用于注入 system prompt
  const summaries = sessionManager.getRecentSummaries(chatId, userId, 5);
  let historySummaries: string | undefined;
  if (summaries.length > 0) {
    let combined = summaries.join('\n');
    if (combined.length > 3000) {
      combined = combined.slice(-3000);
    }
    historySummaries = combined;
  }

  // 构造流式卡片更新回调
  const executeStartTime = Date.now();
  const onStreamUpdate = async (text: string) => {
    if (!progressMsgId) return;
    const elapsed = Math.floor((Date.now() - executeStartTime) / 1000);
    await feishuClient.updateCard(progressMsgId, buildStreamingCard(prompt, text, elapsed));
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
    // 第一次 query：可能触发 workspace setup
    const result = await claudeExecutor.execute({
      sessionKey,
      prompt,
      workingDir: session.workingDir,
      resumeSessionId: session.conversationId,
      onProgress,
      onWorkspaceChanged,
      onStreamUpdate,
      historySummaries,
    });

    // 检测是否需要 restart（workspace 变更后重新执行以加载 CLAUDE.md）
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
          progressMsgId, threadRootMsgId, chatId,
        );
        return;
      }

      // 清空残留的 conversationId，避免指向只做了 workspace setup 的短 session
      sessionManager.setConversationId(chatId, userId, '');

      // 更新进度卡片
      if (progressMsgId) {
        await feishuClient.updateCard(progressMsgId, buildProgressCard(prompt, '正在加载项目配置...'));
      }

      // 第二次 query：以新 cwd 执行，CLAUDE.md 正确加载
      // - 不传 resumeSessionId（全新 session）
      // - 不传 onWorkspaceChanged（不触发二次 restart）
      // - disableWorkspaceTool: 完全移除 setup_workspace MCP tool，防止无限循环
      const restartResult = await claudeExecutor.execute({
        sessionKey,
        prompt,
        workingDir: result.newWorkingDir,
        onProgress,
        onStreamUpdate,
        historySummaries,
        disableWorkspaceTool: true,
      });

      // 保存 restart query 的 session_id 用于下次续接
      // 如果 restart query 失败未返回 sessionId，用第一次 query 的作为 fallback
      const finalSessionId = restartResult.sessionId || result.sessionId;
      if (finalSessionId) {
        sessionManager.setConversationId(chatId, userId, finalSessionId);
      }

      // 合并两次 query 的耗时和花费
      const totalDurationMs = result.durationMs + restartResult.durationMs;
      const totalCostUsd = (result.costUsd ?? 0) + (restartResult.costUsd ?? 0);

      await sendResultCard(
        prompt, restartResult, totalDurationMs, totalCostUsd,
        progressMsgId, threadRootMsgId, chatId,
      );
      return;
    }

    // 无 restart，正常流程
    if (result.sessionId) {
      sessionManager.setConversationId(chatId, userId, result.sessionId);
    }

    await sendResultCard(
      prompt, result, result.durationMs, result.costUsd,
      progressMsgId, threadRootMsgId, chatId,
    );

    // 保存会话摘要（取输出末尾 500 字符作为摘要）
    if (result.success && result.output && result.output.length > 100) {
      try {
        const date = new Date().toISOString().slice(0, 10);
        const tail = result.output.slice(-500).trim();
        const summary = `[${date}] dir: ${session.workingDir} | ${tail}`;
        sessionManager.saveSummary(chatId, userId, session.workingDir, summary);
      } catch (err) {
        logger.warn({ err }, 'Failed to save session summary');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error executing Claude Agent SDK query');
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
  progressMsgId: string | undefined,
  threadRootMsgId: string | undefined,
  chatId: string,
): Promise<void> {
  const durationStr = formatDuration(totalDurationMs);
  const costInfo = totalCostUsd
    ? ` | 💰 $${totalCostUsd.toFixed(4)}`
    : '';

  const resultCard = buildResultCard(
    prompt,
    result.output || result.error || '(无输出)',
    result.success,
    durationStr + costInfo,
  );

  if (progressMsgId) {
    await feishuClient.updateCard(progressMsgId, resultCard);
  } else if (threadRootMsgId) {
    await feishuClient.replyCardInThread(threadRootMsgId, resultCard);
  } else {
    await feishuClient.sendCard(chatId, resultCard);
  }

  // 如果输出特别长，额外发送完整文本
  if (result.output && result.output.length > 3000) {
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

  // 清理 @mention 标记
  let mentionedBot = false;
  if (message.mentions) {
    for (const mention of message.mentions) {
      text = text.replace(mention.key, '').trim();
      mentionedBot = true;
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
