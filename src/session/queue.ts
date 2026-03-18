import { logger } from '../utils/logger.js';
import type { QueueTask } from './types.js';

/**
 * 任务队列
 *
 * 以 queueKey 为粒度串行执行：同一 queueKey 同一时间只允许一个任务。
 * 调用方通常使用 `chatId:rootId` 作为 key，实现 per-thread 串行 + 跨 thread 并行。
 * 主聊天框消息（无 rootId）使用 `chatId` 作为 key。
 */
export class TaskQueue {
  private queues = new Map<string, QueueTask[]>();
  private running = new Map<string, QueueTask>();

  /**
   * 将任务加入队列
   * @param queueKey 队列标识（通常为 chatId:rootId 或 chatId）
   */
  enqueue(
    queueKey: string,
    chatId: string,
    userId: string,
    message: string,
    messageId: string,
    rootId?: string,
    threadId?: string,
    images?: import('../claude/types.js').ImageAttachment[],
    documents?: import('../claude/types.js').DocumentAttachment[],
    createTime?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const task: QueueTask = {
        id: `${queueKey}:${Date.now()}`,
        chatId,
        userId,
        message,
        messageId,
        rootId,
        threadId,
        images,
        documents,
        createTime,
        resolve,
        reject,
        createdAt: new Date(),
      };

      if (!this.queues.has(queueKey)) {
        this.queues.set(queueKey, []);
      }
      this.queues.get(queueKey)!.push(task);
      logger.debug({ taskId: task.id, queueKey, queueSize: this.queues.get(queueKey)!.length }, 'Task enqueued');
    });
  }

  /**
   * 获取下一个待执行的任务（如果当前没有正在执行的任务）
   */
  dequeue(queueKey: string): QueueTask | undefined {
    if (this.running.has(queueKey)) return undefined;

    const queue = this.queues.get(queueKey);
    if (!queue || queue.length === 0) return undefined;

    const task = queue.shift()!;
    this.running.set(queueKey, task);
    logger.debug({ taskId: task.id, queueKey }, 'Task dequeued');
    return task;
  }

  /**
   * 标记任务完成
   */
  complete(queueKey: string): void {
    this.running.delete(queueKey);
  }

  /**
   * 检查某个队列是否有正在执行的任务
   */
  isBusy(queueKey: string): boolean {
    return this.running.has(queueKey);
  }

  /**
   * 获取某个队列等待中的任务数量
   */
  pendingCount(queueKey: string): number {
    return this.queues.get(queueKey)?.length || 0;
  }

  /**
   * 取消某个队列的所有等待中的任务
   */
  cancelPending(queueKey: string): number {
    const queue = this.queues.get(queueKey);
    if (!queue) return 0;

    const count = queue.length;
    for (const task of queue) {
      task.reject(new Error('Task cancelled'));
    }
    queue.length = 0;
    return count;
  }

  /**
   * 获取该 chat 下所有队列的总等待数（/status 用）
   */
  pendingCountForChat(chatId: string): number {
    let total = 0;
    for (const [key, queue] of this.queues) {
      if (key === chatId || key.startsWith(chatId + ':')) {
        total += queue.length;
      }
    }
    return total;
  }

  /**
   * 取消该 chat 下所有队列的等待任务（/stop 用）
   */
  cancelAllForChat(chatId: string): number {
    let total = 0;
    for (const [key, queue] of this.queues) {
      if (key === chatId || key.startsWith(chatId + ':')) {
        total += queue.length;
        for (const task of queue) {
          task.reject(new Error('Task cancelled'));
        }
        queue.length = 0;
      }
    }
    return total;
  }
}

/** 全局单例 */
export const taskQueue = new TaskQueue();
