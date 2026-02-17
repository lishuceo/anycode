import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../utils/logger.js';
import { isUserAllowed, containsDangerousCommand } from '../utils/security.js';
import { sessionManager } from '../session/manager.js';
import { taskQueue } from '../session/queue.js';
import { claudeExecutor } from '../claude/executor.js';
import { buildProgressCard, buildResultCard, buildStreamingCard, buildPipelineCard, buildStatusCard } from './message-builder.js';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { PHASE_META, TOTAL_PHASES } from '../pipeline/types.js';
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

  // 执行 Claude Agent
  await executeClaudeTask(text, chatId, userId, messageId, rootId);
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
 * 并发保护：检查会话是否正在执行，若是则回复用户并返回 true
 */
async function acquireSession(
  chatId: string,
  userId: string,
  messageId: string,
): Promise<boolean> {
  const session = sessionManager.getOrCreate(chatId, userId);
  if (session.status === 'busy') {
    await feishuClient.replyText(messageId, '⏳ 当前会话正在执行任务，请等待完成或使用 /stop 中断');
    return false;
  }
  // 立即标记为忙碌，防止 TOCTOU 竞态
  sessionManager.setStatus(chatId, userId, 'busy');
  return true;
}

/**
 * 执行 Claude Agent SDK 任务
 */
async function executeClaudeTask(
  prompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
): Promise<void> {
  if (!await acquireSession(chatId, userId, messageId)) return;

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

  try {
    // 调用 Claude Agent SDK
    const result = await claudeExecutor.execute({
      sessionKey,
      prompt,
      workingDir: session.workingDir,
      resumeSessionId: session.conversationId,
      onProgress: (message) => {
        logger.debug({ messageType: message.type }, 'Claude SDK message');
      },
      onWorkspaceChanged: (newDir: string) => {
        sessionManager.setWorkingDir(chatId, userId, newDir);
        logger.info({ chatId, userId, newDir }, 'Workspace changed via MCP tool');
      },
      onStreamUpdate,
      historySummaries,
    });

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
    } else if (threadRootMsgId) {
      await feishuClient.replyCardInThread(threadRootMsgId, resultCard);
    } else {
      await feishuClient.sendCard(chatId, resultCard);
    }

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

    // 如果输出特别长，额外发送完整文本
    if (result.output && result.output.length > 3000) {
      if (threadRootMsgId) {
        await feishuClient.replyTextInThread(threadRootMsgId, result.output);
      } else {
        await feishuClient.sendText(chatId, result.output);
      }
    }
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
 * 执行自动开发管道（/dev 命令触发）
 */
async function executePipelineTask(
  prompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
): Promise<void> {
  if (!await acquireSession(chatId, userId, messageId)) return;

  const session = sessionManager.getOrCreate(chatId, userId);
  const pipelineStartTime = Date.now();

  // 确保话题存在
  const threadRootMsgId = await ensureThread(chatId, userId, messageId, rootId);

  // 发送管道初始卡片
  let progressMsgId: string | undefined;
  const initialCard = buildPipelineCard(prompt, 'plan', 1, TOTAL_PHASES, 0);
  if (threadRootMsgId) {
    progressMsgId = await feishuClient.replyCardInThread(threadRootMsgId, initialCard);
  }
  if (!progressMsgId) {
    progressMsgId = await feishuClient.sendCard(chatId, initialCard);
  }

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

  try {
    const orchestrator = new PipelineOrchestrator();

    // 跟踪当前 phase 供 onStreamUpdate 使用
    let currentPipelinePhase: string = 'plan';
    let currentPhaseIndex = 1;

    const pipelineResult = await orchestrator.run(
      prompt,
      session.workingDir,
      {
        onPhaseChange: async (state) => {
          currentPipelinePhase = state.phase;
          currentPhaseIndex = PHASE_META[state.phase]?.index ?? currentPhaseIndex;
          if (!progressMsgId) return;
          const elapsed = Math.floor((Date.now() - pipelineStartTime) / 1000);
          await feishuClient.updateCard(
            progressMsgId,
            buildPipelineCard(
              prompt,
              state.phase,
              currentPhaseIndex,
              TOTAL_PHASES,
              elapsed,
              state.totalCostUsd || undefined,
            ),
          );
        },
        onStreamUpdate: async (text: string) => {
          if (!progressMsgId) return;
          const elapsed = Math.floor((Date.now() - pipelineStartTime) / 1000);
          // 使用 pipeline 卡片 + detail 区域展示流式输出，保留阶段进度
          const tail = text.length > 2000 ? '...\n' + text.slice(-2000) : text;
          await feishuClient.updateCard(
            progressMsgId,
            buildPipelineCard(prompt, currentPipelinePhase, currentPhaseIndex, TOTAL_PHASES, elapsed, undefined, tail),
          );
        },
      },
      historySummaries,
    );

    // 最终结果卡片
    const totalElapsed = Math.floor((Date.now() - pipelineStartTime) / 1000);
    const costStr = pipelineResult.totalCostUsd
      ? ` | 💰 $${pipelineResult.totalCostUsd.toFixed(4)}`
      : '';

    // 失败时用 failedAtPhase 定位实际失败的阶段
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
        const summary = `[${date}] [pipeline] dir: ${session.workingDir} | ${tail}`;
        sessionManager.saveSummary(chatId, userId, session.workingDir, summary);
      } catch (err) {
        logger.warn({ err }, 'Failed to save pipeline summary');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error executing pipeline');
    await feishuClient.replyText(messageId, `❌ 管道执行出错: ${(err as Error).message}`);
  } finally {
    try {
      sessionManager.setStatus(chatId, userId, 'idle');
    } catch (err) {
      logger.error({ err, chatId, userId }, 'Failed to reset session status');
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
