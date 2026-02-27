# Plan 5: Agent 记忆系统

> 日期: 2026-02-27
> 状态: **设计中**
> 前置依赖: Plan 4 Phase 1 (多 Agent 架构, 已实现)

---

## 一、背景与动机

当前 Anywhere-Code 的每次对话是 **无状态** 的：

1. **会话内** — Claude Agent SDK 的 session resume 提供单次会话的连续性，但 session idle >2h 自动清理
2. **跨会话** — 用户偏好、项目决策、历史上下文全部丢失。每次新对话都是从零开始
3. **跨 Agent** — Chat Agent 和 Dev Agent 之间无共享记忆。Chat Agent 讨论的方案只能通过 `invoke_agent` 的 context 字段一次性传递

这导致：
- 用户反复说明相同偏好（"我习惯用 pnpm"、"commit message 用英文"）
- Agent 无法学习项目约定（"这个项目 API 都放在 src/api/ 下"）
- 长期协作缺乏累积智能

### 目标

建立 **分层记忆系统**，让 Agent 具备：
- 记住用户偏好和项目约定（跨会话持久）
- 追踪事实变化（"从 Node 16 升到了 Node 20"）
- 识别时效性信息（"本周在重构支付模块"→ 到期后自动衰减）
- 支持多 Agent 记忆隔离与共享

### 设计原则

1. **增量引入** — 不引入重型外部依赖（Neo4j、Redis），基于现有 SQLite/PostgreSQL 扩展
2. **类型区分** — 不同记忆类型有不同的生命周期管理策略
3. **白箱可控** — 用户可查看、编辑、删除自己的记忆（参考 OpenClaw 的 Markdown 透明性）
4. **成本可控** — 避免每次 add/search 都调用 LLM（OpenClaw 模式优于 Mem0 模式）

---

## 二、方案选型

### 候选方案评估

| 方案 | TS 支持 | 部署复杂度 | 自动抽取 | 冲突解决 | 适合度 |
|------|---------|-----------|---------|---------|--------|
| **Mem0** | 一等公民 (`mem0ai` npm) | 中 (PG+Neo4j+LLM) | LLM 自动 | LLM 合并 | 中 — 功能强但每次操作都调 LLM，成本高 |
| **Zep/Graphiti** | 云端 client only；核心 Python-only | 高 | 自动 | 双时态模型 (最优) | 低 — TS 核心缺失 |
| **Letta** | REST client (`@letta-ai/letta-client`) | 中 (Docker+PG) | Agent 自编辑 | Agent 管理 | 低 — 整套运行时，只用 memory 太重 |
| **LangMem** | 无 (Python-only) | 高 | 显式 tool call | 开发者管理 | 排除 |
| **Cognee** | HTTP API only | 中 | 自动 | 图谱权重 | 低 — Python-first |
| **pgvector** | 原生 (`pg`+`pgvector`) | 低 (PG 扩展) | 自建 | 自建 | 高 — 灵活，迟早需要 PG |
| **SQLite + sqlite-vec** (OpenClaw 模式) | 原生 (`better-sqlite3`) | 极低 (单文件) | 自建 | 自建 | 高 — 零依赖，与现有 DB 层一致 |

### 选型决策

**Phase 1: SQLite + sqlite-vec（与现有数据库层一致）**

理由：
- 项目已使用 `better-sqlite3`（`src/session/database.ts`），零新增依赖
- 单服务器部署，不需要分布式存储
- 借鉴 OpenClaw 的 hybrid search（vector + BM25），但加入生命周期管理
- 记忆抽取在对话结束时批量调用一次 LLM（而非 Mem0 的每次 add/search 都调），成本可控

**Phase 2（可选升级）: 迁移到 PostgreSQL + pgvector**

触发条件：多实例部署、数据量超过 SQLite 承载、需要与其他业务数据 JOIN

---

## 三、记忆分类与生命周期

### 3.1 五种记忆类型

