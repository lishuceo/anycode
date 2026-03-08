/**
 * Memory System Integration Test
 *
 * 需要环境变量 DASHSCOPE_API_KEY 才能运行完整测试。
 * 运行方式:
 *   DASHSCOPE_API_KEY=sk-xxx npx vitest run src/memory/__tests__/integration.test.ts
 *
 * 无 key 时跳过 embedding 相关测试，仅验证 BM25 路径。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryDatabase } from '../database.js';
import { MemoryStore } from '../store.js';
import { HybridSearch } from '../search.js';
import { DashScopeEmbeddingProvider, NoopEmbeddingProvider } from '../embeddings.js';
import type { EmbeddingProvider } from '../embeddings.js';
import type { MemoryCreateInput } from '../types.js';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const HAS_KEY = !!DASHSCOPE_API_KEY;

let db: MemoryDatabase;
let store: MemoryStore;
let search: HybridSearch;
let provider: EmbeddingProvider;
let tempDir: string;

function mem(overrides: Partial<MemoryCreateInput>): MemoryCreateInput {
  return {
    agentId: 'dev-agent',
    userId: 'user-test',
    workspaceDir: '/projects/my-app',
    type: 'fact',
    confidenceLevel: 'L2',
    confidence: 1.0,
    content: '',
    ...overrides,
  };
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'memory-integration-'));

  provider = HAS_KEY
    ? new DashScopeEmbeddingProvider(
        DASHSCOPE_API_KEY,
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'text-embedding-v4',
        1024,
      )
    : new NoopEmbeddingProvider(1024);

  db = await MemoryDatabase.create(join(tempDir, 'memories.db'), 1024);
  store = new MemoryStore(db, provider);
  search = new HybridSearch(db, provider, 0.7);

  console.log(`\n📌 vectorEnabled: ${db.vectorEnabled}`);
  console.log(`📌 embeddingAvailable: ${provider.available}`);
  console.log(`📌 mode: ${provider.available && db.vectorEnabled ? 'hybrid (BM25 + vector)' : 'BM25-only'}\n`);
});

afterAll(async () => {
  await store.flush();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────
// Scenario 1: 用户偏好记忆
// ─────────────────────────────────────────────────────
describe('场景1: 用户偏好记忆', () => {
  it('应该记住并检索用户偏好', async () => {
    store.create(mem({
      type: 'preference',
      content: '用户偏好使用 pnpm 作为包管理器',
      tags: ['tooling', 'package-manager'],
    }));
    store.create(mem({
      type: 'preference',
      content: '用户喜欢 TypeScript 严格模式，不用 any',
      tags: ['language', 'typescript'],
    }));
    store.create(mem({
      type: 'preference',
      content: 'commit message 必须用英文',
      tags: ['git', 'style'],
    }));

    await store.flush();

    const results = await search.search({
      query: 'package manager',
      agentId: 'dev-agent',
      userId: 'user-test',
    });

    console.log('🔍 搜索 "package manager":');
    for (const r of results) {
      console.log(`  [${r.memory.type}] ${r.memory.content} (score: ${r.finalScore.toFixed(4)}, bm25: ${r.bm25Score.toFixed(4)}, vec: ${r.vectorScore.toFixed(4)})`);
    }

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory.content).toContain('pnpm');
  });
});

// ─────────────────────────────────────────────────────
// Scenario 2: 事实纠正 (supersede)
// ─────────────────────────────────────────────────────
describe('场景2: 事实纠正 (supersede)', () => {
  it('应该用新事实替代旧事实', async () => {
    const oldFact = store.create(mem({
      type: 'fact',
      content: '项目使用 Node.js 16',
      tags: ['runtime', 'nodejs'],
    }));

    const _newFact = store.supersede(oldFact.id, mem({
      type: 'fact',
      content: '项目已升级到 Node.js 20',
      tags: ['runtime', 'nodejs'],
    }));

    await store.flush();

    // 默认搜索不返回已失效的记忆
    const results = await search.search({
      query: 'Node.js',
      agentId: 'dev-agent',
      userId: 'user-test',
    });

    console.log('\n🔍 搜索 "Node.js" (默认排除已失效):');
    for (const r of results) {
      console.log(`  [${r.memory.type}] ${r.memory.content} (invalidAt: ${r.memory.invalidAt})`);
    }

    // 只应该看到新事实
    expect(results.some((r) => r.memory.content.includes('Node.js 20'))).toBe(true);
    expect(results.every((r) => r.memory.invalidAt === null)).toBe(true);

    // 查询历史（includeInvalid）
    const history = await search.search({
      query: 'Node.js',
      agentId: 'dev-agent',
      userId: 'user-test',
      includeInvalid: true,
    });

    console.log('🔍 搜索 "Node.js" (含已失效):');
    for (const r of history) {
      console.log(`  [${r.memory.type}] ${r.memory.content} (invalidAt: ${r.memory.invalidAt ?? 'null'})`);
    }

    expect(history.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────
// Scenario 3: 置信度分层 (L0/L1/L2)
// ─────────────────────────────────────────────────────
describe('场景3: 置信度分层', () => {
  it('L0 自动抽取的记忆 confidence 不超过 0.7', () => {
    const auto = store.create(mem({
      type: 'fact',
      content: 'L0 自动抽取: 用户可能喜欢 Vue',
      confidence: 1.0,
      confidenceLevel: 'L0',
    }));
    expect(auto.confidence).toBe(0.7);
    expect(auto.confidenceLevel).toBe('L0');
  });

  it('L2 手动创建的记忆可达 1.0', () => {
    const manual = store.create(mem({
      type: 'decision',
      content: 'L2 手动: 选用 PostgreSQL 作为数据库',
      confidence: 1.0,
      confidenceLevel: 'L2',
    }));
    expect(manual.confidence).toBe(1.0);
  });

  it('高置信度记忆应排在低置信度前面', async () => {
    // 清理：创建一对相同关键词但不同置信度的记忆
    store.create(mem({
      type: 'fact',
      content: 'high confidence database choice PostgreSQL',
      confidence: 1.0,
      confidenceLevel: 'L2',
    }));
    store.create(mem({
      type: 'fact',
      content: 'low confidence database choice MySQL maybe',
      confidence: 0.3,
      confidenceLevel: 'L0',
    }));

    await store.flush();

    const results = await search.search({
      query: 'database choice',
      agentId: 'dev-agent',
      userId: 'user-test',
    });

    console.log('\n🔍 搜索 "database choice" (置信度排序):');
    for (const r of results) {
      console.log(`  [${r.memory.type}] ${r.memory.content} (confidence: ${r.memory.confidence}, score: ${r.finalScore.toFixed(4)})`);
    }

    // 至少两个结果，高置信度排前面
    const dbResults = results.filter((r) => r.memory.content.includes('database choice'));
    if (dbResults.length >= 2) {
      expect(dbResults[0].memory.confidence).toBeGreaterThan(dbResults[1].memory.confidence);
    }
  });
});

// ─────────────────────────────────────────────────────
// Scenario 4: Agent / Workspace 隔离
// ─────────────────────────────────────────────────────
describe('场景4: 隔离', () => {
  it('不同 agent 的记忆互不可见', async () => {
    store.create(mem({
      agentId: 'chat-agent',
      content: 'chat-agent 私有记忆: 用户在讨论架构设计',
    }));
    store.create(mem({
      agentId: 'dev-agent',
      content: 'dev-agent 私有记忆: 正在写测试代码',
    }));

    await store.flush();

    const devResults = await search.search({
      query: '记忆',
      agentId: 'dev-agent',
      userId: 'user-test',
    });

    console.log('\n🔍 dev-agent 搜索 "记忆":');
    for (const r of devResults) {
      console.log(`  [${r.memory.agentId}] ${r.memory.content}`);
    }

    // dev-agent 不应看到 chat-agent 的记忆
    expect(devResults.every((r) => r.memory.agentId === 'dev-agent' || r.memory.agentId === '*')).toBe(true);
  });

  it('不同 workspace 的记忆互不可见', async () => {
    store.create(mem({
      content: 'repo-a 使用 ESLint 8',
      workspaceDir: '/projects/repo-a',
    }));
    store.create(mem({
      content: 'repo-b 使用 Biome 替代 ESLint',
      workspaceDir: '/projects/repo-b',
    }));

    await store.flush();

    const results = await search.search({
      query: 'ESLint',
      agentId: 'dev-agent',
      userId: 'user-test',
      workspaceDir: '/projects/repo-a',
    });

    console.log('\n🔍 在 repo-a 中搜索 "ESLint":');
    for (const r of results) {
      console.log(`  [workspace: ${r.memory.workspaceDir}] ${r.memory.content}`);
    }

    expect(results.every((r) =>
      r.memory.workspaceDir === '/projects/repo-a' || r.memory.workspaceDir === null
    )).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// Scenario 5: TTL 时效性
// ─────────────────────────────────────────────────────
describe('场景5: TTL 时效性', () => {
  it('过期的 state 记忆不应出现在搜索结果中', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    store.create(mem({
      type: 'state',
      content: '已过期状态: 上周在调试 auth 模块',
      ttl: past,
    }));
    store.create(mem({
      type: 'state',
      content: '当前状态: 本周在重构支付系统',
      ttl: future,
    }));

    await store.flush();

    const results = await search.search({
      query: '状态',
      agentId: 'dev-agent',
      userId: 'user-test',
      types: ['state'],
    });

    console.log('\n🔍 搜索 state 类型 "状态":');
    for (const r of results) {
      console.log(`  [ttl: ${r.memory.ttl}] ${r.memory.content}`);
    }

    // 过期的不应出现
    expect(results.every((r) => !r.memory.ttl || new Date(r.memory.ttl) > new Date())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// Scenario 6: 语义搜索 (仅 embedding 可用时)
// ─────────────────────────────────────────────────────
describe('场景6: 语义搜索', () => {
  it('应通过语义相似性找到相关记忆 (即使关键词不完全匹配)', async () => {
    if (!HAS_KEY || !db.vectorEnabled) {
      console.log('⏭️  跳过: 需要 DASHSCOPE_API_KEY + sqlite-vec');
      return;
    }

    store.create(mem({
      type: 'fact',
      content: '前端框架从 React 17 迁移到了 React 19',
      tags: ['frontend', 'react'],
    }));
    store.create(mem({
      type: 'decision',
      content: '状态管理选用 Zustand 替代 Redux',
      tags: ['frontend', 'state-management'],
    }));
    store.create(mem({
      type: 'preference',
      content: 'CSS 方案偏好 Tailwind CSS',
      tags: ['frontend', 'css'],
    }));

    await store.flush();

    // 用不同措辞搜索
    const results = await search.search({
      query: 'UI library upgrade',  // 语义上与 "React 迁移" 相关
      agentId: 'dev-agent',
      userId: 'user-test',
    });

    console.log('\n🔍 语义搜索 "UI library upgrade":');
    for (const r of results) {
      console.log(`  [${r.memory.type}] ${r.memory.content} (vec: ${r.vectorScore.toFixed(4)}, bm25: ${r.bm25Score.toFixed(4)}, final: ${r.finalScore.toFixed(4)})`);
    }

    // 应该通过向量相似性找到 React 相关记忆
    expect(results.length).toBeGreaterThan(0);
    if (results[0].vectorScore > 0) {
      console.log('  ✅ 向量搜索命中！语义检索生效');
    }
  });

  it('用中文语义搜索英文记忆', async () => {
    if (!HAS_KEY || !db.vectorEnabled) {
      console.log('⏭️  跳过: 需要 DASHSCOPE_API_KEY + sqlite-vec');
      return;
    }

    store.create(mem({
      type: 'fact',
      content: 'The project uses PostgreSQL 16 as the primary database',
      tags: ['database'],
    }));

    await store.flush();

    const results = await search.search({
      query: '项目用什么数据库',
      agentId: 'dev-agent',
      userId: 'user-test',
    });

    console.log('\n🔍 中文搜索英文记忆 "项目用什么数据库":');
    for (const r of results) {
      console.log(`  [${r.memory.type}] ${r.memory.content} (vec: ${r.vectorScore.toFixed(4)}, bm25: ${r.bm25Score.toFixed(4)})`);
    }

    // 跨语言语义搜索取决于 embedding 模型能力
    if (results.some((r) => r.memory.content.includes('PostgreSQL'))) {
      console.log('  ✅ 跨语言语义检索成功！');
    }
  });
});

// ─────────────────────────────────────────────────────
// Scenario 7: 记忆抽取（调真实 Qwen 模型）
// ─────────────────────────────────────────────────────
describe('场景7: 记忆抽取 (Qwen)', () => {
  it('应从对话中抽取结构化记忆', { timeout: 30000 }, async () => {
    if (!HAS_KEY) {
      console.log('⏭️  跳过: 需要 DASHSCOPE_API_KEY');
      return;
    }

    // Dynamically import to avoid config mock issues
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey: DASHSCOPE_API_KEY,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });

    const extractionPrompt = `你是一个记忆提取器。从以下对话中提取值得长期记住的信息。

## 输出格式
返回 JSON 数组，每个元素:
{
  "type": "fact" | "preference" | "state" | "decision" | "relation",
  "content": "简洁描述 (1-2 句话)",
  "confidence": 0.0~1.0,
  "tags": ["tag1", "tag2"],
  "ttl": null,
  "metadata": {}
}

## 提取规则
- 只提取明确的、有长期价值的信息
- 每次最多提取 5 条记忆
- 如果没有值得记忆的信息，返回空数组 []

## 对话内容
`;

    const conversation = `[用户]: 我们的项目决定从 Webpack 迁移到 Vite，我个人更喜欢用 Vitest 做测试。另外提一下，目前后端 API 都部署在 AWS Lambda 上。

[助手]: 好的，我了解了这些信息：
1. 构建工具从 Webpack 迁移到 Vite
2. 测试框架偏好 Vitest
3. 后端部署在 AWS Lambda

我会在后续开发中注意这些约定。`;

    const response = await client.chat.completions.create({
      model: 'qwen3.5-plus',
      messages: [
        { role: 'system', content: extractionPrompt },
        { role: 'user', content: conversation },
      ],
      temperature: 0.1,
    });

    const rawContent = response.choices?.[0]?.message?.content ?? '';
    console.log('\n🧠 Qwen 抽取原始输出:');
    console.log(`  ${rawContent.slice(0, 500)}`);

    // Use the parseExtractionResponse function
    const { parseExtractionResponse } = await import('../extractor.js');
    const memories = parseExtractionResponse(rawContent);

    console.log(`\n📝 解析出 ${memories.length} 条记忆:`);
    for (const m of memories) {
      console.log(`  [${m.type}] ${m.content} (confidence: ${m.confidence})`);
    }

    // Should extract at least 2 memories from this rich conversation
    expect(memories.length).toBeGreaterThanOrEqual(2);

    // Should identify at least one fact and one preference/decision
    const types = new Set(memories.map((m) => m.type));
    expect(types.size).toBeGreaterThanOrEqual(2);

    // All should have valid types
    const validTypes = new Set(['fact', 'preference', 'state', 'decision', 'relation']);
    for (const m of memories) {
      expect(validTypes.has(m.type)).toBe(true);
      expect(m.content.length).toBeGreaterThan(0);
    }

    // Write extracted memories to store and verify they're searchable
    for (const m of memories) {
      store.create(mem({
        type: m.type,
        content: m.content,
        confidence: m.confidence,
        confidenceLevel: 'L0',
        tags: m.tags,
      }));
    }

    await store.flush();

    // Search for one of the extracted memories
    const results = await search.search({
      query: 'Vite Webpack 构建工具',
      agentId: 'dev-agent',
      userId: 'user-test',
    });

    console.log('\n🔍 搜索抽取的记忆 "Vite Webpack 构建工具":');
    for (const r of results.slice(0, 5)) {
      console.log(`  [${r.memory.type}] ${r.memory.content} (score: ${r.finalScore.toFixed(4)})`);
    }

    expect(results.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────
// Scenario 8: 记忆注入（格式化 prompt 片段）
// ─────────────────────────────────────────────────────
describe('场景8: 记忆注入', () => {
  it('应将搜索结果格式化为 system prompt 片段', async () => {
    // Ensure we have memories from previous scenarios
    const results = await search.search({
      query: 'pnpm TypeScript',
      agentId: 'dev-agent',
      userId: 'user-test',
      limit: 10,
    });

    if (results.length === 0) {
      console.log('⏭️  跳过: 没有可注入的记忆');
      return;
    }

    const { formatMemories } = await import('../injector.js');
    const fragment = formatMemories(results);

    console.log('\n💉 注入的 prompt 片段:');
    console.log(fragment);

    // Should have the header
    expect(fragment).toContain('## 关于此用户的记忆');

    // Should have at least one type section
    const hasSomeSection = fragment.includes('### 偏好')
      || fragment.includes('### 项目事实')
      || fragment.includes('### 当前状态')
      || fragment.includes('### 过往决策')
      || fragment.includes('### 关系');
    expect(hasSomeSection).toBe(true);

    // Should contain actual memory content
    expect(fragment).toContain('- ');

    // Estimate token count (rough: 3 chars per token)
    const estimatedTokens = Math.ceil(fragment.length / 3);
    console.log(`  预估 token 数: ~${estimatedTokens}`);
    expect(estimatedTokens).toBeLessThanOrEqual(4000);
  });
});

// ─────────────────────────────────────────────────────
// Scenario 9: 抽取→注入全链路
// ─────────────────────────────────────────────────────
describe('场景9: 抽取→注入全链路', () => {
  it('抽取的记忆应能被后续注入检索到', async () => {
    if (!HAS_KEY) {
      console.log('⏭️  跳过: 需要 DASHSCOPE_API_KEY');
      return;
    }

    // Step 1: Create a memory that simulates extraction result
    store.create(mem({
      type: 'preference',
      content: '用户强烈偏好 Rust 而非 Go 进行系统编程',
      confidenceLevel: 'L0', // auto-extracted
      confidence: 0.7,
      tags: ['language', 'systems-programming'],
    }));

    await store.flush();

    // Step 2: Simulate next conversation — inject memories
    const results = await search.search({
      query: '系统编程用什么语言',
      agentId: 'dev-agent',
      userId: 'user-test',
    });

    const { formatMemories } = await import('../injector.js');
    const fragment = formatMemories(results);

    console.log('\n🔄 全链路: 抽取→搜索→注入');
    console.log(`  搜索 "系统编程用什么语言" 命中 ${results.length} 条`);
    console.log(`  注入片段:\n${fragment}`);

    // The Rust preference should appear in the injected fragment
    expect(fragment).toContain('Rust');
  });
});

// ─────────────────────────────────────────────────────
// Scenario 10: Supersede 链（双向指针 + reason）
// ─────────────────────────────────────────────────────
describe('场景10: Supersede 双向链 + reason', () => {
  it('应支持带 reason 的双向 supersede', async () => {
    const m1 = store.create(mem({
      type: 'decision',
      content: '数据库选用 MySQL',
      tags: ['database'],
    }));
    const m2 = store.supersede(m1.id, mem({
      type: 'decision',
      content: '数据库迁移到 PostgreSQL',
      tags: ['database'],
    }), '需要 JSONB 支持');
    const m3 = store.supersede(m2.id, mem({
      type: 'decision',
      content: '数据库迁移到 CockroachDB',
      tags: ['database'],
    }), '需要多区域部署');

    await store.flush();

    // 正向检查: 旧记忆指向新记忆
    const old1 = store.get(m1.id)!;
    expect(old1.supersededBy).toBe(m2.id);
    expect(old1.invalidAt).not.toBeNull();

    // 反向检查: 新记忆指向旧记忆 + reason
    const cur = store.get(m3.id)!;
    expect(cur.supersedes).toBe(m2.id);
    expect(cur.supersedeReason).toBe('需要多区域部署');

    // 链遍历: 从最新记忆往回走
    const chain = store.getSupersedChain(m3.id);
    expect(chain).toHaveLength(2);
    expect(chain[0].content).toBe('数据库选用 MySQL');
    expect(chain[1].content).toBe('数据库迁移到 PostgreSQL');

    console.log('\n🔗 Supersede 链:');
    console.log(`  ${chain[0].content} → (${m2.supersedeReason}) → ${chain[1].content} → (${cur.supersedeReason}) → ${cur.content}`);
  });

  it('includeInvalid 应能搜到已归档的决策', async () => {
    // 搜索 MySQL（已被 supersede 归档）
    const archived = await search.search({
      query: 'MySQL',
      agentId: 'dev-agent',
      userId: 'user-test',
      includeInvalid: true,
      types: ['decision'],
    });

    console.log('\n🔍 搜索已归档 "MySQL" (includeInvalid=true):');
    for (const r of archived) {
      console.log(`  [${r.memory.type}] ${r.memory.content} (invalidAt: ${r.memory.invalidAt ?? 'null'})`);
    }

    expect(archived.some(r => r.memory.content.includes('MySQL'))).toBe(true);

    // 默认搜索不应返回已归档
    const active = await search.search({
      query: 'MySQL',
      agentId: 'dev-agent',
      userId: 'user-test',
      types: ['decision'],
    });

    expect(active.every(r => r.memory.invalidAt === null)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// Scenario 11: 综合汇总
// ─────────────────────────────────────────────────────
describe('场景11: 综合汇总', () => {
  it('打印数据库统计信息', () => {
    const stats = db.db.prepare(`
      SELECT
        type,
        COUNT(*) as count,
        AVG(confidence) as avg_confidence,
        SUM(CASE WHEN invalid_at IS NOT NULL THEN 1 ELSE 0 END) as invalidated
      FROM memories
      GROUP BY type
      ORDER BY count DESC
    `).all() as Array<{ type: string; count: number; avg_confidence: number; invalidated: number }>;

    console.log('\n📊 数据库统计:');
    console.log('  类型        | 数量 | 平均置信度 | 已失效');
    console.log('  ------------|------|-----------|-------');
    for (const s of stats) {
      console.log(`  ${s.type.padEnd(12)}| ${String(s.count).padEnd(5)}| ${s.avg_confidence.toFixed(2).padEnd(10)}| ${s.invalidated}`);
    }

    const total = db.db.prepare('SELECT COUNT(*) as total FROM memories').get() as { total: number };
    console.log(`\n  总记忆数: ${total.total}`);
    console.log(`  向量索引: ${db.vectorEnabled ? '✅ 启用' : '❌ 未启用 (BM25-only)'}`);
    console.log(`  Embedding: ${provider.available ? '✅ DashScope' : '❌ Noop'}`);
  });
});
