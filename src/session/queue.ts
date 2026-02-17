import { logger } from '../utils/logger.js';
import type { QueueTask } from './types.js';

/**
 * 任务队列
 * 每个 chatId 同一时间只允许一个任务执行，其余排队等待
 */
export class TaskQueue {
  private queues = new Map<string, QueueTask[]>();
  private running = new Map<string, QueueTask>();

  /**
   * 将任务加入队列
   * @returns Promise<string> 任务执行结果
   */
  enqueue(
    chatId: string,
    userId: string,
    message: string,
    messageId: string,
    rootId?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const task: QueueTask = {
        id: `${chatId}:${Date.now()}`,
        chatId,
        userId,
        message,
        messageId,
        rootId,
        resolve,
        reject,
        createdAt: new Date(),
      };

      if (!this.queues.has(chatId)) {
        this.queues.set(chatId, []);
      }
      this.queues.get(chatId)!.push(task);
      logger.debug({ taskId: task.id, queueSize: this.queues.get(chatId)!.length }, 'Task enqueued');
    });
  }

  /**
   * 获取下一个待执行的任务（如果当前没有正在执行的任务）
   */
  dequeue(chatId: string): QueueTask | undefined {
    if (this.running.has(chatId)) return undefined;

    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) return undefined;

    const task = queue.shift()!;
    this.running.set(chatId, task);
    logger.debug({ taskId: task.id }, 'Task dequeued');
    return task;
  }

  /**
   * 标记任务完成
   */
  complete(chatId: string): void {
    this.running.delete(chatId);
  }

  /**
   * 检查某个 chat 是否有正在执行的任务
   */
  isBusy(chatId: string): boolean {
    return this.running.has(chatId);
  }

  /**
   * 获取等待中的任务数量
   */
  pendingCount(chatId: string): number {
    return this.queues.get(chatId)?.length || 0;
  }

  /**
   * 取消某个 chat 的所有等待中的任务
   */
  cancelPending(chatId: string): number {
    const queue = this.queues.get(chatId);
    if (!queue) return 0;

    const count = queue.length;
    for (const task of queue) {
      task.reject(new Error('Task cancelled'));
    }
    queue.length = 0;
    return count;
  }
}

/** 全局单例 */
export const taskQueue = new TaskQueue();
