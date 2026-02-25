import * as lark from '@larksuiteoapi/node-sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * 飞书 API 客户端封装
 */
export class FeishuClient {
  private client: lark.Client;
  private _botOpenId: string | undefined;

  /** Bot's own open_id, fetched at startup */
  get botOpenId(): string | undefined {
    return this._botOpenId;
  }

  constructor(appId?: string, appSecret?: string) {
    this.client = new lark.Client({
      appId: appId ?? config.feishu.appId,
      appSecret: appSecret ?? config.feishu.appSecret,
      disableTokenCache: false,
    });
  }

  /**
   * Fetch bot info from Feishu API and store bot's open_id.
   * Should be called once at startup.
   */
  async fetchBotInfo(): Promise<void> {
    try {
      const resp = await this.client.request<{
        code?: number;
        msg?: string;
        bot?: { open_id?: string; app_name?: string };
      }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });

      if (resp.code === 0 && resp.bot?.open_id) {
        this._botOpenId = resp.bot.open_id;
        logger.info({ botOpenId: this._botOpenId, appName: resp.bot.app_name }, 'Bot info fetched');
      } else {
        logger.warn({ code: resp.code, msg: resp.msg }, 'Failed to fetch bot info, @mention detection may be inaccurate');
      }
    } catch (err) {
      logger.warn({ err }, 'Error fetching bot info, @mention detection may be inaccurate');
    }
  }

  /**
   * 发送文本消息
   */
  async sendText(chatId: string, text: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to send text message');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error sending text message');
      return undefined;
    }
  }

  /**
   * 发送富文本 (post) 消息
   */
  async sendPost(
    chatId: string,
    title: string,
    content: Array<Array<Record<string, unknown>>>,
  ): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: { title, content },
          }),
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to send post message');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error sending post message');
      return undefined;
    }
  }

  /**
   * 发送交互卡片消息
   */
  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to send card message');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error sending card message');
      return undefined;
    }
  }

  /**
   * 更新卡片消息（用于实时进度更新）
   */
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<boolean> {
    try {
      const resp = await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to update card message');
        return false;
      }

      return true;
    } catch (err) {
      logger.error({ err }, 'Error updating card message');
      return false;
    }
  }

  /**
   * 回复消息
   */
  async replyText(messageId: string, text: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to reply text message');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error replying text message');
      return undefined;
    }
  }

  /**
   * 在话题中回复消息（创建话题）
   * 返回 messageId 和 threadId
   */
  async replyInThread(
    messageId: string,
    text: string,
  ): Promise<{ messageId?: string; threadId?: string }> {
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          reply_in_thread: true,
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to reply in thread');
        return {};
      }

      return {
        messageId: resp.data?.message_id,
        threadId: resp.data?.thread_id,
      };
    } catch (err) {
      logger.error({ err }, 'Error replying in thread');
      return {};
    }
  }

  /**
   * 在话题中回复文本（通过回复话题内的消息）
   */
  async replyTextInThread(threadMessageId: string, text: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: threadMessageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          reply_in_thread: true,
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to reply text in thread');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error replying text in thread');
      return undefined;
    }
  }

  /**
   * 在话题中回复卡片（通过回复话题内的消息）
   */
  async replyCardInThread(threadMessageId: string, card: Record<string, unknown>): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: threadMessageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          reply_in_thread: true,
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to reply card in thread');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error replying card in thread');
      return undefined;
    }
  }

  /**
   * 创建话题并发送卡片作为首条消息
   * 返回 messageId 和 threadId
   */
  async createThreadWithCard(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<{ messageId?: string; threadId?: string }> {
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          reply_in_thread: true,
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to create thread with card');
        return {};
      }

      return {
        messageId: resp.data?.message_id,
        threadId: resp.data?.thread_id,
      };
    } catch (err) {
      logger.error({ err }, 'Error creating thread with card');
      return {};
    }
  }

  /**
   * 发送卡片消息给指定用户（通过 open_id）
   */
  async sendCardToUser(openId: string, card: Record<string, unknown>): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to send card to user');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error sending card to user');
      return undefined;
    }
  }

  /**
   * 获取飞书用户名（通过 open_id）
   * 优先通过通讯录 API，失败时通过群成员列表查找
   */
  async getUserName(openId: string, chatId?: string): Promise<string | undefined> {
    // 方案 1：通讯录 API（需要 contact 权限 + 通讯录范围覆盖）
    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      if (resp.code === 0 && resp.data?.user?.name) {
        return resp.data.user.name;
      }
    } catch {
      // fall through
    }

    // 方案 2：从群成员列表中查找（bot 作为群成员天然有权限）
    if (chatId) {
      try {
        for await (const page of await this.client.im.chatMembers.getWithIterator({
          path: { chat_id: chatId },
          params: { member_id_type: 'open_id', page_size: 100 },
        })) {
          const member = page?.items?.find((m) => m.member_id === openId);
          if (member?.name) return member.name;
        }
      } catch {
        // fall through
      }
    }

    return undefined;
  }

  /**
   * 下载消息中的图片资源
   * 使用 im.messageResource.get API（支持下载用户发送的图片）
   */
  async downloadMessageImage(messageId: string, imageKey: string): Promise<Buffer> {
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: 'image' },
        path: { message_id: messageId, file_key: imageKey },
      });

      const stream = resp.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      logger.error({ err, messageId, imageKey }, 'Failed to download message image');
      throw err;
    }
  }

  /**
   * 获取话题内的消息列表（用于构建对话历史上下文）
   * 使用降序获取最新消息（单页即可覆盖最相关的上下文），返回时 reverse 为时间正序
   */
  async listThreadMessages(threadId: string, pageSize = 50): Promise<Array<{
    senderType: 'user' | 'app';
    msgType: string;
    textContent?: string;
    createTime: string;
  }>> {
    try {
      // 降序取最新一页：即使话题消息 >pageSize，也能拿到 /dev 前最近的上下文
      const resp = await this.client.im.message.list({
        params: {
          container_id_type: 'thread',
          container_id: threadId,
          page_size: pageSize,
          sort_type: 'ByCreateTimeDesc',
        },
      });

      if (resp.code !== 0 || !resp.data?.items) {
        logger.warn({ code: resp.code, msg: resp.msg, threadId }, 'Failed to list thread messages');
        return [];
      }

      if (resp.data.has_more) {
        logger.info({ threadId, pageSize, total: resp.data.items.length }, 'Thread has more messages than pageSize, early history truncated');
      }

      const results = resp.data.items.map((item) => {
        const senderType = item.sender?.sender_type === 'app' ? 'app' as const : 'user' as const;
        const msgType = item.msg_type ?? 'unknown';

        let textContent: string | undefined;
        if (msgType === 'text' && item.body?.content) {
          try {
            const parsed = JSON.parse(item.body.content);
            let text = parsed.text as string | undefined;
            // 解析飞书 @mention 占位符（@_user_1 → @用户名）
            if (text && Array.isArray(item.mentions)) {
              for (const m of item.mentions as Array<{ key?: string; name?: string }>) {
                if (m.key) {
                  text = text.replaceAll(m.key, m.name ? `@${m.name}` : '');
                }
              }
            }
            textContent = text;
          } catch {
            // ignore parse errors
          }
        }

        return {
          senderType,
          msgType,
          textContent,
          createTime: item.create_time ?? '',
        };
      });

      // 降序取回后 reverse 为时间正序
      results.reverse();
      return results;
    } catch (err) {
      logger.warn({ err, threadId }, 'Error listing thread messages');
      return [];
    }
  }

  /** 获取原始 client 以便直接使用 */
  get raw(): lark.Client {
    return this.client;
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * AsyncLocalStorage 用于在异步调用链中传递当前 accountId。
 * handleMessageEvent 入口设置，下游的 feishuClient 调用自动路由到正确的 per-account client。
 */
export const feishuClientContext = new AsyncLocalStorage<string>();

/** 设置当前请求的 accountId（在 handleMessageEvent 入口调用） */
export function runWithAccountId<T>(accountId: string, fn: () => T): T {
  return feishuClientContext.run(accountId, fn);
}

/**
 * Client resolver — 由 multi-account.ts 在初始化后注册，
 * 避免 client.ts → multi-account.ts 循环依赖。
 */
let _clientResolver: ((accountId: string) => FeishuClient | undefined) | undefined;

/** 注册 per-account client resolver（由 multi-account.ts 调用） */
export function registerClientResolver(resolver: (accountId: string) => FeishuClient | undefined): void {
  _clientResolver = resolver;
}

/**
 * 全局单例（向后兼容）
 *
 * 在多 bot 模式下，通过 Proxy 自动路由到 AsyncLocalStorage 中绑定的 per-account client。
 * 单 bot 模式下或 AsyncLocalStorage 无值时，回退到默认实例。
 */
const _defaultClient = new FeishuClient();

export const feishuClient: FeishuClient = new Proxy(_defaultClient, {
  get(target, prop, receiver) {
    const accountId = feishuClientContext.getStore();
    if (accountId && accountId !== 'default' && _clientResolver) {
      const client = _clientResolver(accountId);
      if (client) {
        return Reflect.get(client, prop, receiver);
      }
    }
    return Reflect.get(target, prop, receiver);
  },
});
