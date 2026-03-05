// ============================================================
// Memory System — Extractor (conversation → structured memories)
// ============================================================

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getMemoryStore } from './init.js';
import type { MemoryStore } from './store.js';
import type { MemoryCreateInput, MemoryType } from './types.js';

/** Context for memory extraction */
export interface ExtractionContext {
  agentId: string;
  userId: string;
  chatId: string;
  workspaceDir?: string;
  messageId?: string;
}

/** Raw extraction result from LLM */
interface ExtractedMemory {
  type: MemoryType;
  content: string;
  confidence: number;
  tags: string[];
  ttl: string | null;
  metadata: Record<string, unknown>;
}

const VALID_TYPES = new Set<string>(['fact', 'preference', 'state', 'decision', 'relation']);

const MAX_CONVERSATION_CHARS = 8000;
const MAX_MEMORIES_PER_EXTRACTION = 5;
const MIN_OUTPUT_LENGTH = 50;

// Lazy-initialized OpenAI client
let extractionClientReady: Promise<import('openai').default | null> | null = null;

function getExtractionClient(): Promise<import('openai').default | null> {
  if (extractionClientReady) return extractionClientReady;

  if (!config.memory.dashscopeApiKey || !config.memory.extractionModel) {
    extractionClientReady = Promise.resolve(null);
    return extractionClientReady;
  }

  extractionClientReady = import('openai')
    .then((mod) => new mod.default({
      apiKey: config.memory.dashscopeApiKey,
      baseURL: config.memory.dashscopeBaseUrl,
    }))
    .catch(() => {
      logger.warn('Failed to import openai SDK for memory extraction');
      return null;
    });

  return extractionClientReady;
}

const EXTRACTION_PROMPT = `你是一个记忆提取器。从以下对话中提取值得长期记住的信息。

## 输出格式
返回 JSON 数组，每个元素:
{
  "type": "fact" | "preference" | "state" | "decision" | "relation",
  "content": "简洁描述 (1-2 句话)",
  "confidence": 0.0~1.0,
  "tags": ["tag1", "tag2"],
  "ttl": "ISO 8601 日期" | null,
  "metadata": {}
}

## 提取规则
- 只提取明确的、有长期价值的信息
- 不要提取: 临时调试过程、通用知识、CLAUDE.md 中已有的信息
- preference 的 confidence 基于表达强度: "我习惯用"=0.8, "试试看"=0.4, "必须用"=1.0
- state 必须估计 ttl (会话级/天级/周级/月级)
- fact 的 confidence 通常为 1.0，除非用户表达不确定 ("好像是")
- 每次对话最多提取 5 条记忆（避免噪声）
- 如果对话中没有值得记忆的信息，返回空数组 []

## 对话内容
`;

/**
 * Extract memories from a conversation (fire-and-forget).
 * Call this after executor completes successfully.
 * Never throws — all errors are caught and logged.
 */
export async function extractMemories(
  userPrompt: string,
  assistantOutput: string,
  context: ExtractionContext,
): Promise<void> {
  if (!config.memory.enabled) return;
  if (!config.memory.extractionModel) return;

  const store = getMemoryStore();
  if (!store) return;

  if (assistantOutput.length < MIN_OUTPUT_LENGTH) return;

  try {
    const client = await getExtractionClient();
    if (!client) return;

    // Build conversation text (truncated)
    let conversation = `[用户]: ${userPrompt}\n\n[助手]: ${assistantOutput}`;
    if (conversation.length > MAX_CONVERSATION_CHARS) {
      conversation = conversation.slice(0, MAX_CONVERSATION_CHARS) + '\n...(截断)';
    }

    const response = await client.chat.completions.create({
      model: config.memory.extractionModel,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: conversation },
      ],
      temperature: 0.1,
      // DashScope extension: 记忆抽取是结构化输出任务，关闭思考模式加速响应
      enable_thinking: false,
    } as never);

    const rawContent = response.choices?.[0]?.message?.content;
    if (!rawContent) return;

    const memories = parseExtractionResponse(rawContent);
    if (memories.length === 0) return;

    const capped = memories.slice(0, MAX_MEMORIES_PER_EXTRACTION);

    for (const mem of capped) {
      await processExtractedMemory(mem, context, store);
    }

    logger.info(
      { chatId: context.chatId, userId: context.userId, count: capped.length },
      'Memories extracted from conversation',
    );
  } catch (err) {
    logger.warn({ err, chatId: context.chatId }, 'Memory extraction failed (non-blocking)');
  }
}

/**
 * Parse LLM response: try JSON.parse first, then extract from markdown code blocks.
 */
export function parseExtractionResponse(raw: string): ExtractedMemory[] {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed.memories ?? parsed.data ?? []);
    return validateMemories(arr);
  } catch {
    // Fall through to code block extraction
  }

  // Extract from markdown code block
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      const arr = Array.isArray(parsed) ? parsed : (parsed.memories ?? parsed.data ?? []);
      return validateMemories(arr);
    } catch {
      // Fall through
    }
  }

  return [];
}

function validateMemories(arr: unknown[]): ExtractedMemory[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter((item): item is ExtractedMemory => {
    if (typeof item !== 'object' || item === null) return false;
    const obj = item as Record<string, unknown>;
    return VALID_TYPES.has(obj.type as string) && typeof obj.content === 'string' && obj.content.length > 0;
  }).map((item) => ({
    type: item.type,
    content: item.content,
    confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
    tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [],
    ttl: typeof item.ttl === 'string' ? item.ttl : null,
    metadata: typeof item.metadata === 'object' && item.metadata !== null
      ? item.metadata as Record<string, unknown>
      : {},
  }));
}

async function processExtractedMemory(
  mem: ExtractedMemory,
  context: ExtractionContext,
  store: MemoryStore,
): Promise<void> {
  // Check for conflicting/duplicate memories
  const conflicts = await store.findConflicting(mem.content, mem.type, context.agentId);

  if (conflicts.length > 0) {
    const bestConflict = conflicts[0];

    if (bestConflict.type === mem.type) {
      if (mem.type === 'fact' || mem.type === 'decision') {
        // Facts/decisions: supersede if content differs
        if (bestConflict.content !== mem.content) {
          store.supersede(bestConflict.id, buildCreateInput(mem, context));
          return;
        }
      }
      // Same content: increment evidence
      store.updateEvidence(bestConflict.id);
      return;
    }
  }

  // No conflict: create new memory
  store.create(buildCreateInput(mem, context));
}

function buildCreateInput(
  mem: ExtractedMemory,
  context: ExtractionContext,
): MemoryCreateInput {
  return {
    agentId: context.agentId,
    userId: context.userId,
    chatId: context.chatId,
    workspaceDir: context.workspaceDir,
    type: mem.type,
    content: mem.content,
    confidence: mem.confidence,
    confidenceLevel: 'L0', // Auto-extracted: max 0.7
    tags: mem.tags,
    ttl: mem.ttl,
    metadata: mem.metadata,
    sourceChatId: context.chatId,
    sourceMessageId: context.messageId,
  };
}
