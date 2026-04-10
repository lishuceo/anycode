import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { SessionDatabase } from './database.js';
import { isAutoWorkspacePath } from '../workspace/isolation.js';
import type { Session, ThreadSession, PipelineContext } from './types.js';

/**
 * 会话管理器
 * 管理飞书会话与 Claude Code 工作环境的映射
 *
 * 注意: get / getOrCreate 返回的 Session 是 DB 快照副本 (Readonly),
 * 直接修改属性不会反映到数据库，需通过 set* 方法更新。
 */
export class SessionManager {
  private db: SessionDatabase;

  constructor() {
    this.db = new SessionDatabase(config.db.sessionDbPath);
    this.db.resetBusySessions();
  }

  /**
   * 获取或创建会话
   * key = agent:{agentId}:{chatId}:{userId}
   */
  getOrCreate(chatId: string, userId: string, agentId: string = 'dev'): Readonly<Session> {
    const key = this.makeKey(chatId, userId, agentId);
    let session = this.db.get(key);

    if (!session) {
      session = {
        chatId,
        userId,
        workingDir: config.claude.defaultWorkDir,
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(),
      };
      this.db.upsert(key, session);
      logger.info({ chatId, userId, workingDir: session.workingDir }, 'Session created');
    } else {
      this.db.updateLastActive(key);
      session.lastActiveAt = new Date();
    }

    return session;
  }

  /**
   * 获取会话
   */
  get(chatId: string, userId: string, agentId: string = 'dev'): Readonly<Session> | undefined {
    return this.db.get(this.makeKey(chatId, userId, agentId));
  }

  /**
   * 通过原始 key 获取会话（用于 shutdown 保存中断 session 时直接查询）
   */
  getByKey(key: string): Readonly<Session> | undefined {
    return this.db.get(key);
  }

  /**
   * 更新会话工作目录
   */
  setWorkingDir(chatId: string, userId: string, dir: string, agentId: string = 'dev'): void {
    const key = this.makeKey(chatId, userId, agentId);
    this.db.updateWorkingDir(key, dir);
    logger.info({ chatId, userId, workingDir: dir }, 'Working directory changed');
  }

  /**
   * 更新会话状态
   */
  setStatus(chatId: string, userId: string, status: Session['status'], agentId: string = 'dev'): void {
    this.db.updateStatus(this.makeKey(chatId, userId, agentId), status);
  }

  /**
   * 原子地尝试获取会话锁（idle → busy），防止 TOCTOU 竞态
   * @returns true 如果成功获取（session 之前不是 busy），false 如果已被占用
   */
  tryAcquire(chatId: string, userId: string, agentId: string = 'dev'): boolean {
    // 确保 session 存在
    this.getOrCreate(chatId, userId, agentId);
    return this.db.tryAcquire(this.makeKey(chatId, userId, agentId));
  }

  /**
   * 保存话题信息
   */
  setThread(chatId: string, userId: string, threadId: string, rootMessageId: string, agentId: string = 'dev'): void {
    this.db.updateThread(this.makeKey(chatId, userId, agentId), threadId, rootMessageId);
    logger.info({ chatId, userId, threadId, agentId }, 'Thread saved to session');
  }

  /**
   * 更新 Claude Code 会话 ID (用于续接对话)
   * @param cwd 创建该 session 时的工作目录（resume 需要 cwd 匹配）
   */
  setConversationId(chatId: string, userId: string, conversationId: string, cwd?: string, agentId: string = 'dev', systemPromptHash?: string): void {
    this.db.updateConversationId(this.makeKey(chatId, userId, agentId), conversationId, cwd, systemPromptHash);
  }

  /**
   * 重置会话
   */
  reset(chatId: string, userId: string, agentId: string = 'dev'): void {
    const key = this.makeKey(chatId, userId, agentId);
    this.db.delete(key);
    logger.info({ chatId, userId }, 'Session reset');
  }

