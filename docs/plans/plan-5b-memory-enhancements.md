---
summary: "记忆系统增强：历史记忆主动检索 + Supersede 链"
status: draft
owner: lishuceo
last_updated: "2026-03-08"
read_when:
  - 修改记忆搜索或检索逻辑
  - 处理历史记忆查询（如"为什么不用 MySQL"）
  - 修改记忆的 supersede/invalidate 逻辑
---

# Plan 5b: 记忆系统增强 — 历史记忆主动检索与 Supersede 链

> 日期: 2026-03-08
> 状态: **待实施**
> 前置依赖: Plan 5 Phase 2 (记忆用户管理, 已实现)
> 讨论来源: 飞书群聊 OpenClaw vs Anywhere-Code 记忆系统对比讨论

---

## 一、背景

当前记忆系统已实现 Phase 0-2（存储/搜索/提取/注入/用户管理），但存在三个问题：

1. **历史记忆不可达** — `invalid_at IS NOT NULL` 的记忆永远不参与搜索，Agent 无法回答"为什么不用 MySQL"这类历史溯源问题
2. **Supersede 链信息量低** — 只记录"被谁替代"，不记录"为什么替代"，且只能正向遍历（旧→新），不能反向（新→旧）
3. **硬删策略误伤** — maintenance job 会硬删 `confidence < 0.1 && age > 90天` 的所有记忆，decision/fact 类型的历史轨迹可能被误删

核心观点：**过时的记忆不等于无价值的记忆**。decision 的历史理由、fact 的变迁轨迹，对未来决策有重要参考价值。

---

## 二、改动清单

### 改动 1：豁免 decision/fact 的硬删逻辑

**文件：** `src/memory/init.ts` (maintenance job)

**改动：** 硬删 SQL 增加类型过滤

```sql
DELETE FROM memories
WHERE confidence < 0.1
  AND created_at < (NOW - 90 days)
  AND type NOT IN ('decision', 'fact')   -- 新增：豁免这两类
```

**复杂度：** 极低（1 行 SQL）

---

### 改动 2：Supersede 链增加反向指针和 reason

**文件：** `src/memory/types.ts`, `src/memory/database.ts`, `src/memory/store.ts`

**新增字段：**

```typescript
interface Memory {
  // 现有
  supersededBy: string | null;      // 正向：我被谁替代了

  // 新增
  supersedes: string | null;        // 反向：我替代了谁
  supersedeReason: string | null;   // 为什么替代
}
```

**数据库 migration：**

```sql
ALTER TABLE memories ADD COLUMN supersedes TEXT REFERENCES memories(id);
ALTER TABLE memories ADD COLUMN supersede_reason TEXT;
```

**store.ts 中 supersede() 改为双向写入：**

```typescript
function supersede(oldId: string, newInput: MemoryCreateInput, reason: string): Memory {
  const newMem = store.create({
    ...newInput,
    supersedes: oldId,
    supersedeReason: reason,
  });

  db.update(oldId, {
    invalidAt: now(),
    supersededBy: newMem.id,
  });

  return newMem;
}
```

**遍历方式：**
- 从当前往历史：沿 `supersedes` 链往回走（每跳 WHERE id = ? 主键查询）
- 从历史往当前：沿 `superseded_by` 链往前走
- 链通常 1-3 层，极端情况 5 层

**复杂度：** 低

---

### 改动 3：搜索接口增加 `includeArchived` 参数

**文件：** `src/memory/search.ts`, `src/memory/types.ts`

```typescript
interface SearchOptions {
  query: string;
  agentId: string;
  userId?: string;
  workspaceDir?: string;
  types?: MemoryType[];
  limit?: number;
  includeArchived?: boolean;  // 新增，默认 false
}
```

**过滤逻辑：**

```typescript
function buildWhereClause(opts: SearchOptions) {
  if (!opts.includeArchived) {
    // 现有逻辑：只返回有效记忆
    return 'AND invalid_at IS NULL AND (ttl IS NULL OR ttl > ?)';
  }
  // 包含已归档的 fact/decision，但仍排除 TTL 过期的 state
  return 'AND (invalid_at IS NULL OR type IN ("fact", "decision"))';
}
```

**复杂度：** 低

---

### 改动 4：新增 memory_search MCP 工具

**新建文件：** `src/memory/tools/memory-search.ts`

**工具定义（注册到 Claude Agent SDK）：**