不同类型的记忆有完全不同的写入、失效、检索逻辑，不能混为一谈：

```
类型            例子                         生命周期     更新机制
─────────────  ──────────────────────────── ──────────  ────────────────────
Fact (事实)     "API 端点是 /api/v2"         可被纠正    新事实 supersede 旧事实
Preference     "喜欢用 TypeScript"          缓慢漂移    置信度随证据增减
(偏好)
State (状态)   "正在调试 auth 模块"          高度时效    显式 TTL，到期自动衰减
Decision       "选了 PostgreSQL 不用 MySQL"  半永久      可被新决策推翻
(决策)
Relation       "Alice 是 Bob 的 tech lead"   相对稳定    显式更新
(关系)
```

### 3.2 生命周期管理策略

#### Fact — 事实纠正（受 Zep 双时态模型启发）

```
用户: "我们用的是 Node 16"
  → memory: { type: 'fact', content: 'Node 16', valid_at: T1 }

三天后
用户: "升级到 Node 20 了"
  → 旧记忆: { ..., invalid_at: T2, superseded_by: new_id }
  → 新记忆: { type: 'fact', content: 'Node 20', valid_at: T2 }
```

- 旧事实不删除，标记 `invalid_at` + 建立 `superseded_by` 链接
- 检索时默认过滤 `invalid_at IS NOT NULL`，但可查询历史（"之前用什么版本"）
- 矛盾检测：新事实写入时 vector search 相似旧事实（similarity > 0.85），命中则触发 supersede 流程

#### Preference — 置信度漂移

```
第 1 次用 Python  → { type: 'preference', content: 'Python', confidence: 0.6, evidence_count: 1 }
第 2-5 次都用 Python → confidence: 0.9, evidence_count: 5
第 6 次用 Go        → Python confidence 不变，新增 Go: { confidence: 0.4, evidence_count: 1 }
第 7-10 次都用 Go   → Go: 0.85, Python: 自然衰减至 0.5
```

- 同一维度可存多个值（不是非此即彼）
- `confidence = baseConfidence × recencyDecay`
- `baseConfidence` 由 `evidence_count` 驱动（每次佐证 +0.1，上限 1.0）
- `recencyDecay = e^(-λ × daysSinceLastEvidence)`，λ 按类型不同

#### State — 显式 TTL

```
"正在调试 auth 模块"     → ttl: session_end (会话结束即过期)
"本周在度假"             → ttl: 2026-03-07
"Q1 目标是重构支付系统"   → ttl: 2026-03-31
```

- State 类型记忆在 TTL 到期后自动从检索结果中排除（不物理删除）
- 无 TTL 的 state 按 recencyDecay 自然衰减

#### Decision — 半永久，可推翻

```
"决定用 PostgreSQL 而非 MySQL"  → { type: 'decision', confidence: 1.0, superseded_by: null }

半年后
"迁移到 TiDB"                  → 旧决策 superseded_by 新决策
```

- 写入时高置信度（1.0），不随时间衰减
- 只能被新的 decision 类型记忆显式推翻

#### Relation — 实体关系

```
{ type: 'relation', subject: 'Alice', predicate: 'tech_lead_of', object: 'Bob' }
```

- 简单的三元组（subject-predicate-object），不引入完整图数据库
- 显式更新/删除
- Phase 1 用 JSON 字段存储，Phase 2 可迁移到图结构

---

## 四、存储设计

### 4.1 Schema

