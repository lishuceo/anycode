import { logger } from '../utils/logger';
import { isUserAllowed, containsDangerousCommand } from '../utils/security';
import { sessionManager } from '../session/manager';
import { taskQueue } from '../session/queue';
import { claudeExecutor } from '../claude/executor';
import { buildProgressCard, buildResultCard, buildStatusCard } from './message-builder';
import { feishuClient } from './client';
import type { FeishuEventBody, FeishuMessageEvent, ParsedMessage } from './types';

/** 已处理的事件 ID 集合 (去重) */
const processedEvents = new Set<string>();
const MAX_PROCESSED_EVENTS = 10000;

/**
 * 处理飞书事件回调
 */
export async function handleFeishuEvent(body: FeishuEventBody): Promise<Record<string, unknown> | null> {
  // 1. 处理 URL 验证请求
  if (body.challenge) {
    logger.info('Received URL verification challenge');
    return { challenge: body.challenge };
  }

  // 2. 事件去重
  const eventId = body.header?.event_id;
  if (eventId) {
    if (processedEvents.has(eventId)) {
      logger.debug({ eventId }, 'Duplicate event, skipping');
      return null;
    }
    processedEvents.add(eventId);
    // 防止内存泄漏
    if (processedEvents.size > MAX_PROCESSED_EVENTS) {
      const iter = processedEvents.values();
      for (let i = 0; i < MAX_PROCESSED_EVENTS / 2; i++) {
        processedEvents.delete(iter.next().value!);
      }
    }
  }

  // 3. 处理消息事件
  const eventType = body.header?.event_type;
  if (eventType === 'im.message.receive_v1' && body.event) {
    await handleMessageEvent(body.event);
  } else {
    logger.debug({ eventType }, 'Unhandled event type');
  }

  return null;
}

/**
 * 处理消息事件
 */
async function handleMessageEvent(event: FeishuMessageEvent): Promise<void> {
  const parsed = parseMessage(event);
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

  // 执行 Claude Code
  await executeClaudeTask(text, chatId, userId, messageId);
}

/**
 * 处理斜杠命令
 * @returns true 如果是斜杠命令且已处理
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
    sessionManager.reset(chatId, userId);
    await feishuClient.replyText(messageId, '🔄 会话已重置');
    return true;
  }

  // /stop - 中断执行
  if (trimmed === '/stop') {
    claudeExecutor.killAll();
    taskQueue.cancelPending(chatId);
    sessionManager.setStatus(chatId, userId, 'idle');
    await feishuClient.replyText(messageId, '🛑 已中断所有执行中的任务');
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
 * 执行 Claude Code 任务
 */
async function executeClaudeTask(
  prompt: string,
  chatId: string,
  userId: string,
  messageId: string,
): Promise<void> {
  const session = sessionManager.getOrCreate(chatId, userId);

  // 发送 "处理中" 卡片
  const progressMsgId = await feishuClient.sendCard(
    chatId,
    buildProgressCard(prompt),
  );

  // 标记会话为忙碌
  sessionManager.setStatus(chatId, userId, 'busy');

  try {
    // 执行 Claude Code
    const result = await claudeExecutor.execute(
      prompt,
      session.workingDir,
      session.conversationId,
      // 进度回调 - 可用于更新卡片
      (event) => {
        logger.debug({ eventType: event.type, subtype: event.subtype }, 'Claude stream event');
      },
    );

    // 保存会话 ID
    if (result.conversationId) {
      sessionManager.setConversationId(chatId, userId, result.conversationId);
    }

    // 格式化耗时
    const durationStr = formatDuration(result.durationMs);

    // 更新卡片为结果
    const resultCard = buildResultCard(
      prompt,
      result.output || result.error || '(无输出)',
      result.success,
      durationStr,
      result.timedOut,
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
    logger.error({ err }, 'Error executing Claude Code task');
    await feishuClient.replyText(messageId, `❌ 执行出错: ${(err as Error).message}`);
  } finally {
    sessionManager.setStatus(chatId, userId, 'idle');
  }
}

/**
 * 解析飞书消息
 */
function parseMessage(event: FeishuMessageEvent): ParsedMessage | null {
  const { message, sender } = event;

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
      // @机器人 的 key 格式为 @_user_1 等
      text = text.replace(mention.key, '').trim();
      // 判断是否 @了机器人 (sender_type 为 app 或 bot)
      mentionedBot = true;
    }
  }

  if (!text.trim()) return null;

  return {
    text: text.trim(),
    messageId: message.message_id,
    userId: sender.sender_id.open_id,
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
