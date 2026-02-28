/**
 * Memory System Quality Evaluation
 *
 * 运行: DASHSCOPE_API_KEY=sk-xxx npx vitest run src/memory/__tests__/quality.test.ts
 *
 * 两个维度:
 *   Part 1: 检索质量 — 给定记忆库 + 查询，评估命中率和排序
 *   Part 2: 抽取质量 — 给定对话，评估 Qwen 提取的记忆准确性
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryDatabase } from '../database.js';
import { MemoryStore } from '../store.js';
import { HybridSearch } from '../search.js';
import { DashScopeEmbeddingProvider, NoopEmbeddingProvider } from '../embeddings.js';
import { parseExtractionResponse } from '../extractor.js';
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
    agentId: 'eval-agent',
    userId: 'eval-user',
    workspaceDir: '/projects/eval',
    type: 'fact',
    confidenceLevel: 'L2',
    confidence: 1.0,
    content: '',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════
// 预置记忆库（模拟真实用户积累的记忆）
// ═══════════════════════════════════════════════════
const SEED_MEMORIES: MemoryCreateInput[] = [
  // 偏好
  mem({ type: 'preference', content: '用户偏好使用 pnpm 而不是 npm 或 yarn' }),
  mem({ type: 'preference', content: '代码风格偏好 2 空格缩进' }),
  mem({ type: 'preference', content: '喜欢函数式编程风格，避免 class' }),
  mem({ type: 'preference', content: 'commit message 用英文，遵循 conventional commits' }),
  mem({ type: 'preference', content: 'TypeScript 严格模式，禁止使用 any' }),

  // 事实
  mem({ type: 'fact', content: '项目使用 Node.js 20 LTS 版本' }),
  mem({ type: 'fact', content: '数据库使用 PostgreSQL 16，部署在 RDS 上' }),
  mem({ type: 'fact', content: '前端框架是 React 19 + Next.js 15' }),
  mem({ type: 'fact', content: 'CI/CD 使用 GitHub Actions，部署到 AWS ECS' }),
  mem({ type: 'fact', content: 'API 采用 RESTful 风格，统一放在 src/api/ 目录下' }),
  mem({ type: 'fact', content: '认证方案使用 JWT + refresh token' }),
  mem({ type: 'fact', content: '日志系统使用 Pino，输出 JSON 格式' }),

  // 决策
  mem({ type: 'decision', content: '状态管理选用 Zustand 替代 Redux' }),
  mem({ type: 'decision', content: 'ORM 选用 Drizzle 替代 Prisma' }),
  mem({ type: 'decision', content: '测试框架统一用 Vitest，不用 Jest' }),

  // 状态
  mem({ type: 'state', content: '当前正在重构支付模块', ttl: new Date(Date.now() + 14 * 86400000).toISOString() }),
  mem({ type: 'state', content: 'Q1 目标是完成用户权限系统', ttl: new Date(Date.now() + 30 * 86400000).toISOString() }),

  // 关系
  mem({ type: 'relation', content: 'Alice 是项目的 Tech Lead', metadata: { subject: 'Alice', predicate: 'tech_lead_of', object: 'project' } }),
];

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'memory-quality-'));
  provider = HAS_KEY
    ? new DashScopeEmbeddingProvider(DASHSCOPE_API_KEY, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'text-embedding-v4', 1536)
    : new NoopEmbeddingProvider(1536);

  db = await MemoryDatabase.create(join(tempDir, 'quality.db'), 1536);
  store = new MemoryStore(db, provider);
  search = new HybridSearch(db, provider, 0.7);

  // 种入所有记忆
  for (const m of SEED_MEMORIES) {
    store.create(m);
  }
  await store.flush();

  console.log(`\n📌 质量评估模式: ${provider.available ? 'hybrid (BM25+vector)' : 'BM25-only'}`);
  console.log(`📌 记忆库大小: ${SEED_MEMORIES.length} 条\n`);
});

afterAll(async () => {
  await store.flush();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════
// Part 1: 检索质量评估
// ═══════════════════════════════════════════════════

interface RetrievalTestCase {
  name: string;
  query: string;
  /** 期望命中的记忆内容关键词（按优先级排序） */
  expectedHits: string[];
  /** 期望不命中的关键词 */
  expectedMisses?: string[];
}

