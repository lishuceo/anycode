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

  constructor() {
    this.client = new lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
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

  /** 获取原始 client 以便直接使用 */
  get raw(): lark.Client {
    return this.client;
  }
}

/** 全局单例 */
export const feishuClient = new FeishuClient();
