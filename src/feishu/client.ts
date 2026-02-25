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
   * 拉取群聊或话题的最近消息（用于首次 @bot 时注入聊天上下文）
   *
   * @param containerId - chat_id（群聊）或 thread_id（话题）
   * @param containerType - 'chat' 或 'thread'
   * @param limit - 最多拉取条数（默认 10）
   * @returns 简化的消息数组（时间正序），出错时返回空数组
   */
  async fetchRecentMessages(
    containerId: string,
    containerType: 'chat' | 'thread' = 'chat',
    limit: number = 10,
  ): Promise<Array<{ messageId: string; sender: string; senderType: string; content: string; msgType: string }>> {
    try {
      const resp = await this.client.im.message.list({
        params: {
          container_id_type: containerType,
          container_id: containerId,
          sort_type: 'ByCreateTimeDesc',
          page_size: limit,
        },
      });
      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg, containerId, containerType }, 'Failed to fetch recent messages');
        return [];
      }
      const items = resp.data?.items ?? [];
      const messages: Array<{ messageId: string; sender: string; senderType: string; content: string; msgType: string }> = [];
      for (const item of items) {
        if (item.deleted) continue;
        const msgType = item.msg_type ?? '';
        // 只提取文本和富文本消息，跳过卡片、图片等
        if (msgType !== 'text' && msgType !== 'post') continue;
        let content = '';
        try {
          const body = JSON.parse(item.body?.content ?? '{}');
          if (msgType === 'text') {
            content = body.text ?? '';
          } else if (msgType === 'post') {
            // 富文本：提取所有 text 类型元素的文本
            // 飞书 post 格式可能是直接的 {title, content} 或带语言键的 {zh_cn: {title, content}}
            const postBody = Array.isArray(body.content)
              ? body
              : (body.zh_cn || body.en_us || body.ja_jp || Object.values(body)[0]) as Record<string, unknown> | undefined;
            const title = (postBody?.title as string) ?? '';
            const textParts: string[] = title ? [title] : [];
            for (const paragraph of (postBody?.content as Array<Array<Record<string, unknown>>>) ?? []) {
              for (const element of paragraph ?? []) {
                if (element.tag === 'text') textParts.push((element.text as string) ?? '');
              }
            }
            content = textParts.join(' ');
          }
        } catch {
          continue;
        }
        if (!content.trim()) continue;
        messages.push({
          messageId: item.message_id ?? '',
          sender: item.sender?.id ?? '',
          senderType: item.sender?.sender_type ?? 'user',
          content: content.trim(),
          msgType,
        });
      }
      // API 返回的是 ByCreateTimeDesc（最新在前），反转为时间正序
      return messages.reverse();
    } catch (err) {
      logger.error({ err, containerId, containerType }, 'Error fetching recent messages');
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