const RETRIEVAL_CASES: RetrievalTestCase[] = [
  {
    name: '精确关键词匹配',
    query: 'pnpm',
    expectedHits: ['pnpm'],
  },
  {
    name: '语义匹配 — 同义改写',
    query: '包管理工具用哪个',
    expectedHits: ['pnpm'],
  },
  {
    name: '语义匹配 — 英文查中文',
    query: 'which database engine',
    expectedHits: ['PostgreSQL'],
  },
  {
    name: '语义匹配 — 概念关联',
    query: '部署流水线',
    expectedHits: ['GitHub Actions', 'AWS ECS'],
  },
  {
    name: '多关键词组合',
    query: 'TypeScript 代码风格',
    expectedHits: ['严格模式', '缩进'],
  },
  {
    name: '隐含语义 — 不含直接关键词',
    query: '用户登录怎么做的',
    expectedHits: ['JWT'],
  },
  {
    name: '当前工作重点',
    query: '现在在忙什么',
    expectedHits: ['重构支付模块'],
  },
  {
    name: '技术选型决策',
    query: '为什么不用 Redux',
    expectedHits: ['Zustand'],
  },
  {
    name: '团队相关',
    query: '谁负责技术',
    expectedHits: ['Alice', 'Tech Lead'],
  },
  {
    name: '完全无关查询',
    query: '今天天气怎么样',
    expectedHits: [], // 不应该命中任何记忆（或命中很低分的）
  },
];

describe('Part 1: 检索质量', () => {
  const scorecard: { name: string; hit: boolean; topRank: number; details: string }[] = [];

  for (const tc of RETRIEVAL_CASES) {
    it(tc.name, async () => {
      const results = await search.search({
        query: tc.query,
        agentId: 'eval-agent',
        userId: 'eval-user',
        limit: 5,
      });

      // 检查命中
      let allHit = true;
      let bestRank = -1;
      const details: string[] = [];

      for (const expected of tc.expectedHits) {
        const rank = results.findIndex((r) =>
          r.memory.content.includes(expected),
        );
        if (rank >= 0) {
          details.push(`  ✅ "${expected}" 命中 (rank #${rank + 1}, score: ${results[rank].finalScore.toFixed(4)})`);
          if (bestRank < 0 || rank < bestRank) bestRank = rank;
        } else {
          details.push(`  ❌ "${expected}" 未命中`);
          allHit = false;
        }
      }

      // 打印结果
      console.log(`\n🔍 [${tc.name}] query: "${tc.query}"`);
      console.log(`  返回 ${results.length} 条结果:`);
      for (const r of results.slice(0, 5)) {
        console.log(`    [${r.memory.type}] ${r.memory.content.slice(0, 50)} (score: ${r.finalScore.toFixed(4)}, bm25: ${r.bm25Score.toFixed(4)}, vec: ${r.vectorScore.toFixed(4)})`);
      }
      for (const d of details) console.log(d);

      scorecard.push({
        name: tc.name,
        hit: tc.expectedHits.length === 0 ? true : allHit,
        topRank: bestRank,
        details: details.join('\n'),
      });

      // 对于有期望的 case，至少要命中一个
      if (tc.expectedHits.length > 0) {
        expect(results.some((r) =>
          tc.expectedHits.some((kw) => r.memory.content.includes(kw)),
        )).toBe(true);
      }
    });
  }

  it('📊 检索质量汇总', () => {
    const total = scorecard.length;
    const passed = scorecard.filter((s) => s.hit).length;
    const top1 = scorecard.filter((s) => s.topRank === 0).length;
    const top3 = scorecard.filter((s) => s.topRank >= 0 && s.topRank < 3).length;

    console.log('\n' + '═'.repeat(50));
    console.log('📊 检索质量评估汇总');
    console.log('═'.repeat(50));
    console.log(`  命中率: ${passed}/${total} (${(passed / total * 100).toFixed(0)}%)`);
    console.log(`  Top-1 准确率: ${top1}/${total - 1} (${(top1 / (total - 1) * 100).toFixed(0)}%) [排除无关查询]`);
    console.log(`  Top-3 准确率: ${top3}/${total - 1} (${(top3 / (total - 1) * 100).toFixed(0)}%)`);
    console.log('═'.repeat(50));

    // 至少 70% 命中率
    expect(passed / total).toBeGreaterThanOrEqual(0.7);
  });
});