```sql
-- 与现有 src/session/database.ts 共用 SQLite 实例
-- 新增 memories 表

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  agent_id      TEXT NOT NULL,                    -- 哪个 agent 的记忆
  user_id       TEXT,                             -- 关于哪个用户 (NULL = 全局)
  chat_id       TEXT,                             -- 来源群 (NULL = 跨群)

  -- 内容
  type          TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'state', 'decision', 'relation')),
  content       TEXT NOT NULL,                    -- 人类可读的记忆描述
  tags          TEXT DEFAULT '[]',                -- JSON array, 结构化标签 ["language", "tooling"]
  metadata      TEXT DEFAULT '{}',                -- JSON, 类型特有数据
                                                  --   relation: { subject, predicate, object }
                                                  --   preference: { dimension: "language" }

  -- 向量
  embedding     BLOB,                             -- sqlite-vec 向量 (float32 × dim)

  -- 生命周期
  confidence    REAL NOT NULL DEFAULT 1.0,        -- 0.0~1.0
  evidence_count INTEGER NOT NULL DEFAULT 1,      -- 被多少次对话佐证
  valid_at      TEXT NOT NULL DEFAULT (datetime('now')),  -- 生效时间
  invalid_at    TEXT,                             -- 失效时间 (NULL = 仍有效)
  superseded_by TEXT REFERENCES memories(id),     -- 被哪条记忆取代
  ttl           TEXT,                             -- 显式过期时间 (NULL = 无过期)

  -- 审计
  source_chat_id  TEXT,                           -- 产生此记忆的对话
  source_message_id TEXT,                         -- 产生此记忆的消息
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT                           -- 最后一次被检索命中
);

-- 向量索引 (sqlite-vec)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[1536]    -- 维度与 embedding 模型一致
);

-- 全文索引 (BM25)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content=memories,
  content_rowid=rowid
);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_memories_agent_user ON memories(agent_id, user_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(invalid_at);
```

### 4.2 记忆隔离与共享

```
隔离级别                作用域                    示例
─────────────────────  ────────────────────────  ──────────────────────
agent + user           单 agent 对单用户的记忆    "张三喜欢用 pnpm"
agent                  单 agent 对所有用户的记忆  "这个项目用 ESM"
global (user_id=NULL,  全局共享                  "公司代码规范: 4空格缩进"
 agent_id='*')
```

检索优先级：`agent+user` > `agent` > `global`

跨 Agent 共享策略：
- Chat Agent 写入的偏好/决策，Dev Agent 可读（通过 `agent_id='*'` 或显式共享标记）
- 每个 Agent 的 state 类型记忆互相隔离（"Chat Agent 在讨论方案" 和 "Dev Agent 在写代码" 不冲突）
- 共享写入通过 `metadata.shared: true` 标记，检索时 `WHERE agent_id = ? OR (agent_id = '*') OR metadata->>'shared' = 'true'`

---

## 五、检索设计

### 5.1 Hybrid Search（借鉴 OpenClaw）

```
查询进入
  ↓
  ├── Vector Search (sqlite-vec)
  │   cosine similarity，取 top-K₁
  │
  ├── BM25 Search (FTS5)
  │   关键词匹配，取 top-K₂
  │
  ↓ Union (不是 Intersection)
  │
  Score Fusion:
    finalScore = vectorWeight × vectorScore
               + textWeight × bm25Score
               × typeBoost
               × recencyDecay
               × confidence
  │
  ↓ MMR Rerank (去重)
  │
  ↓ Top-N 结果
```

默认权重：`vectorWeight=0.7, textWeight=0.3`（同 OpenClaw）

### 5.2 Type-aware Scoring

不同类型的记忆在不同场景下有不同权重：

```typescript
const typeBoost: Record<MemoryType, number> = {
  fact:       1.0,   // 事实始终高权重
  preference: 0.8,   // 偏好略低（可能过时）
  state:      0.6,   // 状态时效性强，基础权重低但新的 state 通过 recencyDecay 补偿
  decision:   0.9,   // 决策重要但不如事实频繁
  relation:   0.7,   // 关系背景信息
};
```

### 5.3 Recency Decay

