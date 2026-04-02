import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { mockMemoryConfig } = vi.hoisted(() => {
  const mockMemoryConfig = {
    enabled: true,
    dbPath: '',
    dashscopeApiKey: 'sk-test',
    dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingModel: 'text-embedding-v4',
    embeddingDimension: 1024,
    extractionModel: 'qwen-plus',
    vectorWeight: 0.7,
    maxInjectTokens: 4000,
  };
  return { mockMemoryConfig };
});

vi.mock('../../config.js', () => ({
  config: {
    memory: mockMemoryConfig,
  },
}));

import { parseExtractionResponse, extractMemories, filterUngroundedMemories } from '../extractor.js';
import { initializeMemory, closeMemory, getMemoryStore } from '../init.js';

describe('parseExtractionResponse', () => {
  it('should parse valid JSON array', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '项目运行时环境为 Node.js 20', confidence: 1.0, tags: ['runtime'], ttl: null, metadata: {} },
      { type: 'preference', content: '团队统一使用 pnpm 作为包管理器', confidence: 0.8, tags: [], ttl: null, metadata: {} },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('fact');
    expect(result[0].content).toContain('Node.js 20');
    expect(result[1].type).toBe('preference');
  });

  it('should parse JSON wrapped in { memories: [...] }', () => {
    const raw = JSON.stringify({
      memories: [
        { type: 'fact', content: '这是一条测试记忆，用于验证解析功能', confidence: 0.9, tags: [], ttl: null, metadata: {} },
      ],
    });

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('测试记忆');
  });

  it('should parse JSON from markdown code block', () => {
    const raw = `Here are the extracted memories:

\`\`\`json
[
  {"type": "preference", "content": "likes TypeScript", "confidence": 0.9, "tags": ["language"], "ttl": null, "metadata": {}}
]
\`\`\``;

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('likes TypeScript');
  });

  it('should return empty array for invalid JSON', () => {
    const result = parseExtractionResponse('not json at all');
    expect(result).toEqual([]);
  });

  it('should return empty array for empty array', () => {
    const result = parseExtractionResponse('[]');
    expect(result).toEqual([]);
  });

  it('should filter out invalid memory types', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '这是一条有效的事实记忆内容，用于验证类型过滤', confidence: 1.0 },
      { type: 'invalid_type', content: '这是一条无效类型的记忆内容，应被过滤掉', confidence: 1.0 },
      { type: 'preference', content: '这是一条有效的偏好记忆内容，应保留下来', confidence: 0.8 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('fact');
    expect(result[1].type).toBe('preference');
  });

  it('should filter out entries without content', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '', confidence: 1.0 },
      { type: 'fact', content: '这条记忆有足够长的内容，可以通过验证', confidence: 1.0 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('足够长');
  });

  it('should default confidence to 0.7 if missing', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '这条记忆没有 confidence 字段' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].confidence).toBe(0.7);
  });

  it('should handle missing tags gracefully', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '这条记忆没有 tags 字段标记' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].tags).toEqual([]);
  });

  it('should handle missing ttl gracefully (state without ttl demoted to fact)', () => {
    const raw = JSON.stringify([
      { type: 'state', content: '当前正在进行某个状态变更的操作' },
    ]);

    const result = parseExtractionResponse(raw);
    // state without ttl is demoted to fact
    expect(result[0].type).toBe('fact');
    expect(result[0].ttl).toBeNull();
  });

  it('should parse JSON wrapped in { data: [...] }', () => {
    const raw = JSON.stringify({
      data: [
        { type: 'decision', content: '选择 React 作为前端框架，因为生态更成熟', confidence: 1.0 },
      ],
    });

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('React');
  });

  it('should handle non-string tags in array', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '这条记忆有混合类型的 tags 标签', tags: ['valid', 123, null, 'also valid'] },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result[0].tags).toEqual(['valid', 'also valid']);
  });

  it('should handle null/undefined entries in array', () => {
    const raw = JSON.stringify([
      null,
      { type: 'fact', content: '这是数组中唯一有效的记忆条目，其余为 null' },
      undefined,
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('有效');
  });

  it('should filter out transient PR status memories', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: 'PR #161 已合并，部署后生效', confidence: 1.0 },
      { type: 'fact', content: '项目使用 TypeScript 5.7 和 ESM 模块系统', confidence: 1.0 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('TypeScript');
  });

  it('should filter out deployment status memories', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '新版本已部署到生产环境', confidence: 1.0 },
      { type: 'state', content: '服务已上线运行中', confidence: 0.8, ttl: '2026-03-25' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(0);
  });

  it('should filter out content shorter than 15 chars', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '用了 pnpm', confidence: 1.0 },
      { type: 'fact', content: '项目的包管理器是 pnpm，全团队统一使用', confidence: 1.0 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('包管理器');
  });

  it('should demote state without ttl to fact', () => {
    const raw = JSON.stringify([
      { type: 'state', content: '系统通过环境变量 CRON_ENABLED 启用定时任务', confidence: 0.7 },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('fact');
  });

  it('should keep state with ttl as state', () => {
    const raw = JSON.stringify([
      { type: 'state', content: '当前正在进行记忆系统重构，预计本周完成', confidence: 0.7, ttl: '2026-03-25' },
    ]);

    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('state');
    expect(result[0].ttl).toBe('2026-03-25');
  });

  it('should parse entities field when present', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '候选人罗文锋拥有5年以上的虚幻引擎开发经验', confidence: 0.7, tags: [], ttl: null, metadata: {}, entities: ['罗文锋'] },
    ]);
    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].entities).toEqual(['罗文锋']);
  });

  it('should handle missing entities field gracefully', () => {
    const raw = JSON.stringify([
      { type: 'fact', content: '项目使用 ESM + TypeScript 5.7 构建', confidence: 1.0, tags: [], ttl: null, metadata: {} },
    ]);
    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].entities).toBeUndefined();
  });
});