// ═══════════════════════════════════════════════════
// Part 2: 抽取质量评估
// ═══════════════════════════════════════════════════

interface ExtractionTestCase {
  name: string;
  conversation: string;
  /** 期望提取的记忆（type + 内容关键词） */
  expectedMemories: { type: string; keywords: string[] }[];
  /** 不应该提取的内容 */
  shouldNotExtract?: string[];
}

const EXTRACTION_CASES: ExtractionTestCase[] = [
  {
    name: '明确偏好表达',
    conversation: `[用户]: 以后所有项目都用 pnpm，npm 太慢了。commit message 统一用英文。

[助手]: 好的，我记住了：
1. 包管理器统一使用 pnpm
2. commit message 使用英文`,
    expectedMemories: [
      { type: 'preference', keywords: ['pnpm'] },
      { type: 'preference', keywords: ['commit', '英文'] },
    ],
  },
  {
    name: '技术决策',
    conversation: `[用户]: 我们讨论了很久，最终决定数据库用 TiDB 替代 MySQL，主要是考虑到分布式扩展性。

[助手]: 明白了，数据库从 MySQL 迁移到 TiDB，出于分布式扩展性考虑。这是一个重要的架构决策。`,
    expectedMemories: [
      { type: 'decision', keywords: ['TiDB'] },
    ],
  },
  {
    name: '项目事实发现',
    conversation: `[用户]: 帮我看看这个项目的技术栈

[助手]: 我查看了项目结构，发现以下信息：
- 使用 Rust 编写，Cargo.toml 中指定了 rust-edition 2024
- 数据库用的是 SQLite（通过 rusqlite）
- Web 框架使用 Axum
- 部署在 Fly.io 上`,
    expectedMemories: [
      { type: 'fact', keywords: ['Rust'] },
      { type: 'fact', keywords: ['Axum'] },
    ],
    shouldNotExtract: ['Cargo.toml'], // 太细节了
  },
  {
    name: '临时状态',
    conversation: `[用户]: 这周我在度假，下周一才回来。回来之后要先处理支付模块的 bug。

[助手]: 好的，祝假期愉快！我记下了，你下周一回来后优先处理支付模块的 bug。`,
    expectedMemories: [
      { type: 'state', keywords: ['度假'] },
      { type: 'state', keywords: ['支付'] },
    ],
  },
  {
    name: '应该过滤的噪声对话',
    conversation: `[用户]: ls 一下当前目录

[助手]: 当前目录内容：
src/
package.json
tsconfig.json
README.md`,
    expectedMemories: [],
  },
];

