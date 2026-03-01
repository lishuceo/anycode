// ============================================================
// Quick Ack — 小模型快速确认回复
// Direct 模式下，用 DashScope (Qwen) 生成自然短回复，掩盖主流程延迟
// ============================================================

import { config } from '../config.js';
import { logger } from './logger.js';

// Lazy-initialized OpenAI client (DashScope compatible mode)
let clientReady: Promise<import('openai').default | null> | null = null;

function getClient(): Promise<import('openai').default | null> {
  if (clientReady) return clientReady;

  const apiKey = config.dashscope.apiKey;
  if (!apiKey) {
    clientReady = Promise.resolve(null);
    return clientReady;
  }

  clientReady = import('openai')
    .then((mod) => new mod.default({
      apiKey,
      baseURL: config.dashscope.baseUrl,
    }))
    .catch(() => {
      logger.warn('Failed to init quick-ack OpenAI client');
      return null;
    });

  return clientReady;
}

const SYSTEM_PROMPT = `你是一个AI助手。用户刚发来一条消息，你需要生成一句简短的中文口语回应，表示你收到了消息并开始处理。

规则：
- 只回复一句话，不超过15个字
- 自然随意的口语风格，像同事之间说话
- 不要重复用户的话
- 不要使用emoji
- 不要使用"您"，用"你"
- 不要说"请稍候"这种客服腔
- 绝对不要回答用户的问题，你的角色只是"确认收到"，真正的回答会由后续流程生成
- 用户提问时，表达"我去看看/想想"；用户下指令时，表达"收到/马上做"
- 每次回复要有变化，不要总用同一句话

参考风格（不要原样照抄，用自己的话）：
提问类：嗯让我看看、这个我查一下、我先了解下情况、稍等我看看、容我想想、好问题 我查下
指令类：收到 这就弄、好嘞马上搞、OK我去改、没问题 马上、了解 着手弄、好的 开搞`;

/**
 * 用小模型生成一句自然的快速确认回复。
 * 带超时保护，超时返回 null。
 *
 * @param userMessage 用户消息（截取前 200 字）
 * @param personaHint 可选的角色提示（从 persona 文件提取的关键描述）
 * @returns 短回复文本，或 null（超时/失败/未配置）
 */
export async function generateQuickAck(
  userMessage: string,
  personaHint?: string,
): Promise<string | null> {
  if (!config.quickAck.enabled) return null;

  const client = await getClient();
  if (!client) return null;

  const systemPrompt = personaHint
    ? `${SYSTEM_PROMPT}\n\n你的角色设定：${personaHint}`
    : SYSTEM_PROMPT;

  try {
    const result = await Promise.race([
      client.chat.completions.create({
        model: config.quickAck.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage.slice(0, 200) },
        ],
        max_tokens: 30,
        temperature: 0.8,
        // DashScope extension: disable thinking chain for Qwen3 reasoning models
        enable_thinking: false,
      } as never),
      // Timeout: resolve null after configured ms
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), config.quickAck.timeoutMs),
      ),
    ]);

    if (!result) {
      logger.info('Quick ack timed out');
      return null;
    }

    const text = result.choices?.[0]?.message?.content?.trim();
    if (text) {
      logger.info({ text }, 'Quick ack generated');
    }
    return text || null;
  } catch (err) {
    logger.warn({ err }, 'Quick ack generation failed');
    return null;
  }
}

/**
 * Eagerly initialize the OpenAI client at startup to avoid cold-start latency
 * on the first quick ack call (dynamic import + client creation).
 */
export function warmup(): void {
  if (!config.quickAck.enabled) return;
  getClient().then((c) => {
    if (c) logger.info('Quick ack client warmed up');
  }).catch(() => {
    // already logged in getClient
  });
}

/** Reset client for testing */
export function _resetClient(): void {
  clientReady = null;
}
