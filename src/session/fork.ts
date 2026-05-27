import { randomBytes, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { feishuClient } from '../feishu/client.js';
import { sessionManager } from './manager.js';
import { copyJsonlAtomic, resolveSessionJsonlPath, jsonlFingerprint } from './jsonl-fork.js';

/** Fork 失败的原因码（供命令层做差异化提示） */
export type ForkFailureReason =
  | 'no_parent_thread'
  | 'parent_not_found'
  | 'no_conversation'
  | 'scenario_a_not_supported_yet'
  | 'parent_jsonl_missing'
  | 'feishu_thread_create_failed'
  | 'unknown';

export interface ForkResult {
  ok: true;
  newThreadId: string;
  newConversationId: string;
  newRootMessageId?: string;
  shortId: string;
  workingDir: string;
}

export interface ForkError {
  ok: false;
  reason: ForkFailureReason;
  message: string;
}

export interface ForkOptions {
  parentThreadId: string;
  chatId: string;
  userId: string;
  /** 原话题中 /fork 那条消息的 ID（用于发送状态反馈） */
  triggerMessageId: string;
  description?: string;
  agentId?: string;
}

function generateShortId(): string {
  return randomBytes(2).toString('hex');
}

/**
 * 执行 Session Fork。P0a 仅支持「共享 DEFAULT_WORK_DIR」场景。
 * 已 setup_workspace 的会话目前直接拒绝，等 P0b 用 worktree+stash 落地。
 */
export async function forkSession(opts: ForkOptions): Promise<ForkResult | ForkError> {
  const agentId = opts.agentId ?? 'dev';
  const parent = sessionManager.getThreadSession(opts.parentThreadId, agentId);
  if (!parent) {
    return { ok: false, reason: 'parent_not_found', message: '当前话题没有 session 记录，无法 fork' };
  }
  if (!parent.conversationId || !parent.conversationCwd) {
    return {
      ok: false,
      reason: 'no_conversation',
      message: '当前话题尚未与 Agent 交互过（没有 conversationId），fork 没有意义',
    };
  }

  const defaultDir = resolve(config.claude.defaultWorkDir);
  const parentDir = resolve(parent.workingDir);
  if (parentDir !== defaultDir) {
    return {
      ok: false,
      reason: 'scenario_a_not_supported_yet',
      message:
        '当前话题已 setup_workspace，P0a 暂不支持 fork（避免文件写冲突 / git 分支锁）。等 P0b 实现 worktree+stash 后再试。',
    };
  }

  const parentJsonl = resolveSessionJsonlPath(parent.conversationCwd, parent.conversationId);
  const fingerprint = jsonlFingerprint(parentJsonl);
  if (!fingerprint) {
    return {
      ok: false,
      reason: 'parent_jsonl_missing',
      message: `找不到父 session 的 JSONL 文件: ${parentJsonl}`,
    };
  }

  const shortId = generateShortId();
  const newConversationId = randomUUID();
  const newJsonl = resolveSessionJsonlPath(parent.conversationCwd, newConversationId);

  // 把整段流程包在 try/catch 里，任何 throw（Feishu 5xx / SDK 异常 / SQLite 写失败）
  // 都回滚已创建的 JSONL，避免出现「fork 看起来成功但新话题无记忆」的孤儿。
  let newJsonlCreated = false;
  let rootMessageId: string | undefined;
  try {
    copyJsonlAtomic(parentJsonl, newJsonl);
    newJsonlCreated = true;

    // 在父话题里贴一条 "🔱 …" 的 top-level 消息作为新话题根。
    // 注意：reply_in_thread=true 在父消息已属于话题时会留在原话题里，所以这里直接用 sendText
    // 发到主聊天区，得到一条非话题消息；再在其上 replyInThread 形成新话题。
    const rootTitle = buildRootTitle(opts.description, shortId);
    rootMessageId = await feishuClient.sendText(opts.chatId, rootTitle);
    if (!rootMessageId) {
      throw new ForkAbort('feishu_thread_create_failed', '创建新话题根消息失败');
    }

    const systemMsg = buildLineageMessage({
      parentThreadId: opts.parentThreadId,
      parentWorkdir: parent.workingDir,
      newWorkdir: parent.workingDir,
      shortId,
    });
    const { messageId: replyMsgId, threadId: newThreadId } = await feishuClient.replyInThread(
      rootMessageId,
      systemMsg,
    );

    if (!newThreadId) {
      logger.error({ rootMessageId, replyMsgId }, 'fork: replyInThread did not return threadId');
      throw new ForkAbort('feishu_thread_create_failed', '新话题创建失败（无 thread_id 返回）');
    }

    // DB 写入必须在 Feishu 消息发送成功之后。如果 DB 写失败，catch 仍会回滚 JSONL，
    // 但 Feishu 上两条消息会留下（飞书无可靠 message recall API）——这是「孤儿消息」
    // 与「新话题丢失继承历史」之间的折中：宁可留两条无害的消息，也不能让没有 DB 行
    // 的新话题在下一条消息时创建全新 conversationId 而把父对话历史悄悄丢光。
    sessionManager.createForkedThreadSession({
      threadId: newThreadId,
      chatId: opts.chatId,
      userId: opts.userId,
      workingDir: parent.workingDir,
      conversationId: newConversationId,
      conversationCwd: parent.conversationCwd,
      systemPromptHash: parent.systemPromptHash,
      parentTopicId: opts.parentThreadId,
      forkShortId: shortId,
      forkedFromMessageId: opts.triggerMessageId,
      forkPoint: fingerprint,
      approved: parent.approved ?? true,
      agentId,
    });

    logger.info(
      { parentThreadId: opts.parentThreadId, newThreadId, shortId, newConversationId },
      'fork: created new thread',
    );

    return {
      ok: true,
      newThreadId,
      newConversationId,
      newRootMessageId: rootMessageId,
      shortId,
      workingDir: parent.workingDir,
    };
  } catch (err) {
    if (newJsonlCreated) {
      try { unlinkSync(newJsonl); } catch { /* ignore cleanup failure */ }
    }
    if (err instanceof ForkAbort) {
      logger.warn({ reason: err.reason, rootMessageId }, 'fork: aborted with explicit reason');
      return { ok: false, reason: err.reason, message: err.message };
    }
    logger.error(
      { err, parentJsonl, newJsonl, rootMessageId },
      'fork: aborted by exception, JSONL rolled back',
    );
    return { ok: false, reason: 'unknown', message: `Fork 失败: ${(err as Error).message}` };
  }
}

/** 内部 sentinel：把"已知失败原因"穿过 try/catch 边界，与意外异常区分。 */
class ForkAbort extends Error {
  constructor(public readonly reason: ForkFailureReason, message: string) {
    super(message);
  }
}

function buildRootTitle(description: string | undefined, shortId: string): string {
  const desc = description?.trim();
  return desc ? `🔱 Fork [${shortId}]: ${desc}` : `🔱 Fork [${shortId}]`;
}

function buildLineageMessage(args: {
  parentThreadId: string;
  parentWorkdir: string;
  newWorkdir: string;
  shortId: string;
}): string {
  return [
    `🔱 从话题 fork（id=${args.shortId}）`,
    `- 源话题: ${args.parentThreadId}`,
    `- 工作目录: ${args.newWorkdir}`,
    args.parentWorkdir === args.newWorkdir ? '- 共享父话题工作目录（场景 B）' : '',
    '- 对话历史已继承，可继续讨论',
  ]
    .filter(Boolean)
    .join('\n');
}