```typescript
const memorySearchTool = {
  name: 'memory_search',
  description: '搜索长期记忆，包括已归档的历史记忆。当需要了解历史背景、过去的决策理由、事实变迁等上下文时使用。',
  input_schema: {
    type: 'object',
    properties: {
      query:           { type: 'string', description: '搜索关键词或自然语言问题' },
      includeArchived: { type: 'boolean', description: '是否包含已失效的历史记忆（用于溯源类问题）', default: false },
      types:           { type: 'array', items: { type: 'string', enum: ['fact', 'preference', 'state', 'decision', 'relation'] }, description: '限定搜索的记忆类型' },
      limit:           { type: 'number', description: '返回数量上限', default: 10, maximum: 30 },
    },
    required: ['query'],
  },
};
```

**Handler 逻辑：**
1. 调用 hybridSearch.search() 带 includeArchived 参数
2. 对返回的每条记忆，如果有 supersedes 链，自动展开（最多 5 层）
3. 返回结果包含 supersede 链和 reason

**注册位置：** `src/claude/executor.ts` 工具列表中添加 memory_search

**复杂度：** 中

---

### 改动 5：自动提取时捕获 supersedeReason

**文件：** `src/memory/extractor.ts`

**提取 prompt 增加指引：**

```
## 覆盖规则
当对话中出现事实更新或决策变更时：
- 提取新记忆
- 同时输出 supersede_hint 字段，说明变更原因（1 句话）

示例输入: "我们从 Jest 迁移到 Vitest 了，速度快很多"
输出: {
  "type": "fact",
  "content": "测试框架使用 Vitest",
  "supersede_hint": "从 Jest 迁移，原因是 Vitest 速度更快"
}
```

**store 处理逻辑中使用 hint 作为 reason：**

```typescript
if (conflict && (mem.type === 'fact' || mem.type === 'decision')) {
  store.supersede(
    conflict.id,
    newMemoryInput,
    mem.supersede_hint || '内容更新'
  );
}
```

**复杂度：** 低

---

### 改动 6：injector 支持归档记忆的格式化

**文件：** `src/memory/injector.ts`

当 memory_search 工具返回带 supersede 链的结果时，格式化为：

```markdown
### 过往决策
- 数据库使用 CockroachDB (decision, 2026-06)
  <- 替代 PostgreSQL, 原因: 需要多区域部署
  <- 替代 MySQL, 原因: 需要 JSONB 支持
```

**复杂度：** 低

---

## 三、文件改动汇总

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/memory/types.ts` | 修改 | Memory 接口加 supersedes, supersedeReason; SearchOptions 加 includeArchived |
| `src/memory/database.ts` | 修改 | ALTER TABLE migration + 新字段读写 |
| `src/memory/store.ts` | 修改 | supersede() 双向写入 + reason |
| `src/memory/search.ts` | 修改 | includeArchived 过滤逻辑 |
| `src/memory/extractor.ts` | 修改 | 提取 prompt 加 supersede_hint + 解析 |
| `src/memory/injector.ts` | 修改 | 归档记忆格式化（带 supersede 链 + reason） |
| `src/memory/init.ts` | 修改 | maintenance job 豁免 decision/fact |
| `src/memory/commands.ts` | 修改 | /memory 命令支持查看 supersede 链 |
| `src/memory/tools/memory-search.ts` | **新建** | MCP 工具定义 + handler |
| `src/claude/executor.ts` | 修改 | 注册 memory_search 工具 |
| `src/memory/__tests__/store.test.ts` | 修改 | 补双向 supersede 测试 |
| `src/memory/__tests__/search.test.ts` | 修改 | 补 includeArchived 测试 |
| `src/memory/__tests__/tools/memory-search.test.ts` | **新建** | 工具测试 |

**改动总量：** 修改 10 个文件 + 新建 2 个文件 + 1 个测试文件

---

## 四、实施顺序

建议按依赖关系分 3 步：

1. **基础层**（改动 1 + 2）— 豁免硬删 + supersede 双向链 + reason 字段
2. **搜索层**（改动 3 + 5 + 6）— includeArchived 参数 + 提取器 hint + 注入格式化
3. **工具层**（改动 4）— memory_search MCP 工具 + executor 注册

每步完成后可独立测试和部署。

---

## 五、设计要点

- **Agent 主动调用 > 被动注入**：让 Claude Opus 自己判断何时需要历史上下文，比关键词匹配靠谱
- **supersede reason 是核心价值**：保留旧记忆本身不难，难的是保留"为什么变了"
- **分层存储**：热层（active）正常搜索，冷层（archived）按需查询，垃圾层（低置信 state）可清理
- **链长度无需担忧**：实际 1-3 层，每跳主键查询微秒级
