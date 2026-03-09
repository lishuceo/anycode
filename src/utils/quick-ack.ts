// ============================================================
// Quick Ack — 小模型快速确认回复
// Direct 模式下，用 DashScope (Qwen) 生成自然短回复，掩盖主流程延迟
// ============================================================

import { config } from '../config.js';
import { logger } from './logger.js';

// Lazy-initialized OpenAI client (DashScope compatible mode)
let clientReady: Promise<import('openai').default | null> | null = null;

/** Lazy-init DashScope OpenAI client（也供 thread-relevance 复用） */
export function getClient(): Promise<import('openai').default | null> {
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

const SYSTEM_PROMPT = `你是一个AI助手。用户刚发来一条消息，你需要：
1. 判断消息类型
2. 生成一句简短的中文口语回应

请严格按以下 JSON 格式回复，不要输出任何其他内容：
{"type":"greeting","text":"你好呀"}

type 取值规则：
- "greeting"：消息是**纯问候/寒暄**，除了打招呼没有任何实质内容。如：你好、嗨、早、在吗、哈喽
- "other"：消息包含提问、指令、请求或任何实质内容，即使开头有问候也算 other。如：你好帮我看个bug、你是谁、帮我查下PR

text 规则：
- 只回复一句话，不超过15个字
- 自然随意的口语风格，像同事之间说话
- 不要重复用户的话
- 不要使用emoji
- 不要使用"您"，用"你"
- 不要说"请稍候"这种客服腔
- 每次回复要有变化，不要总用同一句话

**最重要的规则：当 type 为 other 时，绝对不要回答、解释或回应用户消息的内容。你不知道答案，也不应该猜测。只说"收到了"这种纯确认。**
错误示例（绝对禁止）：
- 用户问"你有websearch么" → "没有，我直接查知识库" ← 这是在回答问题，禁止！
- 用户说"搜一下" → "好嘞，搜什么？" ← 这是在追问，禁止！
- 用户问"这个bug怎么修" → "可以试试重启" ← 这是在给建议，禁止！

不同 type 的 text 风格（不要原样照抄，用自己的话）：
greeting：自然地打招呼回应，如：你好呀、嗨、在的、哈喽、早呀、嘿 在呢
other：只说收到确认，如：收到 马上看、好嘞 这就处理、嗯 稍等、收到了`;

/** Quick ack result with message classification */
export interface QuickAckResult {
  /** 回复文本 */
  text: string;
  /** 消息分类: greeting = 纯问候（可跳过 Claude）, other = 需要 Claude 处理 */
  type: 'greeting' | 'other';
}

/**
 * 用小模型生成一句自然的快速确认回复，同时返回消息分类。
 * 带超时保护，超时返回 null。
 *
 * @param userMessage 用户消息（截取前 200 字）
 * @param personaHint 可选的角色提示（从 persona 文件提取的关键描述）
 * @returns QuickAckResult（含分类和文本），或 null（超时/失败/未配置）
 */
export async function generateQuickAck(
  userMessage: string,
  personaHint?: string,
): Promise<QuickAckResult | null> {
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
        max_tokens: 60,
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

    const raw = result.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    return parseQuickAckResponse(raw);
  } catch (err) {
    logger.warn({ err }, 'Quick ack generation failed');
    return null;
  }
}

/**
 * Parse the JSON response from the quick-ack model.
 * Falls back to type=other with raw text if JSON parsing fails.
 */
export function parseQuickAckResponse(raw: string): QuickAckResult | null {
  try {
    // Try to extract JSON from the response (model might wrap in markdown code blocks)
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      const type = parsed.type === 'greeting' ? 'greeting' : 'other';
      if (text) {
        logger.info({ text, type }, 'Quick ack generated');
        return { text, type };
      }
    }
  } catch {
    // JSON parse failed — fall through
  }

  // Fallback: treat as "other" with raw text (backwards compatible)
  if (raw) {
    logger.info({ text: raw, type: 'other', fallback: true }, 'Quick ack generated (fallback)');
    return { text: raw, type: 'other' };
  }
  return null;
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