describe('Part 2: 抽取质量', () => {
  const scorecard: { name: string; expectedCount: number; actualCount: number; typeMatch: number; keywordMatch: number }[] = [];

  for (const tc of EXTRACTION_CASES) {
    it(tc.name, { timeout: 120000 }, async () => {
      if (!HAS_KEY) {
        console.log('⏭️  跳过: 需要 DASHSCOPE_API_KEY');
        return;
      }

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
  "tags": [],
  "ttl": null,
  "metadata": {}
}

## 提取规则
- 只提取明确的、有长期价值的信息
- 不要提取临时调试过程、通用知识
- 每次最多 5 条
- 如果没有值得记忆的信息，返回空数组 []

## 对话内容
`;

      const response = await client.chat.completions.create({
        model: 'qwen3.5-plus',
        messages: [
          { role: 'system', content: extractionPrompt },
          { role: 'user', content: tc.conversation },
        ],
        temperature: 0.1,
      });

      const rawContent = response.choices?.[0]?.message?.content ?? '';
      const memories = parseExtractionResponse(rawContent);

      console.log(`\n🧠 [${tc.name}]`);
      console.log(`  期望 ${tc.expectedMemories.length} 条，实际提取 ${memories.length} 条:`);
      for (const m of memories) {
        console.log(`    [${m.type}] ${m.content} (confidence: ${m.confidence})`);
      }

      // 评分
      let typeMatch = 0;
      let keywordMatch = 0;

      for (const expected of tc.expectedMemories) {
        // 类型匹配
        const typeHit = memories.some((m) => m.type === expected.type);
        if (typeHit) typeMatch++;

        // 关键词匹配
        const kwHit = memories.some((m) =>
          expected.keywords.every((kw) =>
            m.content.toLowerCase().includes(kw.toLowerCase()),
          ),
        );
        if (kwHit) keywordMatch++;

        const status = kwHit ? '✅' : typeHit ? '⚠️ 类型对但关键词不匹配' : '❌';
        console.log(`  ${status} 期望 [${expected.type}] 含 ${expected.keywords.join('+')} → ${kwHit ? '命中' : '未命中'}`);
      }

      // 检查不应提取的内容
      if (tc.shouldNotExtract) {
        for (const noise of tc.shouldNotExtract) {
          const found = memories.some((m) => m.content.includes(noise));
          console.log(`  ${found ? '⚠️ 噪声' : '✅ 过滤'} 不应含 "${noise}" → ${found ? '存在(噪声)' : '已过滤'}`);
        }
      }

      // 噪声对话不应提取任何记忆
      if (tc.expectedMemories.length === 0) {
        console.log(`  ${memories.length === 0 ? '✅' : '⚠️'} 期望 0 条，实际 ${memories.length} 条`);
      }

      scorecard.push({
        name: tc.name,
        expectedCount: tc.expectedMemories.length,
        actualCount: memories.length,
        typeMatch,
        keywordMatch,
      });

      // 宽松断言：至少一半的期望记忆被命中
      if (tc.expectedMemories.length > 0) {
        expect(keywordMatch).toBeGreaterThanOrEqual(Math.ceil(tc.expectedMemories.length / 2));
      }
    });
  }

  it('📊 抽取质量汇总', () => {
    if (!HAS_KEY) {
      console.log('⏭️  跳过汇总');
      return;
    }

    const withExpected = scorecard.filter((s) => s.expectedCount > 0);
    const totalExpected = withExpected.reduce((s, c) => s + c.expectedCount, 0);
    const totalTypeMatch = withExpected.reduce((s, c) => s + c.typeMatch, 0);
    const totalKeywordMatch = withExpected.reduce((s, c) => s + c.keywordMatch, 0);

    console.log('\n' + '═'.repeat(50));
    console.log('📊 抽取质量评估汇总');
    console.log('═'.repeat(50));
    console.log(`  类型准确率: ${totalTypeMatch}/${totalExpected} (${(totalTypeMatch / totalExpected * 100).toFixed(0)}%)`);
    console.log(`  关键词命中率: ${totalKeywordMatch}/${totalExpected} (${(totalKeywordMatch / totalExpected * 100).toFixed(0)}%)`);

    const noiseCase = scorecard.find((s) => s.expectedCount === 0);
    if (noiseCase) {
      console.log(`  噪声过滤: ${noiseCase.actualCount === 0 ? '✅ 通过' : `⚠️ 提取了 ${noiseCase.actualCount} 条噪声`}`);
    }
    console.log('═'.repeat(50));
  });
});