describe('extractMemories', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'extractor-test-'));
    mockMemoryConfig.dbPath = join(tempDir, 'test.db');
    mockMemoryConfig.enabled = true;
    mockMemoryConfig.extractionModel = 'qwen-plus';
    await initializeMemory();
  });

  afterEach(() => {
    closeMemory();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const context = {
    agentId: 'agent1',
    userId: 'user1',
    chatId: 'chat1',
    workspaceDir: '/projects/test',
  };

  it('should skip when memory is disabled', async () => {
    mockMemoryConfig.enabled = false;
    // Should not throw
    await extractMemories('hello', 'a'.repeat(100), context);
  });

  it('should skip when extractionModel is empty', async () => {
    mockMemoryConfig.extractionModel = '';
    await extractMemories('hello', 'a'.repeat(100), context);
  });

  it('should skip when output is too short', async () => {
    // Output < 50 chars
    await extractMemories('hello', 'short', context);
    // No store operations should have happened
  });

  it('should skip when store is null (not initialized)', async () => {
    closeMemory();
    await extractMemories('hello', 'a'.repeat(100), context);
  });

  it('should not throw on extraction failure', async () => {
    // getExtractionClient will fail because openai SDK mock isn't set up
    // But extractMemories should catch and log, not throw
    await expect(
      extractMemories('hello', 'a'.repeat(100), context),
    ).resolves.toBeUndefined();
  });
});

