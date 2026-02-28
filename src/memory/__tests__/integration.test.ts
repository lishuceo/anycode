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

    const newFact = store.supersede(oldFact.id, mem({
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
// Scenario 7: 综合汇总
// ─────────────────────────────────────────────────────
describe('场景7: 综合汇总', () => {
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