```typescript
// λ 值按记忆类型不同
const decayRate: Record<MemoryType, number> = {
  fact:       0.005,  // 事实衰减慢 (~139 天半衰期)
  preference: 0.01,   // 偏好衰减中等 (~69 天半衰期)
  state:      0.1,    // 状态衰减快 (~7 天半衰期)
  decision:   0.002,  // 决策衰减极慢 (~347 天半衰期)
  relation:   0.003,  // 关系衰减慢 (~231 天半衰期)
};

function recencyDecay(type: MemoryType, daysSinceCreated: number): number {
  return Math.exp(-decayRate[type] * daysSinceCreated);
}
```

### 5.4 Lifecycle Filters

检索时自动应用的过滤条件：

```sql
WHERE
  -- 未被推翻
  invalid_at IS NULL
  -- 未过 TTL
  AND (ttl IS NULL OR ttl > datetime('now'))
  -- 隔离级别
  AND (agent_id = ? OR agent_id = '*')
  AND (user_id = ? OR user_id IS NULL)
```

---

## 六、记忆写入流程

### 6.1 对话结束时批量抽取

不走 Mem0 的"每次 add 都调 LLM"路径，而是**对话结束时批量调用一次**：

```
对话结束
  ↓
收集本次对话的所有 user/assistant 消息
  ↓
LLM 调用 (Haiku，成本最低):
  "从以下对话中提取值得长期记忆的信息，分类为 fact/preference/state/decision/relation。
   对每条记忆标注：
   - type: 类型
   - content: 简洁描述
   - confidence: 0.0~1.0
   - tags: 相关标签
   - ttl: 如果有时效性，估计过期时间 (ISO 8601)，否则 null
   - dimension: 如果是 preference，标注维度 (如 'language', 'style')

   只提取明确的、有长期价值的信息。不要提取：
   - 临时的调试过程
   - 通用知识（不特定于此用户/项目）
   - 已在 CLAUDE.md 中记录的项目约定"
  ↓
返回结构化 JSON array
  ↓
对每条新记忆:
  ├── 生成 embedding (本地模型或 API)
  ├── 查重: vector search existing memories (similarity > 0.85)
  │     ├── 命中 same type → 更新 (evidence_count++, confidence 调整)
  │     ├── 命中 conflicting → supersede (旧记忆 invalid_at = now)
  │     └── 未命中 → 插入新记忆
  └── 同步更新 memories_vec + memories_fts
```

### 6.2 成本估算

| 环节 | 模型 | 频率 | 估算成本 |
|------|------|------|---------|
| 记忆抽取 | Haiku | 每次对话结束 1 次 | ~$0.001/次 |
| Embedding | text-embedding-3-small 或本地 | 每条记忆 1 次 | ~$0.0001/条 |
| 矛盾检测 | 向量相似度 | 每条新记忆 1 次 | 零 (本地计算) |

每日 50 次对话 ≈ $0.05/天 记忆成本。远低于 Mem0 的每次 add/search 都调 LLM。

### 6.3 Embedding 降级策略（借鉴 OpenClaw）

```
优先级链:
  1. 阿里 text-embedding-v4  https://bailian.console.aliyun.com/cn-beijing/?spm=5176.11801677.resourceCenter.1.323c25af1cQurv&tab=doc&productCode=p_efm&switchAgent=14315148#/doc/?type=model&url=2842587
  2. 本地 embedding 模型 (零成本)
  3. BM25-only 模式 (embedding 完全不可用时)
```

如果 embedding 提供者变更，通过 index fingerprint 自动触发全量重建（存储 `embedding_model` + `embedding_dim` 元数据）。

---

## 七、记忆注入策略

### 7.1 对话开始时注入

```
新对话开始
  ↓
Hybrid search: 用户最近消息 + agent context 作为 query
  ↓
取 top-10 有效记忆
  ↓
按 type 分组，格式化为 system prompt 片段:

  ## 关于此用户的记忆

  ### 偏好
  - 偏好 TypeScript，习惯用 pnpm (confidence: 0.9)
  - 喜欢简洁的 commit message (confidence: 0.7)

  ### 项目事实
  - 当前使用 Node 20 (since 2026-02-15)
  - API 统一放在 src/api/ 目录下

  ### 当前状态
  - 正在重构支付模块 (预计到 2026-03-15)

  ### 过往决策
  - 选用 PostgreSQL 而非 MySQL (2026-01-10)
  - 前端框架迁移到 React 19 (2026-02-01)
```

