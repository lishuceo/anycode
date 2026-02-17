import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Session } from './types.js';

/**
 * 会话管理器
 * 管理飞书会话与 Claude Code 工作环境的映射
 */
export class SessionManager {
  private sessions = new Map<string, Session>();

  /**
   * 获取或创建会话
   * key = chatId (群聊共享) 或 chatId:userId (私聊独立)
   */
  getOrCreate(chatId: string, userId: string): Session {
    const key = this.makeKey(chatId, userId);
    let session = this.sessions.get(key);

    if (!session) {
      session = {
        chatId,
        userId,
        workingDir: config.claude.defaultWorkDir,
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(),
      };
      this.sessions.set(key, session);
      logger.info({ chatId, userId, workingDir: session.workingDir }, 'Session created');
    }

    session.lastActiveAt = new Date();
    return session;
  }

  /**
   * 获取会话
   */
  get(chatId: string, userId: string): Session | undefined {
    return this.sessions.get(this.makeKey(chatId, userId));
  }

  /**
   * 更新会话工作目录
   */
  setWorkingDir(chatId: string, userId: string, dir: string): void {
    const session = this.getOrCreate(chatId, userId);
    session.workingDir = dir;
    logger.info({ chatId, userId, workingDir: dir }, 'Working directory changed');
  }

  /**
   * 更新会话状态
   */
  setStatus(chatId: string, userId: string, status: Session['status']): void {
    const session = this.getOrCreate(chatId, userId);
    session.status = status;
  }

  /**
   * 保存话题信息
   */
  setThread(chatId: string, userId: string, threadId: string, rootMessageId: string): void {
    const session = this.getOrCreate(chatId, userId);
    session.threadId = threadId;
    session.threadRootMessageId = rootMessageId;
    logger.info({ chatId, userId, threadId }, 'Thread saved to session');
  }

  /**
   * 更新 Claude Code 会话 ID (用于续接对话)
   */
  setConversationId(chatId: string, userId: string, conversationId: string): void {
    const session = this.getOrCreate(chatId, userId);
    session.conversationId = conversationId;
  }

  /**
   * 重置会话
   */
  reset(chatId: string, userId: string): void {
    const key = this.makeKey(chatId, userId);
    this.sessions.delete(key);
    logger.info({ chatId, userId }, 'Session reset');
  }

  /**
   * 清理过期会话 (超过 2 小时不活跃)
   */
  cleanup(maxIdleMs: number = 2 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.lastActiveAt.getTime() > maxIdleMs && session.status !== 'busy') {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up idle sessions');
    }
    return cleaned;
  }

  private makeKey(chatId: string, userId: string): string {
    return `${chatId}:${userId}`;
  }
}

/** 全局单例 */
export const sessionManager = new SessionManager();
