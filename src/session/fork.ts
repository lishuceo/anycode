import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  | 'parent_jsonl_missing'
  | 'feishu_thread_create_failed'
  | 'worktree_create_failed'
  | 'stash_apply_failed'
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
  /** 场景 A 下若为 true,跳过父 WIP 继承,子 worktree 从干净 HEAD 起步 */
  clean?: boolean;
}

const GIT_TIMEOUT_MS = 30_000;

function generateShortId(): string {
  return randomBytes(2).toString('hex');
}

function gitExec(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function gitCurrentBranch(cwd: string): string {
  return gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

/**
 * 执行 Session Fork。
 * - 场景 B (父在 DEFAULT_WORK_DIR): 共享工作目录,不创建 worktree
 * - 场景 A (父已 setup_workspace): 创建独立 git worktree + 默认继承父 WIP
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
  const isScenarioA = parentDir !== defaultDir;

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
  // 场景 A 的子 conversationCwd 必须用新 worktree 路径(否则 SDK resume 时 cwd 不匹配)
  const newWorkdir = isScenarioA ? `${parent.workingDir}-fork-${shortId}` : parent.workingDir;
  const newConversationCwd = isScenarioA ? newWorkdir : parent.conversationCwd;
  const newJsonl = resolveSessionJsonlPath(newConversationCwd, newConversationId);

  // 回滚追踪标志
  let worktreeCreated = false;
  let newBranchName: string | undefined;
  let newJsonlCreated = false;
  let rootMessageId: string | undefined;

  try {
    // ── 场景 A: 创建独立 worktree + 继承 WIP ──
    if (isScenarioA) {
      // 1. 读父分支 + 新建 worktree (基于父 HEAD 切新分支,避免分支锁)
      //    把 rev-parse 也包进 worktree_create_failed,因为不在 git 仓库内是同一类问题
      try {
        const parentBranch = gitCurrentBranch(parent.workingDir);
        newBranchName = `${parentBranch}-fork-${shortId}`;
        gitExec(parent.workingDir, ['worktree', 'add', '-b', newBranchName, newWorkdir, 'HEAD']);
        worktreeCreated = true;
      } catch (err) {
        if (err instanceof ForkAbort) throw err;
        throw new ForkAbort(
          'worktree_create_failed',
          `创建 worktree 失败: ${(err as Error).message}`,
        );
      }

      // 2. 默认继承父 WIP(staged/unstaged/untracked)。
      //    实现:在父 stash push -u (推到 stash 栈) → 子 apply 该 stash → 父 pop 恢复。
      //    NOTE: `git stash create -u` 不支持 untracked(create 不接受选项,-u 被当成 message),
      //    所以必须走 push+pop 路径,父工作树会有亚秒级的"清空"窗口。
      //    fork 是用户同步触发的,期间父话题 Claude 处于 idle,无并发写入,可接受。
      if (!opts.clean) {
        const stashMsg = `fork-temp-${shortId}`;
        // push 静默执行;若父无任何改动则不创建 stash 条目
        gitExec(parent.workingDir, ['stash', 'push', '--include-untracked', '--quiet', '-m', stashMsg]);
        const stashList = gitExec(parent.workingDir, ['stash', 'list']);
        const hasStash = stashList.includes(stashMsg);
        if (hasStash) {
          const stashSha = gitExec(parent.workingDir, ['rev-parse', 'stash@{0}']).trim();
          try {
            gitExec(newWorkdir, ['stash', 'apply', stashSha]);
          } catch (err) {
            // 子 apply 失败,但父 stash 还在 — 先恢复父再抛 abort
            try {
              gitExec(parent.workingDir, ['stash', 'pop', '--quiet']);
            } catch (popErr) {
              logger.error({ popErr, stashSha }, 'fork: parent stash pop failed after child apply failed');
            }
            throw new ForkAbort(
              'stash_apply_failed',
              `继承父 WIP 失败: ${(err as Error).message}`,
            );
          }
          // 子 apply 成功 → 父 pop 恢复
          try {
            gitExec(parent.workingDir, ['stash', 'pop', '--quiet']);
          } catch (popErr) {
            // 这是最危险的分支:父 WIP 还在 stash 里,worktree 是空的
            logger.error(
              { popErr, stashSha, parentWorkdir: parent.workingDir },
              'fork: CRITICAL — parent stash pop failed, WIP stuck in stash@{0}, manual recovery needed',
            );
            throw new ForkAbort(
              'stash_apply_failed',
              `继承父 WIP 时父恢复失败(WIP 在 stash@{0},请手动 git stash pop): ${(popErr as Error).message}`,
            );
          }
        }
      }
    }

    // ── 通用流程: JSONL → Feishu → DB ──
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
      newWorkdir,
      shortId,
      scenario: isScenarioA ? 'A' : 'B',
      clean: opts.clean ?? false,
    });
    const { messageId: replyMsgId, threadId: newThreadId } = await feishuClient.replyInThread(
      rootMessageId,
      systemMsg,
    );

    if (!newThreadId) {
      logger.error({ rootMessageId, replyMsgId }, 'fork: replyInThread did not return threadId');
      throw new ForkAbort('feishu_thread_create_failed', '新话题创建失败（无 thread_id 返回）');
    }

    // DB 写入必须在 Feishu 消息发送成功之后。如果 DB 写失败，catch 仍会回滚 JSONL/worktree，
    // 但 Feishu 上两条消息会留下（飞书无可靠 message recall API）——这是「孤儿消息」
    // 与「新话题丢失继承历史」之间的折中：宁可留两条无害的消息，也不能让没有 DB 行
    // 的新话题在下一条消息时创建全新 conversationId 而把父对话历史悄悄丢光。
    sessionManager.createForkedThreadSession({
      threadId: newThreadId,
      chatId: opts.chatId,
      userId: opts.userId,
      workingDir: newWorkdir,
      conversationId: newConversationId,
      conversationCwd: newConversationCwd,
      systemPromptHash: parent.systemPromptHash,
      parentTopicId: opts.parentThreadId,
      forkShortId: shortId,
      forkedFromMessageId: opts.triggerMessageId,
      forkPoint: fingerprint,
      approved: parent.approved ?? true,
      agentId,
    });

    logger.info(
      { parentThreadId: opts.parentThreadId, newThreadId, shortId, newConversationId, isScenarioA, clean: opts.clean ?? false },
      'fork: created new thread',
    );

    return {
      ok: true,
      newThreadId,
      newConversationId,
      newRootMessageId: rootMessageId,
      shortId,
      workingDir: newWorkdir,
    };
  } catch (err) {
    // 回滚顺序: JSONL → worktree → branch。父工作树未被动过(stash create 不修改),无需回滚。
    if (newJsonlCreated) {
      try { unlinkSync(newJsonl); } catch { /* ignore */ }
    }
    if (worktreeCreated) {
      try {
        gitExec(parent.workingDir, ['worktree', 'remove', '--force', newWorkdir]);
      } catch (cleanupErr) {
        logger.warn({ cleanupErr, newWorkdir }, 'fork: worktree cleanup failed');
      }
    }
    if (newBranchName) {
      try {
        gitExec(parent.workingDir, ['branch', '-D', newBranchName]);
      } catch {
        // 分支可能因 worktree remove 已被同时清理,或从未实际创建。忽略。
      }
    }
    if (err instanceof ForkAbort) {
      logger.warn({ reason: err.reason, rootMessageId, isScenarioA }, 'fork: aborted with explicit reason');
      return { ok: false, reason: err.reason, message: err.message };
    }
    logger.error(
      { err, parentJsonl, newJsonl, rootMessageId, isScenarioA },
      'fork: aborted by exception, JSONL/worktree rolled back',
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
  scenario: 'A' | 'B';
  clean: boolean;
}): string {
  const lines: string[] = [
    `🔱 从话题 fork（id=${args.shortId}）`,
    `- 源话题: ${args.parentThreadId}`,
    `- 工作目录: ${args.newWorkdir}`,
  ];
  if (args.scenario === 'B') {
    lines.push('- 共享父话题工作目录（场景 B,无独立 worktree）');
  } else {
    lines.push(
      args.clean
        ? '- 独立 worktree(--clean: 从干净 HEAD 起步,未继承父 WIP)'
        : '- 独立 worktree(已继承父话题未提交改动)',
    );
  }
  lines.push('- 对话历史已继承，可继续讨论');
  return lines.join('\n');
}
