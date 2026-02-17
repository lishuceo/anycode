import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { SessionDatabase } from './database.js';
import type { Session } from './types.js';

/**
 * 会话管理器
 * 管理飞书会话与 Claude Code 工作环境的映射
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
  getOrCreate(chatId: string, userId: string): Session {
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
  get(chatId: string, userId: string): Session | undefined {
    return this.db.get(this.makeKey(chatId, userId));
  }

  /**
   * 更新会话工作目录
   */
  setWorkingDir(chatId: string, userId: string, dir: string): void {
    const key = this.makeKey(chatId, userId);
    this.getOrCreate(chatId, userId);
    this.db.updateWorkingDir(key, dir);
    logger.info({ chatId, userId, workingDir: dir }, 'Working directory changed');
  }

  /**
   * 更新会话状态
   */
  setStatus(chatId: string, userId: string, status: Session['status']): void {
    const key = this.makeKey(chatId, userId);
    this.getOrCreate(chatId, userId);
    this.db.updateStatus(key, status);
  }

  /**
   * 保存话题信息
   */
  setThread(chatId: string, userId: string, threadId: string, rootMessageId: string): void {
    const key = this.makeKey(chatId, userId);
    this.getOrCreate(chatId, userId);
    this.db.updateThread(key, threadId, rootMessageId);
    logger.info({ chatId, userId, threadId }, 'Thread saved to session');
  }

  /**
   * 更新 Claude Code 会话 ID (用于续接对话)
   */
  setConversationId(chatId: string, userId: string, conversationId: string): void {
    const key = this.makeKey(chatId, userId);
    this.getOrCreate(chatId, userId);
    this.db.updateConversationId(key, conversationId);
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
   * 清理过期会话 (超过 2 小时不活跃)
   */
  cleanup(maxIdleMs: number = 2 * 60 * 60 * 1000): number {
    const cleaned = this.db.deleteExpired(maxIdleMs);
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up idle sessions');
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