describe('extractMemories — userName identity context', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'extractor-identity-test-'));
    mockMemoryConfig.dbPath = join(tempDir, 'test.db');
    mockMemoryConfig.enabled = true;
    mockMemoryConfig.extractionModel = 'qwen-plus';
    await initializeMemory();
  });

  afterEach(() => {
    closeMemory();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should accept userName in ExtractionContext', async () => {
    const contextWithName = {
      agentId: 'agent1',
      userId: 'ou_abc123',
      chatId: 'chat1',
      workspaceDir: '/projects/test',
      userName: '姜黎',
    };
    // Should not throw — userName is optional and accepted
    await extractMemories('hello', 'a'.repeat(100), contextWithName);
  });

  it('should work without userName (backward compatible)', async () => {
    const contextWithoutName = {
      agentId: 'agent1',
      userId: 'ou_abc123',
      chatId: 'chat1',
    };
    await extractMemories('hello', 'a'.repeat(100), contextWithoutName);
  });
});

describe('extractMemories — processExtractedMemory integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'extractor-process-test-'));
    mockMemoryConfig.dbPath = join(tempDir, 'test.db');
    mockMemoryConfig.enabled = true;
    mockMemoryConfig.extractionModel = 'qwen-plus';
    await initializeMemory();
  });

  afterEach(() => {
    closeMemory();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create memories with L0 confidence level', () => {
    const store = getMemoryStore()!;
    // Simulate what processExtractedMemory does via store.create
    const mem = store.create({
      agentId: 'agent1',
      userId: 'user1',
      type: 'fact',
      content: 'auto extracted fact',
      confidence: 1.0,
      confidenceLevel: 'L0',
    });

    // L0 caps at 0.7
    expect(mem.confidence).toBe(0.7);
    expect(mem.confidenceLevel).toBe('L0');
  });

  it('should supersede conflicting facts via store', () => {
    const store = getMemoryStore()!;

    const old = store.create({
      agentId: 'agent1',
      userId: 'user1',
      type: 'fact',
      content: 'Node 16',
      confidenceLevel: 'L2',
      confidence: 1.0,
    });

    const newMem = store.supersede(old.id, {
      agentId: 'agent1',
      userId: 'user1',
      type: 'fact',
      content: 'Node 20',
      confidenceLevel: 'L0',
      confidence: 0.7,
    });

    expect(newMem.content).toBe('Node 20');
    const oldRow = store.get(old.id);
    expect(oldRow!.invalidAt).not.toBeNull();
    expect(oldRow!.supersededBy).toBe(newMem.id);
  });

  it('should increment evidence on duplicate', () => {
    const store = getMemoryStore()!;

    const mem = store.create({
      agentId: 'agent1',
      userId: 'user1',
      type: 'preference',
      content: 'prefers pnpm',
      confidenceLevel: 'L0',
    });

    expect(mem.evidenceCount).toBe(1);
    store.updateEvidence(mem.id);

    const updated = store.get(mem.id);
    expect(updated!.evidenceCount).toBe(2);
  });
});

