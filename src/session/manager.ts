import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { SessionDatabase } from './database.js';
import type { Session } from './types.js';

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
   * key = chatId (群聊共享) 或 chatId:userId (私聊独立)
   */
  getOrCreate(chatId: string, userId: string): Readonly<Session> {
    const key = this.makeKey(chatId, userId);
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
  get(chatId: string, userId: string): Readonly<Session> | undefined {
    return this.db.get(this.makeKey(chatId, userId));
  }

  /**
   * 更新会话工作目录
   */
  setWorkingDir(chatId: string, userId: string, dir: string): void {
    const key = this.makeKey(chatId, userId);
    this.db.updateWorkingDir(key, dir);
    logger.info({ chatId, userId, workingDir: dir }, 'Working directory changed');
  }

  /**
   * 更新会话状态
   */
  setStatus(chatId: string, userId: string, status: Session['status']): void {
    this.db.updateStatus(this.makeKey(chatId, userId), status);
  }

  /**
   * 保存话题信息
   */
  setThread(chatId: string, userId: string, threadId: string, rootMessageId: string): void {
    this.db.updateThread(this.makeKey(chatId, userId), threadId, rootMessageId);
    logger.info({ chatId, userId, threadId }, 'Thread saved to session');
  }

  /**
   * 更新 Claude Code 会话 ID (用于续接对话)
   */
  setConversationId(chatId: string, userId: string, conversationId: string): void {
    this.db.updateConversationId(this.makeKey(chatId, userId), conversationId);
  }

  /**
   * 重置会话
   */
  reset(chatId: string, userId: string): void {
    const key = this.makeKey(chatId, userId);
    this.db.delete(key);
    logger.info({ chatId, userId }, 'Session reset');
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
    return cleaned;
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }

  private makeKey(chatId: string, userId: string): string {
    return `${chatId}:${userId}`;
  }
}

/** 全局单例 */
export const sessionManager = new SessionManager();
