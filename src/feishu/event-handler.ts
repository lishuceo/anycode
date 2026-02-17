import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../utils/logger.js';
import { isUserAllowed, containsDangerousCommand } from '../utils/security.js';
import { sessionManager } from '../session/manager.js';
import { taskQueue } from '../session/queue.js';
import { claudeExecutor } from '../claude/executor.js';
import { buildProgressCard, buildResultCard, buildStatusCard } from './message-builder.js';
import { feishuClient } from './client.js';
import { config } from '../config.js';
import { setupWorkspace } from '../workspace/manager.js';

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
    logger.debug({ action: data }, 'Card action received');
    // TODO: 处理卡片按钮点击等交互
    return {};
  });

  return handler;
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
    sessionManager.getOrCreate(chatId, userId);
    sessionManager.setWorkingDir(chatId, userId, dir);
    const reply = `📂 工作目录已切换到: ${dir}`;
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
 * 确保会话有话题，如果没有则创建一个
 * 返回 threadRootMessageId (用于后续 reply_in_thread)，失败返回 undefined
 */
async function ensureThread(
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
): Promise<string | undefined> {
  const session = sessionManager.getOrCreate(chatId, userId);

  // 1. 用户在已有话题内发消息 — 直接复用该话题，无需发送问候
  if (rootId) {
    // 更新 session 的话题信息，确保后续回复也发到这个话题
    sessionManager.setThread(chatId, userId, rootId, rootId);
    return rootId;
  }

  // 2. session 已有话题信息（用户在话题外发消息，但之前的话题仍在）
  if (session.threadId && session.threadRootMessageId) {
    return session.threadRootMessageId;
  }

  // 3. 全新场景 — 创建话题，根据是否有 conversationId 判断是新建还是恢复
  const isResumed = !!session.conversationId;
  const greeting = isResumed ? '🤖 会话已恢复' : '🤖 新会话已创建';
  const { messageId: botMsgId, threadId } = await feishuClient.replyInThread(
    messageId,
    greeting,
  );

  if (threadId && botMsgId) {
    // 保存用户原始消息 ID 作为话题锚点（话题附着在此消息上）
    sessionManager.setThread(chatId, userId, threadId, messageId);
    return messageId;
  }

  logger.warn({ chatId, userId }, 'Failed to create thread, falling back to main chat');
  return undefined;
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
  const session = sessionManager.getOrCreate(chatId, userId);
  const sessionKey = `${chatId}:${userId}`;

  // 确保话题存在，返回话题锚点消息 ID
  const threadRootMsgId = await ensureThread(chatId, userId, messageId, rootId);

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
    const result = await claudeExecutor.execute(
      sessionKey,
      prompt,
      session.workingDir,
      session.conversationId,
      onProgress,
      onWorkspaceChanged,
    );

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
      const restartResult = await claudeExecutor.execute(
        sessionKey,
        prompt,
        result.newWorkingDir,
        undefined,
        onProgress,
        undefined,
        { disableWorkspaceTool: true },
      );

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
  } catch (err) {
    logger.error({ err }, 'Error executing Claude Agent SDK query');
    await feishuClient.replyText(messageId, `❌ 执行出错: ${(err as Error).message}`);
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
