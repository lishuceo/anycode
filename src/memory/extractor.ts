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
  /** Current user's display name (for entity disambiguation in extraction prompt) */
  userName?: string;
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
- 判断标准：这条信息一周后还有价值吗？如果只在当前迭代有意义，不提取
- preference 的 confidence 基于表达强度: "我习惯用"=0.8, "试试看"=0.4, "必须用"=1.0
- state 必须估计 ttl (会话级/天级/周级/月级)，无法估计 ttl 的不要归为 state
- fact 的 confidence 通常为 1.0，除非用户表达不确定 ("好像是")
- 每次对话最多提取 5 条记忆（避免噪声）
- 如果对话中没有值得记忆的信息，返回空数组 []

## 不要提取的内容
- PR/MR 状态："PR #161 已合并"、"已提交并推送" → 不提取（git log 可查）
- 修复方案："修复方案：添加 skipQuickAck 参数" → 不提取（代码即文档）
- 部署状态："已部署到生产环境"、"已上线" → 不提取（运维日志可查）
- 临时调试：临时调试过程、错误排查步骤 → 不提取
- 通用知识：编程常识、框架文档中的内容 → 不提取
- 项目配置文件中已有的信息（如 CLAUDE.md）→ 不提取

## 类型判定规则
- decision: 仅用于"为什么选 A 而不选 B"的架构/技术决策
  ✓ "选择 Vitest 而非 Jest，因为速度更快且原生 ESM 支持"
  ✗ "修复方案：添加参数"（不提取）
  ✗ "确认无需修改"（不提取）
- relation: 仅用于实体间的稳定关系
  ✓ "模块 A 依赖模块 B 提供的认证服务"
  ✗ "张三负责这个 PR"（临时分工，不提取）
- state: 仅用于会变化的当前状态，必须有明确的 ttl
  ✗ "系统通过环境变量 X 启用"（这是 fact，不是 state）
- fact: 长期稳定的技术事实、架构信息、人员角色
  ✓ "项目使用 ESM + TypeScript 5.7"
  ✓ "张三是后端负责人"

## 身份识别规则
- 对话中方括号标注的名字 (如 [姜黎]) 是说话者/评估者，不是被讨论的对象
- 严格区分"谁在说"和"说的是谁"，不要把说话者误认为被评估/被讨论的人
- 记忆中引用人名时，必须准确标注其角色 (评估者/候选人/负责人等)

## 覆盖规则
当对话中出现事实更新或决策变更时 (如 "从 X 迁移到 Y"、"不再用 X 改用 Y"):
- 提取新记忆，系统会自动检测并覆盖旧的同类记忆

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
    // Prefix with user identity so the extraction LLM can distinguish speakers from subjects
    const userLabel = context.userName ? `[${context.userName}]` : '[用户]';
    let conversation = `${userLabel}: ${userPrompt}\n\n[助手]: ${assistantOutput}`;
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

/** Patterns matching transient/ephemeral content that should not be stored */
const TRANSIENT_PATTERNS = [
  /PR\s*#\d+\s*(已合并|已创建|已提交|已关闭)/,
  /已提交并推送/,
  /已部署/,
  /已上线/,
  /已合并.*部署/,
];

/** Min content length to avoid overly vague memories */
const MIN_CONTENT_LENGTH = 15;

function validateMemories(arr: unknown[]): ExtractedMemory[] {
  if (!Array.isArray(arr)) return [];
  const valid = arr.filter((item): item is Record<string, unknown> => {
    if (typeof item !== 'object' || item === null) return false;
    const obj = item as Record<string, unknown>;
    return VALID_TYPES.has(obj.type as string) && typeof obj.content === 'string' && (obj.content as string).length > 0;
  });
  return valid
    .map((obj) => ({
      type: obj.type as MemoryType,
      content: obj.content as string,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.7,
      tags: Array.isArray(obj.tags) ? (obj.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
      ttl: typeof obj.ttl === 'string' ? obj.ttl : null,
      metadata: typeof obj.metadata === 'object' && obj.metadata !== null
        ? obj.metadata as Record<string, unknown>
        : {},
    }))
    .filter((mem) => {
      // Reject too-short content
      if (mem.content.length < MIN_CONTENT_LENGTH) return false;
      // Reject transient/ephemeral content
      if (TRANSIENT_PATTERNS.some((re) => re.test(mem.content))) return false;
      // state without ttl → demote to fact (inline mutation)
      if (mem.type === 'state' && !mem.ttl) {
        (mem as { type: MemoryType }).type = 'fact';
      }
      return true;
    });
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
          store.supersede(
            bestConflict.id,
            buildCreateInput(mem, context),
          );
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
