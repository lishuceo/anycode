/**
 * @mention 解析器：将文本中的 @姓名 转换为飞书 at 标签
 *
 * 支持两种输出格式：
 * - post 格式：用于 sendPost / replyPost（富文本消息）
 * - card 格式：用于卡片 lark_md（<at id=open_id></at>）
 */

import { feishuClient } from './client.js';
import { chatBotRegistry } from './bot-registry.js';
import { logger } from '../utils/logger.js';

type PostElement = Record<string, unknown>;

/**
 * 构建 姓名→open_id 映射（群成员 + bot registry）
 */
async function buildNameMap(chatId: string): Promise<Map<string, string>> {
  const members = await feishuClient.getChatMembers(chatId);
  const nameToOpenId = new Map<string, string>();
  for (const m of members) {
    if (m.name && m.name !== '[未知]') {
      nameToOpenId.set(m.name, m.memberId);
    }
  }
  // 合并 bot registry 中已知的 bot（getChatMembers 不返回 bot 成员）
  const knownBots = chatBotRegistry.getBots(chatId);
  for (const bot of knownBots) {
    if (bot.name && !nameToOpenId.has(bot.name)) {
      nameToOpenId.set(bot.name, bot.openId);
    }
  }
  return nameToOpenId;
}

/**
 * 构建按姓名长度降序排列的匹配正则（贪婪匹配，避免 @张三丰 被 @张三 先吃掉）
 * @returns 正则表达式，或 null（无可匹配的名字）
 */
function buildMentionPattern(nameToOpenId: Map<string, string>): RegExp | null {
  const names = [...nameToOpenId.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  const escapedNames = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`@(${escapedNames.join('|')})`, 'g');
}

/**
 * 解析文本中的 @mention 并转换为飞书 post 格式。
 * @returns post content 二维数组（段落→元素），无匹配时返回 null
 */
export async function resolveMentions(
  text: string,
  chatId: string,
): Promise<Array<Array<PostElement>> | null> {
  if (!text.includes('@')) return null;

  try {
    const nameToOpenId = await buildNameMap(chatId);
    if (nameToOpenId.size === 0) return null;
    return convertTextWithMentions(text, nameToOpenId);
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to resolve mentions, falling back to plain text');
    return null;
  }
}

/**
 * 解析文本中的 @mention 并转换为卡片 lark_md 格式（<at id=open_id></at>）。
 * @returns 替换后的文本字符串，无匹配时返回原文
 */
export async function resolveCardMentions(
  text: string,
  chatId: string,
): Promise<string> {
  if (!text.includes('@')) return text;

  try {
    const nameToOpenId = await buildNameMap(chatId);
    if (nameToOpenId.size === 0) return text;
    return convertTextToCardMentions(text, nameToOpenId);
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to resolve card mentions');
    return text;
  }
}

/**
 * 纯函数：将文本中的 @姓名 替换为 post 元素。
 * 导出供测试使用。
 */
export function convertTextWithMentions(
  text: string,
  nameToOpenId: Map<string, string>,
): Array<Array<PostElement>> | null {
  // 按姓名长度降序排列，优先匹配较长的名字
  const names = [...nameToOpenId.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;

  const escapedNames = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const pattern = new RegExp(`@(${escapedNames.join('|')})`, 'g');

  // 先检测是否有任何匹配
  if (!pattern.test(text)) return null;
  pattern.lastIndex = 0;

  const lines = text.split('\n');
  const paragraphs: Array<Array<PostElement>> = [];

  for (const line of lines) {
    const elements: PostElement[] = [];
    let lastIndex = 0;
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const name = match[1];
      const openId = nameToOpenId.get(name);
      if (!openId) continue;

      // @ 前面的文本
      if (match.index > lastIndex) {
        elements.push({ tag: 'text', text: line.slice(lastIndex, match.index) });
      }
      elements.push({ tag: 'at', user_id: openId });
      lastIndex = match.index + match[0].length;
    }

    // 行尾剩余文本
    if (lastIndex < line.length) {
      elements.push({ tag: 'text', text: line.slice(lastIndex) });
    }

    // 空行也保留（段落分隔）
    if (elements.length === 0) {
      elements.push({ tag: 'text', text: '' });
    }

    paragraphs.push(elements);
  }

  return paragraphs;
}

/**
 * 纯函数：将文本中的 @姓名 替换为卡片 lark_md 的 at 标签。
 * 导出供测试使用。
 */
export function convertTextToCardMentions(
  text: string,
  nameToOpenId: Map<string, string>,
): string {
  const pattern = buildMentionPattern(nameToOpenId);
  if (!pattern) return text;

  return text.replace(pattern, (_, name) => {
    const openId = nameToOpenId.get(name);
    return openId ? `<at id=${openId}></at>` : `@${name}`;
  });
}
