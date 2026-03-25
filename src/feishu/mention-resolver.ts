/**
 * @mention 解析器：将文本中的 @姓名 转换为飞书 post 格式的 at 标签
 */

import { feishuClient } from './client.js';
import { chatBotRegistry } from './bot-registry.js';
import { logger } from '../utils/logger.js';

type PostElement = Record<string, unknown>;

/**
 * 解析文本中的 @mention 并转换为飞书 post 格式。
 *
 * 流程：
 * 1. 快速检查文本是否包含 @，没有则返回 null
 * 2. 获取群成员列表，构建 姓名→open_id 映射
 * 3. 按姓名长度降序构建正则（贪婪匹配，避免 @张三丰 被 @张三 先吃掉）
 * 4. 逐行拆分文本，将 @姓名 替换为 { tag: 'at', user_id } 元素
 *
 * @returns post content 二维数组（段落→元素），无匹配时返回 null
 */
export async function resolveMentions(
  text: string,
  chatId: string,
): Promise<Array<Array<PostElement>> | null> {
  // 快速跳过：不含 @ 则直接返回
  if (!text.includes('@')) return null;

  try {
    const members = await feishuClient.getChatMembers(chatId);

    // 构建 姓名→open_id 映射
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

    if (nameToOpenId.size === 0) return null;

    return convertTextWithMentions(text, nameToOpenId);
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to resolve mentions, falling back to plain text');
    return null;
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