  /**
   * 获取 thread 级别的 session
   */
  getThreadSession(threadId: string, agentId: string = 'dev'): Readonly<ThreadSession> | undefined {
    return this.db.getThreadSession(this.makeThreadKey(threadId, agentId));
  }

  /**
   * 创建或更新 thread session（首条消息确定 workdir 时调用）
   */
  upsertThreadSession(threadId: string, chatId: string, userId: string, workingDir: string, agentId: string = 'dev'): void {
    const key = this.makeThreadKey(threadId, agentId);
    const existing = this.db.getThreadSession(key);
    const now = new Date();
    this.db.upsertThreadSession({
      threadId: key,
      chatId,
      userId,
      workingDir,
      conversationId: existing?.conversationId,
      conversationCwd: existing?.conversationCwd,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  /**
   * 保存 thread 对应的 Claude Code session ID
   */
  setThreadConversationId(threadId: string, conversationId: string, cwd: string, agentId: string = 'dev', systemPromptHash?: string): void {
    this.db.updateThreadConversationId(this.makeThreadKey(threadId, agentId), conversationId, cwd, systemPromptHash);
  }

  /**
   * 清空 thread 的 conversationId（强制下次消息起新 session）
   */
  resetThreadConversation(threadId: string, agentId: string = 'dev'): void {
    this.db.resetThreadConversation(this.makeThreadKey(threadId, agentId));
    logger.info({ threadId, agentId }, 'Thread conversation reset');
  }

  /**
   * 更新 thread 的工作目录（workspace 切换时，同时清空 conversationId）
   */
  setThreadWorkingDir(threadId: string, workingDir: string, agentId: string = 'dev'): void {
    this.db.updateThreadWorkingDir(this.makeThreadKey(threadId, agentId), workingDir);
  }

  /**
   * 设置 thread 的审批状态（owner 审批通过/拒绝）
   */
  setThreadApproved(threadId: string, approved: boolean, agentId: string = 'dev'): void {
    this.db.setThreadApproved(this.makeThreadKey(threadId, agentId), approved);
  }

  /**
   * 设置 thread 的原地编辑模式（/edit 命令触发，跳过源仓库保护）
   */
  setThreadInplaceEdit(threadId: string, inplaceEdit: boolean, agentId: string = 'dev'): void {
    this.db.setThreadInplaceEdit(this.makeThreadKey(threadId, agentId), inplaceEdit);
  }

  /**
   * 保存 pipeline 上下文到 thread session（pipeline 完成后调用）
   */
  setThreadPipelineContext(threadId: string, context: PipelineContext, agentId: string = 'dev'): void {
    this.db.setThreadPipelineContext(this.makeThreadKey(threadId, agentId), context);
  }

  /**
   * 刷新 thread session 的 updated_at（防止活跃 thread 被 cleanup 清理）
   */
  touchThreadSession(threadId: string, agentId: string = 'dev'): void {
    this.db.touchThreadSession(this.makeThreadKey(threadId, agentId));
  }

  /**
   * 保存会话摘要（独立于 sessions 表，不受 cleanup 影响）
   */
  saveSummary(chatId: string, userId: string, workingDir: string, summary: string): void {
    this.db.insertSummary(chatId, userId, workingDir, summary);
  }

  /**
   * 获取最近 N 条会话摘要（时间正序：旧 → 新）
   */
  getRecentSummaries(chatId: string, userId: string, limit: number = 5): string[] {
    return this.db.getRecentSummaries(chatId, userId, limit);
  }

  /**
   * 清理过期会话 (超过 24 小时不活跃) 和旧摘要 (超过 30 天)
   */
  cleanup(maxIdleMs: number = 24 * 60 * 60 * 1000): number {
    const cleaned = this.db.deleteExpired(maxIdleMs);
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up idle sessions');
    }
    const oldSummaries = this.db.cleanOldSummaries();
    if (oldSummaries > 0) {
      logger.info({ oldSummaries }, 'Cleaned up old session summaries');
    }

    // Thread session 清理：用统一 cutoff 原子化查询 + 删除，避免 TOCTOU
    const threadMaxIdleMs = config.workspace.maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - threadMaxIdleMs).toISOString();
    const expiredThreads = this.db.getExpiredThreadSessionsByCutoff(cutoff);
    const cleanedThreads = this.db.deleteExpiredThreadSessionsByCutoff(cutoff);
    if (cleanedThreads > 0) {
      logger.info({ cleanedThreads }, 'Cleaned up idle thread sessions');
    }

    // 删除过期 thread 的自动创建工作区目录
    let cleanedWorkspaces = 0;
    for (const thread of expiredThreads) {
      // 只删除 WORKSPACE_BASE_DIR 下的自动创建目录，不删除用户手动指定的路径
      if (isAutoWorkspacePath(thread.workingDir) && existsSync(thread.workingDir)) {
        try {
          rmSync(thread.workingDir, { recursive: true, force: true });
          cleanedWorkspaces++;
          logger.debug(
            { workspacePath: thread.workingDir, threadId: thread.threadId },
            'Removed expired workspace directory',
          );
        } catch (err) {
          logger.warn({ err, workspacePath: thread.workingDir }, 'Failed to remove expired workspace');
        }
      }
    }
    if (cleanedWorkspaces > 0) {
      logger.info({ cleanedWorkspaces }, 'Cleaned up expired workspace directories');
    }

    // 孤儿工作区清理：扫描 WORKSPACE_BASE_DIR 下不被任何活跃 thread session 引用的目录
    cleanedWorkspaces += this.cleanupOrphanWorkspaces(threadMaxIdleMs);

    return cleaned;
  }

  /**
   * 扫描 WORKSPACE_BASE_DIR，删除不被任何活跃 thread session 引用且超过 maxAge 的孤儿目录
   */
  private cleanupOrphanWorkspaces(maxAgeMs: number): number {
    const baseDir = config.workspace.baseDir;
    if (!existsSync(baseDir)) return 0;

    // 收集所有活跃 thread session 的工作目录
    const allThreadSessions = this.db.getAllThreadSessions();
    const activePaths = new Set(allThreadSessions.map((t) => t.workingDir));

    let cleaned = 0;
    const now = Date.now();
    try {
      const entries = readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(baseDir, entry.name);
        if (activePaths.has(dirPath)) continue;

        // 只删除超过 maxAge 的目录
        try {
          const mtime = statSync(dirPath).mtimeMs;
          if (now - mtime < maxAgeMs) continue;
        } catch {
          continue;
        }

        try {
          rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
          logger.debug({ workspacePath: dirPath }, 'Removed orphan workspace directory');
        } catch (err) {
          logger.warn({ err, workspacePath: dirPath }, 'Failed to remove orphan workspace');
        }
      }
    } catch (err) {
      logger.warn({ err, baseDir }, 'Failed to scan workspace base directory for orphans');
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up orphan workspace directories');
    }
    return cleaned;
  }

  // ── User Token (OAuth) ──

  upsertUserToken(userId: string, accessToken: string, refreshToken: string, tokenExpiry: number, accountId: string = ''): void {
    this.db.upsertUserToken(userId, accessToken, refreshToken, tokenExpiry, accountId);
  }

  getUserToken(userId: string): { accessToken: string; refreshToken: string; tokenExpiry: number; accountId: string } | undefined {
    return this.db.getUserToken(userId);
  }

  deleteUserToken(userId: string): void {
    this.db.deleteUserToken(userId);
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }

  /**
   * 构建 session key，包含 agentId 前缀
   * 格式: agent:{agentId}:{chatId}:{userId}
   */
  makeKey(chatId: string, userId: string, agentId: string = 'dev'): string {
    return `agent:${agentId}:${chatId}:${userId}`;
  }

  /**
   * 构建 thread session key，包含 agentId 前缀
   * 格式: agent:{agentId}:{threadId}
   */
  makeThreadKey(threadId: string, agentId: string = 'dev'): string {
    return `agent:${agentId}:${threadId}`;
  }
}

/** 全局单例 */
export const sessionManager = new SessionManager();
