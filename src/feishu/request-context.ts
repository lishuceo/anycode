/**
 * RequestContext — 携带 accountId 贯穿调用链
 *
 * 替代直接引用 feishuClient 全局单例的模式。
 * 单 bot 模式下 accountId = 'default'，agentId = 'dev'。
 */
import type { AgentId } from '../agent/types.js';
import type { FeishuClient } from './client.js';
import { accountManager } from './multi-account.js';

export interface RequestContext {
  /** Bot 账号标识 */
  accountId: string;
  /** 路由确定的 agent 角色 */
  agentId: AgentId;
  /** 飞书 chat ID */
  chatId: string;
  /** 飞书 thread ID */
  threadId?: string;
  /** 飞书 user ID */
  userId: string;
  /** 消息 ID */
  messageId: string;
  /** 获取当前 context 对应的飞书 client */
  getFeishuClient(): FeishuClient;
}

/**
 * 创建 RequestContext
 */
export function createRequestContext(params: {
  accountId: string;
  agentId: AgentId;
  chatId: string;
  threadId?: string;
  userId: string;
  messageId: string;
}): RequestContext {
  return {
    ...params,
    getFeishuClient(): FeishuClient {
      const client = accountManager.getClient(params.accountId);
      if (!client) {
        // 兜底到默认 client（不应该发生，但防御性编程）
        return accountManager.getDefaultClient();
      }
      return client;
    },
  };
}