### 7.2 注入位置

```
System Prompt 结构:
  ┌─────────────────────────┐
  │ Agent 基础人设           │  ← 固定
  │ (chat.ts / dev.ts)      │
  ├─────────────────────────┤
  │ CLAUDE.md 项目上下文     │  ← 固定 (settingSources)
  ├─────────────────────────┤
  │ 用户记忆片段             │  ← 动态注入 ★
  │ (本方案新增)             │
  ├─────────────────────────┤
  │ 本次对话 user messages   │  ← 运行时
  └─────────────────────────┘
```

注入方式：通过 `systemPromptBuilder(ctx)` 中追加记忆片段。记忆片段放在 CLAUDE.md 之后、对话之前，确保 Agent 同时有项目上下文和用户上下文。

### 7.3 Token 预算

记忆注入占用 token 需要控制：

- 默认上限：2000 tokens（约 10-15 条记忆）
- 超限时按 `finalScore` 排序截断
- 不同 Agent 可配置不同上限（Chat Agent 可以多注入偏好，Dev Agent 侧重事实和决策）

---

## 八、记忆管理

### 8.1 用户可见性

用户可以通过命令查看和管理自己的记忆：

```
/memory              → 列出当前 agent 对我的所有有效记忆
/memory search xxx   → 搜索特定记忆
/memory delete <id>  → 删除某条记忆
/memory clear        → 清除所有记忆（需确认）
```

实现方式：注册为 slash command，在 `event-handler.ts` 中拦截处理，不进入 Agent 执行流。

### 8.2 定期维护

```typescript
// 每日凌晨执行 (可挂到现有 cleanup interval)
async function memoryMaintenance(): Promise<void> {
  // 1. 标记过期 state
  db.run(`
    UPDATE memories SET invalid_at = datetime('now')
    WHERE type = 'state' AND ttl IS NOT NULL AND ttl < datetime('now') AND invalid_at IS NULL
  `);

  // 2. 清理极低置信度记忆 (confidence < 0.1 且超过 90 天)
  db.run(`
    DELETE FROM memories
    WHERE confidence < 0.1
    AND created_at < datetime('now', '-90 days')
  `);

  // 3. 合并高度相似的记忆 (可选，Phase 2)
  // ...
}
```

### 8.3 记忆与 CLAUDE.md 的边界

| 信息类型 | 存储位置 | 理由 |
|---------|---------|------|
| 项目架构、编码规范 | CLAUDE.md | 全团队共享，版本控制 |
| 用户个人偏好 | memories | per-user，不适合放公共文件 |
| 项目事实（运行时发现的） | memories | 动态变化，自动抽取 |
| Agent 配置、工具策略 | agent registry | 代码/配置管理 |

原则：CLAUDE.md 是**人为维护的项目知识**，memories 是**对话中自动积累的用户/项目知识**。两者互补不冲突。

---

## 九、架构集成

### 9.1 新增文件结构

```
src/
  memory/
    types.ts          # MemoryType, Memory, MemorySearchResult 类型
    store.ts          # MemoryStore: CRUD + vector/FTS 索引管理
    search.ts         # HybridSearch: vector + BM25 融合 + scoring
    extractor.ts      # MemoryExtractor: 对话 → 结构化记忆 (LLM 调用)
    injector.ts       # MemoryInjector: 记忆 → system prompt 片段
    maintenance.ts    # 定期维护任务
    embeddings.ts     # Embedding 生成 (fallback chain)
```

### 9.2 与现有模块的交互