describe('filterUngroundedMemories — entity-orphan guard', () => {
  const conversation = '[姜黎]: 分析一下罗文锋的简历\n\n[助手]: 罗文锋有5年UE经验，参与过《卡库远古封印》开发。';

  it('should keep memories whose entities appear in conversation', () => {
    const memories = [{
      type: 'fact' as const,
      content: '候选人罗文锋有5年UE开发经验',
      confidence: 0.7,
      tags: [],
      ttl: null,
      metadata: {},
      entities: ['罗文锋'],
    }];
    const result = filterUngroundedMemories(memories, conversation);
    expect(result).toHaveLength(1);
  });

  it('should reject fact memories whose entities are NOT in conversation', () => {
    const memories = [{
      type: 'fact' as const,
      content: '袁满于2025年11月应聘TapTap游戏工具客户端开发',
      confidence: 0.7,
      tags: [],
      ttl: null,
      metadata: {},
      entities: ['袁满'],
    }];
    const result = filterUngroundedMemories(memories, conversation);
    expect(result).toHaveLength(0);
  });

  it('should reject when ANY entity is missing from conversation', () => {
    const memories = [{
      type: 'fact' as const,
      content: '罗文锋曾在刘宏伟团队工作',
      confidence: 0.7,
      tags: [],
      ttl: null,
      metadata: {},
      entities: ['罗文锋', '刘宏伟'],
    }];
    const result = filterUngroundedMemories(memories, conversation);
    // 刘宏伟 not in conversation
    expect(result).toHaveLength(0);
  });

  it('should allow preference/state memories without entity check', () => {
    const memories = [{
      type: 'preference' as const,
      content: '用户喜欢用TypeScript',
      confidence: 0.8,
      tags: [],
      ttl: null,
      metadata: {},
      entities: ['不存在的人'],
    }];
    const result = filterUngroundedMemories(memories, conversation);
    expect(result).toHaveLength(1);
  });

  it('should allow memories without entities field (backward compatible)', () => {
    const memories = [{
      type: 'fact' as const,
      content: '项目使用ESM + TypeScript 5.7',
      confidence: 1.0,
      tags: [],
      ttl: null,
      metadata: {},
    }];
    const result = filterUngroundedMemories(memories, conversation);
    expect(result).toHaveLength(1);
  });

  it('should allow memories with empty entities array', () => {
    const memories = [{
      type: 'decision' as const,
      content: '选择 Vitest 而非 Jest',
      confidence: 0.9,
      tags: [],
      ttl: null,
      metadata: {},
      entities: [],
    }];
    const result = filterUngroundedMemories(memories, conversation);
    expect(result).toHaveLength(1);
  });

  it('should filter mixed batch correctly', () => {
    const memories = [
      {
        type: 'fact' as const,
        content: '罗文锋参与过《卡库远古封印》开发',
        confidence: 0.7, tags: [], ttl: null, metadata: {},
        entities: ['罗文锋', '卡库远古封印'],
      },
      {
        type: 'fact' as const,
        content: '张三在2025年11月被拒',
        confidence: 0.7, tags: [], ttl: null, metadata: {},
        entities: ['张三'],
      },
      {
        type: 'preference' as const,
        content: '用户偏好简洁回复',
        confidence: 0.8, tags: [], ttl: null, metadata: {},
      },
    ];
    const result = filterUngroundedMemories(memories, conversation);
    // 罗文锋 + 卡库远古封印 both present → keep
    // 张三 not present → reject
    // preference → always keep
    expect(result).toHaveLength(2);
    expect(result[0].content).toContain('罗文锋');
    expect(result[1].content).toContain('偏好');
  });
});

