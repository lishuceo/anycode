import * as lark from '@larksuiteoapi/node-sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { formatMergeForwardSubMessage } from './message-parser.js';

/**
 * Serialize card to JSON, escaping ${...} patterns to prevent
 * Feishu from interpreting them as card template variables.
 * Uses zero-width space (U+200B) between $ and { to break the pattern.
 *
 * NOTE: This will also escape intentional Feishu card template variables.
 * If template variables are needed in the future, those cards should
 * bypass this function and use JSON.stringify directly.
 */
export function serializeCard(card: Record<string, unknown>): string {
  return JSON.stringify(card).replaceAll('${', '$\u200B{');
}

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
          content: serializeCard(card),
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
          content: serializeCard(card),
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
   * 回复富文本 (post) 消息
   */
  async replyPost(
    messageId: string,
    content: Array<Array<Record<string, unknown>>>,
  ): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'post',
          content: JSON.stringify({ zh_cn: { title: '', content } }),
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to reply post message');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error replying post message');
      return undefined;
    }
  }

  /**
   * 在话题中回复富文本 (post) 消息
   */
  async replyPostInThread(
    threadMessageId: string,
    content: Array<Array<Record<string, unknown>>>,
  ): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: threadMessageId },
        data: {
          msg_type: 'post',
          content: JSON.stringify({ zh_cn: { title: '', content } }),
          reply_in_thread: true,
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to reply post in thread');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error replying post in thread');
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
          content: serializeCard(card),
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
          content: serializeCard(card),
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
          content: serializeCard(card),
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
   * 获取群的所有成员列表
   */
  async getChatMembers(chatId: string): Promise<Array<{
    memberId: string;
    name: string;
    memberIdType: string;
    tenantKey?: string;
  }>> {
    const members: Array<{ memberId: string; name: string; memberIdType: string; tenantKey?: string }> = [];
    for await (const page of await this.client.im.chatMembers.getWithIterator({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100 },
    })) {
      for (const item of page?.items ?? []) {
        if (item.member_id) {
          members.push({
            memberId: item.member_id,
            name: item.name ?? '[未知]',
            memberIdType: item.member_id_type ?? 'open_id',
            tenantKey: item.tenant_key,
          });
        }
      }
    }
    return members;
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
   * 下载消息中的文件资源
   * 使用 im.messageResource.get API（与图片下载相同接口，type 为 'file'）
   */
  async downloadMessageFile(messageId: string, fileKey: string): Promise<Buffer> {
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: 'file' },
        path: { message_id: messageId, file_key: fileKey },
      });

      const stream = resp.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      logger.error({ err, messageId, fileKey }, 'Failed to download message file');
      throw err;
    }
  }

  /**
   * 通过消息 ID 获取消息详情（含子消息）
   * 用于展开 merge_forward 合并转发消息
   *
   * @param messageId - 消息 ID
   * @returns API 返回的 items 数组，或 null
   */
  async getMessageById(messageId: string): Promise<Array<{
    message_id?: string;
    msg_type?: string;
    body?: { content: string };
    sender?: { id: string; id_type: string; sender_type: string; tenant_key?: string };
    mentions?: Array<{ key: string; id: string; id_type: string; name: string; tenant_key?: string }>;
    upper_message_id?: string;
    create_time?: string;
  }> | null> {
    try {
      const resp = await this.client.im.message.get({
        path: { message_id: messageId },
      });
      if (resp.code !== 0) {
        logger.warn({ code: resp.code, msg: resp.msg, messageId }, 'Failed to get message by ID');
        return null;
      }
      return (resp.data?.items as Array<{
        message_id?: string;
        msg_type?: string;
        body?: { content: string };
        sender?: { id: string; id_type: string; sender_type: string; tenant_key?: string };
        mentions?: Array<{ key: string; id: string; id_type: string; name: string; tenant_key?: string }>;
        upper_message_id?: string;
        create_time?: string;
      }>) ?? null;
    } catch (err) {
      logger.error({ err, messageId }, 'Error getting message by ID');
      return null;
    }
  }

  /**
   * 拉取群聊或话题的最近消息（用于注入聊天上下文）
   *
   * 统一入口：支持群聊主面板（chat）和话题（thread）两种容器，
   * 解析 text + post（含 locale-wrapped）消息，处理 @mention 占位符。
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
  ): Promise<Array<{ messageId: string; senderId: string; senderType: 'user' | 'app'; content: string; msgType: string; createTime?: string }>> {
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
        logger.warn({ code: resp.code, msg: resp.msg, containerId, containerType }, 'Failed to fetch recent messages');
        return [];
      }
      const items = resp.data?.items ?? [];
      const messages: Array<{ messageId: string; senderId: string; senderType: 'user' | 'app'; content: string; msgType: string; createTime?: string }> = [];
      // 诊断：记录 API 返回的原始消息分布
      const diagSkipped: Array<{ id: string; type: string; reason: string }> = [];
      for (const item of items) {
        if (item.deleted) { diagSkipped.push({ id: item.message_id ?? '?', type: item.msg_type ?? '?', reason: 'deleted' }); continue; }
        const msgType = item.msg_type ?? '';
        if (msgType !== 'text' && msgType !== 'post' && msgType !== 'merge_forward' && msgType !== 'file' && msgType !== 'image') { diagSkipped.push({ id: item.message_id ?? '?', type: msgType, reason: 'unsupported_type' }); continue; }
        const senderType = item.sender?.sender_type === 'app' ? 'app' as const : 'user' as const;
        let content = '';
        // file / image 类型：仅显示文件名占位（不下载内容，避免延迟和 token 消耗）
        // 用户如需分析文件，可引用回复该消息并 @bot
        if (msgType === 'file') {
          try {
            const body = JSON.parse(item.body?.content ?? '{}');
            const fileName = (body.file_name as string) || '未知文件';
            content = `[文件: ${fileName}]`;
          } catch {
            content = '[文件]';
          }
        } else if (msgType === 'image') {
          content = '[图片]';
        } else if (msgType === 'merge_forward') {
          const messageId = item.message_id;
          if (messageId) {
            try {
              const subItems = await this.getMessageById(messageId);
              if (subItems && subItems.length > 0) {
                const subMessages = subItems
                  .filter(sub => sub.upper_message_id && sub.message_id !== messageId)
                  .sort((a, b) => parseInt(a.create_time || '0', 10) - parseInt(b.create_time || '0', 10))
                  .slice(0, 20); // 历史上下文中限制 20 条
                if (subMessages.length > 0) {
                  const lines = ['[合并转发的聊天记录]'];
                  for (const sub of subMessages) {
                    const subContent = formatMergeForwardSubMessage(sub.body?.content ?? '{}', sub.msg_type || 'text', sub.mentions);
                    if (subContent.trim()) lines.push(`- ${subContent.trim()}`);
                  }
                  content = lines.join('\n');
                } else {
                  content = '[合并转发的聊天记录]';
                }
              } else {
                content = '[合并转发的聊天记录]';
              }
            } catch {
              content = '[合并转发的聊天记录]';
            }
          } else {
            content = '[合并转发的聊天记录]';
          }
        } else {
          // text 和 post 类型的 body.content 是 JSON 格式
          try {
            const body = JSON.parse(item.body?.content ?? '{}');
            if (msgType === 'text') {
              let text = (body.text as string) ?? '';
              // 解析飞书 @mention 占位符（@_user_1 → @用户名）
              if (text && Array.isArray(item.mentions)) {
                for (const m of item.mentions as Array<{ key?: string; name?: string }>) {
                  if (m.key) {
                    text = text.replaceAll(m.key, m.name ? `@${m.name}` : '');
                  }
                }
              }
              // 飞书引用回复时 text 可能被 <p> 等 HTML 标签包裹
              if (text.includes('<')) {
                text = text.replace(/<[^>]+>/g, '').trim();
              }
              content = text;
            } else if (msgType === 'post') {
              // 飞书 post 格式可能是直接的 {title, content} 或带语言键的 {zh_cn: {title, content}}
              const postBody = Array.isArray(body.content)
                ? body
                : (body.zh_cn || body.en_us || body.ja_jp || Object.values(body)[0]) as Record<string, unknown> | undefined;
              const title = (postBody?.title as string) ?? '';
              const textParts: string[] = title ? [title] : [];
              for (const paragraph of (postBody?.content as Array<Array<Record<string, unknown>>>) ?? []) {
                for (const element of paragraph ?? []) {
                  if (element.tag === 'text') textParts.push((element.text as string) ?? '');
                  else if (element.tag === 'a') {
                    const linkText = (element.text as string) ?? '';
                    const href = (element.href as string) ?? '';
                    textParts.push(linkText && href ? `[${linkText}](${href})` : href || linkText);
                  }
                  else if (element.tag === 'at') {
                    const atName = (element.user_name as string) ?? '';
                    if (atName) textParts.push(`@${atName}`);
                  }
                  else if (element.tag === 'img') textParts.push('[图片]');
                  else if (element.tag === 'media') textParts.push('[视频]');
                  else if (element.tag === 'emotion') {
                    const emojiType = (element.emoji_type as string) ?? '';
                    textParts.push(emojiType ? `[${emojiType}]` : '[表情]');
                  }
                  else if (element.tag === 'code_block') {
                    const lang = (element.language as string) ?? '';
                    const code = (element.text as string) ?? '';
                    textParts.push(lang ? `\`\`\`${lang}\n${code}\`\`\`` : `\`\`\`\n${code}\`\`\``);
                  }
                  else if (element.tag === 'md') textParts.push((element.text as string) ?? '');
                  else if (element.tag === 'hr') textParts.push('---');
                }
              }
              content = textParts.join(' ');
            }
          } catch (parseErr) {
            diagSkipped.push({ id: item.message_id ?? '?', type: msgType, reason: `parse_error: ${(parseErr as Error).message?.slice(0, 80)}` });
            continue;
          }
        }
        if (!content.trim()) { diagSkipped.push({ id: item.message_id ?? '?', type: msgType, reason: 'empty_content' }); continue; }
        messages.push({
          messageId: item.message_id ?? '',
          senderId: item.sender?.id ?? '',
          senderType,
          content: content.trim(),
          msgType,
          createTime: item.create_time ?? undefined,
        });
      }
      // 诊断：记录消息获取和过滤的详情
      logger.info(
        {
          containerId,
          containerType,
          apiItemCount: items.length,
          parsedCount: messages.length,
          skipped: diagSkipped,
          parsedMsgIds: messages.map(m => m.messageId),
          parsedMsgTypes: messages.map(m => m.msgType),
        },
        'fetchRecentMessages diagnostic',
      );
      // API 返回的是 ByCreateTimeDesc（最新在前），反转为时间正序
      return messages.reverse();
    } catch (err) {
      logger.warn({ err, containerId, containerType }, 'Error fetching recent messages');
      return [];
    }
  }

  /**
   * 发送仅特定人可见的临时卡片（ephemeral message）
   * 群聊中仅 openId 用户可见，带"仅对你可见"标识
   */
  async sendEphemeralCard(
    chatId: string,
    openId: string,
    card: Record<string, unknown>,
  ): Promise<string | undefined> {
    try {
      const resp = await this.client.request<{
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      }>({
        method: 'POST',
        url: '/open-apis/ephemeral/v1/send',
        data: {
          chat_id: chatId,
          open_id: openId,
          msg_type: 'interactive',
          card,
        },
      });

      if (resp.code !== 0) {
        logger.error({ code: resp.code, msg: resp.msg }, 'Failed to send ephemeral card');
        return undefined;
      }

      return resp.data?.message_id;
    } catch (err) {
      logger.error({ err }, 'Error sending ephemeral card');
      return undefined;
    }
  }

  /**
   * 给消息添加表情回复（reaction）
   * 用于在话题内 @bot 时立即反馈（替代 quick-ack）
   *
   * @param messageId - 要添加表情的消息 ID
   * @param emojiType - 表情类型（如 "OnIt", "THUMBSUP" 等飞书 emoji_type）
   * @returns reaction_id（用于后续删除），失败返回 undefined
   */
  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });

      if (resp.code !== 0) {
        logger.warn({ code: resp.code, msg: resp.msg, messageId, emojiType }, 'Failed to add reaction');
        return undefined;
      }

      return resp.data?.reaction_id;
    } catch (err) {
      logger.warn({ err, messageId, emojiType }, 'Error adding reaction');
      return undefined;
    }
  }

  /**
   * 删除消息的表情回复（reaction）
   *
   * @param messageId - 消息 ID
   * @param reactionId - 要删除的 reaction_id（由 addReaction 返回）
   */
  async removeReaction(messageId: string, reactionId: string): Promise<boolean> {
    try {
      const resp = await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });

      if (resp.code !== 0) {
        logger.warn({ code: resp.code, msg: resp.msg, messageId, reactionId }, 'Failed to remove reaction');
        return false;
      }

      return true;
    } catch (err) {
      logger.warn({ err, messageId, reactionId }, 'Error removing reaction');
      return false;
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
