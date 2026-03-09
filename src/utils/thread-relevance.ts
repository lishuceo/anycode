// ============================================================
// Thread Relevance — 话题内消息是否需要 bot 回复的语义判断
// 使用 DashScope (Qwen) 小模型快速判断，复用 quick-ack 的 client
// ============================================================

import { config } from '../config.js';
import { logger } from './logger.js';
import { getClient } from './quick-ack.js';

const RELEVANCE_PROMPT = `你是一个消息路由判断器。在一个群聊话题中，机器人之前参与了对话。
现在收到一条新消息（没有 @机器人），判断这条消息是否**明确需要机器人回复**。

严格按 JSON 格式回复，不要输出任何其他内容：
{"respond": true} 或 {"respond": false}

respond: true 的条件（必须满足至少一条）：
- 消息**明确**在向机器人提问、请求帮助、布置任务
- 消息提到了机器人的名字并期望它做某事
- 消息是对机器人之前回复的追问或反馈

respond: false 的条件：
- 消息是在跟其他人聊天、讨论、感叹、评论
- 消息是自言自语、告知别人状态（如"等等"、"我看看"、"稍等"）
- 消息是对其他人说的话（即使话题中有机器人参与）
- 短句/语气词/感叹（如"哦"、"好的"、"噗"、"可以"、"稳了"）
- 无法确定是否在跟机器人说话 → false（宁可不回）`;

/**
 * 判断话题内无 @mention 的消息是否需要 bot 回复。
 *
 * 使用 Qwen 小模型快速语义判断，超时/失败默认返回 false（宁可不回，用户可 @bot 明确触发）。
 *
 * @param message 用户消息文本
 * @param botName bot 显示名称
 * @returns true = 应该回复, false = 不应该回复
 */
export async function checkThreadRelevance(
  message: string,
  botName: string,
): Promise<boolean> {
  if (!config.quickAck.enabled) return true; // 未配置小模型，默认回复

  const client = await getClient();
  if (!client) return true;

  try {
    const result = await Promise.race([
      client.chat.completions.create({
        model: config.quickAck.model,
        messages: [
          { role: 'system', content: RELEVANCE_PROMPT },
          { role: 'user', content: `机器人名称：${botName}\n消息内容：${message.slice(0, 300)}` },
        ],
        max_tokens: 20,
        temperature: 0,
        enable_thinking: false,
      } as never),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);

    if (!result) {
      logger.info('Thread relevance check timed out — defaulting to skip');
      return false;
    }

    const raw = result.choices?.[0]?.message?.content?.trim();
    if (!raw) return false;

    return parseRelevanceResponse(raw);
  } catch (err) {
    logger.warn({ err }, 'Thread relevance check failed — defaulting to skip');
    return false;
  }
}

/**
 * 解析 Qwen 返回的 JSON 判断结果。
 * 解析失败默认返回 true（宁可多回）。
 */
export function parseRelevanceResponse(raw: string): boolean {
  try {
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.respond === 'boolean') {
        logger.info({ respond: parsed.respond, raw }, 'Thread relevance check result');
        return parsed.respond;
      }
    }
  } catch {
    // JSON parse failed
  }

  // Fallback: check for keywords
  if (raw.includes('false')) {
    logger.info({ respond: false, raw, fallback: true }, 'Thread relevance check result (fallback)');
    return false;
  }

  logger.info({ respond: true, raw, fallback: true }, 'Thread relevance check result (fallback)');
  return true;
}