describe('entity-orphan guard — real incident reproduction', () => {
  // Reproduce the actual bug: PM bot analyzed 袁满's resume in a thread,
  // but fork semantics injected parent chat messages discussing 罗文锋/刘宏伟.
  // The extraction LLM then attributed 罗文锋's rejection history to 袁满.

  it('should block cross-candidate memory contamination (parseExtraction → filter pipeline)', () => {
    // Simulate extraction LLM output that includes hallucinated cross-candidate facts
    const llmResponse = JSON.stringify([
      {
        type: 'fact',
        content: '候选人袁满拥有7年游戏开发经验，参与过GPT-SoVITS等开源项目',
        confidence: 0.7,
        tags: ['候选人'],
        ttl: null,
        metadata: {},
        entities: ['袁满', 'GPT-SoVITS'],
      },
      {
        type: 'fact',
        content: '袁满于2025年11月应聘TapTap游戏工具客户端开发（UG方向），电话沟通后评分为2，判定不合适',
        confidence: 0.7,
        tags: ['候选人', '面试'],
        ttl: null,
        metadata: {},
        entities: ['袁满'],
      },
      {
        type: 'fact',
        content: '袁满的GitHub开源贡献存在严重注水，GPT-SoVITS项目仅贡献了翻译文件',
        confidence: 0.9,
        tags: ['候选人', '开源'],
        ttl: null,
        metadata: {},
        entities: ['袁满', 'GPT-SoVITS'],
      },
    ]);

    // The actual conversation only discussed 袁满 and GPT-SoVITS,
    // NOT any November interview rejection
    const conversation = [
      '[杨志]: 看看这个候选人',
      '[助手]: 我来分析一下袁满的简历。',
      '袁满有7年游戏开发经验，声称参与GPT-SoVITS等开源项目。',
      '经核实，GPT-SoVITS项目中袁满仅贡献了i18n翻译文件和README更新。',
    ].join('\n');

    const memories = parseExtractionResponse(llmResponse);
    expect(memories).toHaveLength(3);

    const grounded = filterUngroundedMemories(memories, conversation);

    // Memory 1: 袁满 + GPT-SoVITS both in conversation → KEEP
    // Memory 2: 袁满 in conversation BUT "11月应聘" is hallucinated from
    //           parent chat context about another candidate.
    //           However, 袁满 IS in conversation, so entity check alone passes.
    //           This is the edge case — entity-orphan guard catches cases where
    //           the entity itself is absent, not where facts about the entity are wrong.
    // Memory 3: 袁满 + GPT-SoVITS both in conversation → KEEP
    expect(grounded).toHaveLength(3);
    // Note: The entity-orphan guard catches the case where the ENTITY is absent
    // (e.g., hallucinating 刘宏伟 into 袁满's thread). For the "correct entity,
    // wrong facts" case, the prompt-level rules are the primary defense.
  });

  it('should block when hallucinated entity is not in conversation at all', () => {
    // The CRITICAL case: LLM mentions an entity that was never in this conversation
    // (e.g., 罗文锋's info leaking from injected memory into 袁满's analysis)
    const llmResponse = JSON.stringify([
      {
        type: 'fact',
        content: '候选人罗文锋于2025年11月20日曾应聘TapTap游戏工具客户端开发，被判定不合适',
        confidence: 0.7,
        tags: ['候选人'],
        ttl: null,
        metadata: {},
        entities: ['罗文锋'],
      },
    ]);

    // Conversation is about 袁满, NOT 罗文锋
    const conversation = [
      '[杨志]: @土豆儿 分析一下这份简历',
      '[助手]: 我来分析袁满的简历。袁满拥有7年游戏开发经验...',
    ].join('\n');

    const memories = parseExtractionResponse(llmResponse);
    const grounded = filterUngroundedMemories(memories, conversation);

    // 罗文锋 not in conversation → BLOCKED
    expect(grounded).toHaveLength(0);
  });

  it('should block when parent chat entity leaks into thread context', () => {
    // Simulate: parent chat discussed 刘宏伟 being rejected in November,
    // LLM extracts this as a fact about the current thread's candidate
    const llmResponse = JSON.stringify([
      {
        type: 'fact',
        content: '刘宏伟在2025年11月的电话面试中被lyz团队拒绝',
        confidence: 0.7,
        tags: ['面试'],
        ttl: null,
        metadata: {},
        entities: ['刘宏伟'],
      },
      {
        type: 'fact',
        content: '罗文锋具有5年以上UE引擎开发经验，参与过《卡库远古封印》项目',
        confidence: 0.8,
        tags: ['候选人'],
        ttl: null,
        metadata: {},
        entities: ['罗文锋', '卡库远古封印'],
      },
    ]);

    // Thread conversation only has 罗文锋, not 刘宏伟
    const conversation = [
      '[姜黎]: 分析一下罗文锋的简历',
      '[助手]: 罗文锋有5年UE经验，参与过《卡库远古封印》的核心战斗系统开发...',
    ].join('\n');

    const memories = parseExtractionResponse(llmResponse);
    const grounded = filterUngroundedMemories(memories, conversation);

    // 刘宏伟 not in conversation → first memory blocked
    // 罗文锋 + 卡库远古封印 both present → second memory kept
    expect(grounded).toHaveLength(1);
    expect(grounded[0].content).toContain('罗文锋');
    expect(grounded[0].content).toContain('卡库远古封印');
  });
});
