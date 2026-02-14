import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../utils/logger.js';
import { isUserAllowed, containsDangerousCommand } from '../utils/security.js';
import { sessionManager } from '../session/manager.js';
import { taskQueue } from '../session/queue.js';
import { claudeExecutor } from '../claude/executor.js';
import { buildProgressCard, buildResultCard, buildStatusCard } from './message-builder.js';
import { feishuClient } from './client.js';
import { config } from '../config.js';

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
}

/**
 * 处理消息事件 (由 EventDispatcher 回调)
 */
async function handleMessageEvent(data: MessageEventData): Promise<void> {
  const parsed = parseMessage(data);
  if (!parsed) return;

  const { text, messageId, userId, chatId, chatType, mentionedBot } = parsed;

  logger.info({ userId, chatId, chatType, text: text.slice(0, 100) }, 'Received message');

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
  const commandResult = await handleSlashCommand(text, chatId, userId, messageId);
  if (commandResult) return;

  // 安全检查
  if (containsDangerousCommand(text)) {
    await feishuClient.replyText(messageId, '⚠️ 检测到危险命令，已拒绝执行');
    return;
  }

  // 执行 Claude Agent
  await executeClaudeTask(text, chatId, userId, messageId);
}

/**
 * 处理斜杠命令
 */
async function handleSlashCommand(
  text: string,
  chatId: string,
  userId: string,
  messageId: string,
): Promise<boolean> {
  const trimmed = text.trim();

  // /project <path> - 切换工作目录
  if (trimmed.startsWith('/project ')) {
    const dir = trimmed.slice('/project '.length).trim();
    sessionManager.setWorkingDir(chatId, userId, dir);
    await feishuClient.replyText(messageId, `📂 工作目录已切换到: ${dir}`);
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
    await feishuClient.sendCard(chatId, card);
    return true;
  }

  // /reset - 重置会话
  if (trimmed === '/reset') {
    const sessionKey = `${chatId}:${userId}`;
    claudeExecutor.killSession(sessionKey);
    sessionManager.reset(chatId, userId);
    await feishuClient.replyText(messageId, '🔄 会话已重置');
    return true;
  }

  // /stop - 中断执行
  if (trimmed === '/stop') {
    const sessionKey = `${chatId}:${userId}`;
    claudeExecutor.killSession(sessionKey);
    taskQueue.cancelPending(chatId);
    sessionManager.setStatus(chatId, userId, 'idle');
    await feishuClient.replyText(messageId, '🛑 已中断当前会话的执行');
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
      '`/status` - 查看当前会话状态',
      '`/reset` - 重置会话',
      '`/stop` - 中断当前执行',
      '`/help` - 显示此帮助',
    ].join('\n');
    await feishuClient.replyText(messageId, helpText);
    return true;
  }

  return false;
}

/**
 * 执行 Claude Agent SDK 任务
 */
async function executeClaudeTask(
  prompt: string,
  chatId: string,
  userId: string,
  messageId: string,
): Promise<void> {
  const session = sessionManager.getOrCreate(chatId, userId);
  const sessionKey = `${chatId}:${userId}`;

  // 发送 "处理中" 卡片
  const progressMsgId = await feishuClient.sendCard(
    chatId,
    buildProgressCard(prompt),
  );

  // 标记会话为忙碌
  sessionManager.setStatus(chatId, userId, 'busy');

  try {
    // 调用 Claude Agent SDK
    const result = await claudeExecutor.execute(
      sessionKey,
      prompt,
      session.workingDir,
      session.conversationId,
      (message) => {
        logger.debug({ messageType: message.type }, 'Claude SDK message');
      },
    );

    // 保存 SDK session_id 用于下次续接
    if (result.sessionId) {
      sessionManager.setConversationId(chatId, userId, result.sessionId);
    }

    // 格式化耗时和花费
    const durationStr = formatDuration(result.durationMs);
    const costInfo = result.costUsd
      ? ` | 💰 $${result.costUsd.toFixed(4)}`
      : '';

    // 更新卡片为结果
    const resultCard = buildResultCard(
      prompt,
      result.output || result.error || '(无输出)',
      result.success,
      durationStr + costInfo,
    );

    if (progressMsgId) {
      await feishuClient.updateCard(progressMsgId, resultCard);
    } else {
      await feishuClient.sendCard(chatId, resultCard);
    }

    // 如果输出特别长，额外发送完整文本
    if (result.output && result.output.length > 3000) {
      await feishuClient.sendText(chatId, result.output);
    }
  } catch (err) {
    logger.error({ err }, 'Error executing Claude Agent SDK query');
    await feishuClient.replyText(messageId, `❌ 执行出错: ${(err as Error).message}`);
  } finally {
    sessionManager.setStatus(chatId, userId, 'idle');
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