```
对话结束
  ↓
event-handler.ts
  → memoryExtractor.extract(conversationMessages, { agentId, userId, chatId })
  → memoryStore.upsert(extractedMemories)    // 含查重 + supersede 逻辑

对话开始
  ↓
event-handler.ts / executor.ts
  → memorySearch.search(query, { agentId, userId })
  → memoryInjector.format(searchResults)     // 格式化为 prompt 片段
  → 注入 systemPromptBuilder
```

### 9.3 与 Session Manager 的关系

```
SessionManager (现有)        MemoryStore (新增)
─────────────────────        ─────────────────
存储: 会话状态, resume ID    存储: 长期记忆
TTL: 2 小时                  TTL: 按类型 (天~永久)
清理: idle 超时删除          清理: 定期维护
隔离: per-agent:chat:thread  隔离: per-agent + per-user
```

两者独立，不合并。SessionManager 管理**短期会话**（分钟~小时级），MemoryStore 管理**长期记忆**（天~永久级）。

---

## 十、与 OpenClaw / Mem0 的对比

### 本方案 vs OpenClaw

| 维度 | OpenClaw | 本方案 |
|------|----------|-------|
| 记忆写入 | 手动写 Markdown | **LLM 自动抽取**（对话结束时批量） |
| 冲突处理 | 无 | **双时态 supersede**（受 Zep 启发） |
| 偏好管理 | 无区分 | **evidence-weighted confidence** |
| 时效性 | temporal decay only | **TTL + temporal decay 双重** |
| 混合检索 | vector + BM25 ✅ | vector + BM25 ✅ (相同) |
| 降级策略 | 多级 fallback ✅ | 多级 fallback ✅ (相同) |
| 数据透明 | Markdown 文件 ✅ | `/memory` 命令查看 ✅ |
| 存储 | per-agent SQLite 文件 | 共用 SQLite 实例，单表多 agent |

**总结**：在 OpenClaw 的 hybrid search 基础上，增加了记忆分类、生命周期管理、自动抽取三个维度。

### 本方案 vs Mem0

| 维度 | Mem0 | 本方案 |
|------|------|-------|
| LLM 调用频率 | 每次 add + search | **仅对话结束时 1 次**（成本 ~1/10） |
| 图谱能力 | Neo4j 实体关系 | 简单三元组 (Phase 1 够用) |
| 部署依赖 | PG + Neo4j + LLM API | **仅 SQLite**（零新增） |
| 记忆分类 | 无显式分类 | **5 种类型 + 独立策略** |
| 时效管理 | recency only | **TTL + recency + supersede** |
| TS SDK 质量 | 一等公民 | 自建（完全可控） |
| 偏好漂移 | 自动合并 (黑箱) | **evidence-weighted (白箱)** |

**总结**：牺牲 Mem0 的图谱能力和自动合并，换取成本可控、零依赖、白箱透明。

---

## 十一、分阶段实施

### Phase 1: 基础记忆存储 + 自动抽取

**目标**：对话结束后自动提取记忆，下次对话注入

新增文件 (6):
1. `src/memory/types.ts` — 类型定义
2. `src/memory/store.ts` — MemoryStore (CRUD + 查重 + supersede)
3. `src/memory/search.ts` — HybridSearch (vector + BM25 + scoring)
4. `src/memory/extractor.ts` — 对话结束时 LLM 抽取
5. `src/memory/injector.ts` — 检索结果 → prompt 片段
6. `src/memory/embeddings.ts` — Embedding 生成 (fallback chain)

改造文件 (3):
7. `src/session/database.ts` — 新增 memories / memories_vec / memories_fts 表
8. `src/feishu/event-handler.ts` — 对话结束时触发 extractor
9. `src/claude/executor.ts` — systemPrompt 注入记忆片段

**验证标准**：
- 对话中提到"我喜欢用 pnpm"→ 下次新对话 system prompt 中出现此偏好
- 对话中说"Node 16 升到 20"→ 旧事实被 supersede，新事实生效
- 记忆检索延迟 < 100ms

### Phase 2: 用户管理 + 定期维护

**目标**：用户可查看/删除记忆，系统自动维护

新增：
1. `/memory` 系列 slash command
2. `src/memory/maintenance.ts` — 定期清理
3. 记忆统计面板（Feishu 卡片展示记忆条数/分类/最近更新）

### Phase 3: 跨 Agent 共享 + Relation 增强

**目标**：Chat Agent 和 Dev Agent 共享关键记忆

改动：
1. 共享标记机制 (`metadata.shared`)
2. Agent 间记忆同步策略
3. Relation 三元组查询增强

### Phase 4（可选）: PostgreSQL 迁移

**触发条件**：多实例部署 或 数据量 > 100MB

改动：
1. MemoryStore 适配 PostgreSQL + pgvector
2. 迁移脚本 (SQLite → PG)

---

## 十二、关键风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| LLM 抽取质量不稳定 | 记忆噪声大，注入无用信息 | Haiku prompt 严格约束 + confidence 阈值过滤 + 用户可删除 |
| 矛盾检测误判 | 正确事实被错误 supersede | similarity 阈值保守设置 (0.85+) + 相同 type 才触发 + supersede 可人工撤销 |
| sqlite-vec 在 Node.js 环境问题 | 向量检索不可用 | 降级到 BM25-only 模式 (借鉴 OpenClaw) |
| Token 预算溢出 | 注入记忆过多挤占对话空间 | 硬上限 2000 tokens + score 排序截断 |
| 记忆膨胀 | SQLite 文件过大 | 定期维护清理 + Phase 4 PG 迁移兜底 |
| 隐私泄露 | Agent A 的记忆泄露给 Agent B | 默认隔离，共享需显式标记 |

---

## 附录 A: 记忆抽取 Prompt 模板

```
你是一个记忆提取器。从以下对话中提取值得长期记住的信息。

## 输出格式
返回 JSON 数组，每个元素:
{
  "type": "fact" | "preference" | "state" | "decision" | "relation",
  "content": "简洁描述 (1-2 句话)",
  "confidence": 0.0~1.0,
  "tags": ["tag1", "tag2"],
  "ttl": "ISO 8601 日期" | null,
  "metadata": {
    "dimension": "仅 preference 类型，如 language/style/tooling",
    "subject": "仅 relation 类型",
    "predicate": "仅 relation 类型",
    "object": "仅 relation 类型"
  }
}

## 提取规则
- 只提取明确的、有长期价值的信息
- 不要提取: 临时调试过程、通用知识、CLAUDE.md 中已有的信息
- preference 的 confidence 基于表达强度: "我习惯用"=0.8, "试试看"=0.4, "必须用"=1.0
- state 必须估计 ttl (会话级/天级/周级/月级)
- fact 的 confidence 通常为 1.0，除非用户表达不确定 ("好像是")
- 每次对话最多提取 5 条记忆（避免噪声）

## 对话内容
{conversation}
```

## 附录 B: Scoring 公式详细说明

```typescript
interface ScoredMemory {
  memory: Memory;
  vectorScore: number;    // 0~1, cosine similarity
  bm25Score: number;      // 0~1, normalized BM25
  typeBoost: number;      // 0~1, by memory type
  recencyDecay: number;   // 0~1, exponential decay
  confidence: number;     // 0~1, from memory record
  finalScore: number;     // weighted combination
}

function computeFinalScore(m: ScoredMemory): number {
  const searchScore = 0.7 * m.vectorScore + 0.3 * m.bm25Score;
  return searchScore * m.typeBoost * m.recencyDecay * m.confidence;
}
```

## 附录 C: 与 Plan 4 的集成点

| Plan 4 组件 | 集成方式 |
|------------|---------|
| AgentConfig (types.ts) | 新增 `memoryConfig?: { enabled, maxInjectTokens, sharedRead }` |
| systemPromptBuilder | injector.format() 输出追加到 prompt |
| event-handler.ts (对话结束) | 触发 extractor.extract() |
| invoke_agent context | 可选从记忆中补充 context（"该用户偏好..."） |
| /memory slash command | 走 event-handler.ts 命令路由，不进入 Agent 执行 |

---

## 十三、Review 发现与修正

> 基于 4-Agent Swarm Review 的关键发现，对原方案进行以下修正。

### Critical 修正

1. **FTS5 content= 需要手动 trigger 同步**
   - 原方案未定义同步 trigger，导致 FTS5 索引与主表不一致
   - 修正: 补充 `AFTER INSERT / AFTER DELETE / AFTER UPDATE` 三个 trigger，确保主表变更时 FTS5 索引同步更新

2. **"对话结束"触发时机不存在**
   - SDK 无 "对话结束" 事件，无法可靠判断对话是否结束
   - 修正: 改为 **每 N 轮对话或距上次抽取 M 分钟** 触发记忆抽取（Phase 0 暂不实现抽取触发，仅验证存储和检索）

3. **对话消息收集无数据源**
   - executor 当前不暴露完整对话消息流
   - 修正: 后续需改造 executor 或使用 prompt+output 对作为数据源（Phase 0 不涉及）

4. **Prompt injection → 记忆投毒**
   - 用户可通过构造恶意消息注入虚假记忆
   - 修正: 引入 **L0/L1/L2 置信度分层**，自动抽取的记忆为 L0（confidence 上限 0.7），用户确认后升级为 L1（上限 0.9），手动创建为 L2（上限 1.0）

5. **跨会话信息泄露**
   - 缺少 workspace 维度隔离，不同仓库的记忆可能互相泄露
   - 修正: 增加 `workspace_dir` 隔离维度，检索时按 workspace 过滤

### 成本修正

- **抽取模型**: 从 Haiku 改为 **Qwen（DashScope）**，与 embedding 共用同一个 `DASHSCOPE_API_KEY`
- **Embedding**: 使用 **text-embedding-v4（DashScope）**，维度 1024（非 OpenAI 的 1536）
- **搜索延迟目标**: 修正为 <200ms (API 调用) / <100ms (本地 BM25-only)

### 架构修正

- **独立数据库文件**: `data/memories.db`，不与 sessions.db 共享连接（避免 DDL 干扰）
- **两阶段写入**: Phase 1 同步写入 main + FTS5（trigger 自动同步），Phase 2 异步 fire-and-forget embedding + vec0
- **sqlite-vec 运行时检测**: 加载失败时 `vectorEnabled = false`，所有 vec0 操作走 BM25-only fallback
- **去除主表 embedding BLOB 列**: 向量仅存 vec0 虚拟表，主表不冗余

---

## 十四、技术原型验证（Phase 0）

在 Phase 1 之前新增 **Phase 0 技术原型**，验证以下关键技术可行性后再实施完整系统：

1. **sqlite-vec 在 Node.js/better-sqlite3 环境下是否可用** — 运行时动态加载 + graceful fallback
2. **FTS5 external content + trigger 同步** — INSERT/DELETE/UPDATE 三向同步正确性
3. **DashScope embedding API 兼容性** — 通过 OpenAI SDK compatible-mode 调用
4. **混合检索 score fusion** — BM25 + vector 加权融合算法验证
5. **BM25-only 降级** — sqlite-vec 不可用时纯 BM25 检索仍可工作

### Phase 0 文件结构

```
src/memory/
  types.ts           # 核心类型定义
  embeddings.ts      # Embedding 提供者 (DashScope + Noop fallback)
  database.ts        # 独立 SQLite 数据库 (schema + prepared statements)
  store.ts           # CRUD + 两阶段写入
  search.ts          # 混合检索 + 评分
  index.ts           # 门面导出
  __tests__/
    database.test.ts
    store.test.ts
    search.test.ts
    embeddings.test.ts
```
