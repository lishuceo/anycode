---
summary: "记忆系统按 repository 归属隔离，根治跨项目污染（如 maker 的『双 bare repo』污染 anycode）"
status: draft
owner: lishuceo
last_updated: "2026-05-24"
read_when:
  - 修改 src/memory/extractor.ts / search.ts / injector.ts / store.ts / database.ts
  - 修改 workspace 切换逻辑（setup_workspace / thread-context.ts）
  - 处理记忆跨项目污染、归属错乱、错误注入相关 bug
  - 设计记忆作用域、可见性、隔离策略
---

# Plan 9: 记忆系统按 Repository 归属隔离

> 日期: 2026-05-24
> 状态: **草案 — 待评审**
> 前置: Plan 5 (Phase 0-2 已实现), Plan 5b (历史记忆检索)
> 触发事件: 2026-05-24 「双 bare repo 架构」错误记忆污染 anycode 项目并被写入 plan-8 文档

---

## 一、问题场景

### 1.1 真实事故链

数据库证据（`memories.db` 查询）显示：

| 时间 | source_chat_id | 记忆内容 | 性质 |
|------|---------------|---------|------|
| 05-20 02:23 | `oc_40cf...` (maker 群) | "feat/local-clone 方案已落地 bare repo 和 worktree 编辑锁" | ✅ maker 真实事实 |
| 05-24 11:48 | `oc_0e74...` (anycode 群,但讨论 maker) | "taptap/maker 仓库...双 bare repo 架构" | ⚠️ 归属正确,但虚构了"双" |
| 05-24 11:48 | 同上 | "**项目**使用双 bare repo 架构: workspace.git + workspace_runtime.git" | ❌ 归属丢失,泛化为"项目" |
| 05-24 16:47 | `oc_0e74...` (anycode) | "项目采用...双 bare repo 架构,fork 时需同步..." | ❌ 自我强化 |
| 05-24 17:41 | `oc_0e74...` (anycode) | 被注入 anycode 任务,写入 `plan-8-session-fork.md` | ❌ 污染文档 |

### 1.2 三个根因(已验证代码)

| 根因 | 位置 | 现象 |
|------|------|------|
| Prompt 缺归属硬约束 | `src/memory/extractor.ts:64-127` | 「实体溯源规则」只校验 entity 在对话出现,不要求"涉及项目特性的 fact 必须标注仓库" |
| Search 缺仓库维度过滤 | `src/memory/search.ts:120-134` | 仅 agent/user/workspaceDir 过滤,且 workspaceDir 过滤仅在 memory.workspaceDir !== null 时生效;跨仓库讨论抽出的记忆 workspaceDir 为 null,泄漏到所有 chat |
| Schema 无承载体 | `src/memory/types.ts:24-50`, `database.ts:12-34` | Memory 无 `repository` 字段,即使抽取出归属也无法持久化和过滤 |

### 1.3 设计目标

- **不能用 chatId 隔离** — 同一话题内本身有完整 prompt 历史,memory 价值在于**跨话题/跨时间**复用。chatId 隔离 = 记忆系统自废武功
- **必须按"事实所属的逻辑实体"隔离** — 项目类事实绑定到 repository,用户类事实绑定到 user,临时状态绑定到 chat
- **抽取期就要确定归属** — 不能事后补救。LLM 抽取时无法判断归属的记忆,宁可丢弃,不可注入"项目XX"这种无归属版本

---

## 二、核心模型: 三层作用域

记忆按**逻辑实体**分三层作用域,正交于物理隔离(agent/user/chat):

```
┌──────────────────────────────────────────────────────────────┐
│  user 作用域 (跨所有项目/话题可见)                              │
│   - preference (用户偏好)                                      │
│   - fact: 人员角色 (姜黎=黎叔, lishuceo=team lead)             │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│  repository 作用域 (只在当前 cwd 解析到的 repo 内可见)          │
│   - fact: 技术栈、架构、模块关系                                │
│   - decision: 选 X 而非 Y、为什么这样设计                       │
│   - relation: 模块依赖、调用关系                                │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│  chat 作用域 (只在原 chat 内可见,跨话题不泄漏)                  │
│   - state (短期状态、带 ttl)                                   │
└──────────────────────────────────────────────────────────────┘
```

**关键判定**: scope 由 `memory.type` + 抽取时的 `repository` 字段共同决定,而非由 chatId 决定。

---

## 三、Schema 改造

### 3.1 数据库迁移 (新增 migration #14)

```sql
ALTER TABLE memories ADD COLUMN repository TEXT;  -- canonical URL, e.g. https://github.com/taptap/maker
CREATE INDEX idx_memories_repository ON memories(repository);

-- 已有数据回填策略 (one-shot):
-- 1. 凡 workspace_dir 非空且能解析到 canonical URL → 回填 repository
-- 2. 其余保留 NULL (作为"未归属"标记,新查询逻辑会按 PROJECT_SCOPED_TYPES 区别处理)
```

### 3.2 TypeScript 类型扩展

```ts
// src/memory/types.ts
export interface Memory {
  // ... 现有字段
  repository: string | null;  // canonical repo URL, null = 未归属或 user 级
}

export interface MemoryCreateInput {
  // ... 现有字段
  repository?: string | null;
}

export interface MemorySearchQuery {
  // ... 现有字段
  repository?: string | null;  // 当前 cwd 解析到的 canonical URL
}

// 新增: 作用域规则表
export const PROJECT_SCOPED_TYPES: ReadonlySet<MemoryType> = new Set(['fact', 'decision', 'relation']);
export const USER_SCOPED_TYPES:    ReadonlySet<MemoryType> = new Set(['preference']);
export const CHAT_SCOPED_TYPES:    ReadonlySet<MemoryType> = new Set(['state']);

// 注: fact 同时可能是"用户类 fact"(如"姜黎=黎叔")或"项目类 fact"(如"anycode 用 SQLite")
// 区分由抽取期的 repository 字段决定:有 repo 归属 = 项目类,无归属 = user 类
```

### 3.3 Repository 解析

```ts
// src/memory/scope.ts (新建)
import { resolveCanonicalUrlForCwd } from '../workspace/registry.js';

/** 从 cwd 推断当前所属 canonical repo URL,失败返回 null */
export function resolveRepositoryForCwd(cwd: string): string | null {
  return resolveCanonicalUrlForCwd(cwd);  // 复用 registry 已有能力
}
```

---

## 四、Extractor 改造 (`src/memory/extractor.ts`)

### 4.1 Prompt 硬约束

在现有「实体溯源规则」后追加「归属硬约束」段:

```
## 归属硬约束 (重要)
当前会话归属仓库: {{repository_or_NONE}}

对于 fact / decision / relation 类记忆:
- 如果讨论的是当前归属仓库的事实, content 必须以仓库简称开头(如 "anycode: 使用 ESM" / "taptap/maker: feat/local-clone 落地 bare repo")
- 如果讨论的是其他仓库的事实(对话中提到了别的项目), repository 字段必须设置为该仓库的 canonical URL, 且仓库名必须在 entities 中
- **绝对不允许**使用"项目使用"、"系统采用"这类无归属泛化措辞 —— 这类记忆将被拒绝
- 用户偏好、人员角色不需要仓库归属 (type=preference/或"姜黎是XX"这类 fact)
- 不确定归属时, 宁可不提取
```

### 4.2 输出 schema 扩展

抽取器输出 JSON 新增 `repository` 字段:

```json
{
  "type": "fact",
  "content": "taptap/maker: feat/local-clone 落地 bare repo + worktree 编辑锁",
  "repository": "https://github.com/taptap/maker",
  "entities": ["taptap/maker", "feat/local-clone"],
  "confidence": 0.9
}
```

### 4.3 校验加固 (`validateMemories` / `filterUngroundedMemories`)

新增 `filterUnattributedProjectMemories`:

```ts
const PROJECT_GENERIC_PATTERNS = [
  /^项目(使用|采用|的|是)/,
  /^系统(使用|采用)/,
  /^本项目/,
  /^我们(使用|采用)/,
];

function filterUnattributedProjectMemories(memories, currentRepository) {
  return memories.filter(mem => {
    if (!PROJECT_SCOPED_TYPES.has(mem.type)) return true;
    
    // 项目类记忆必须有 repository 或 content 含仓库名
    if (!mem.repository && PROJECT_GENERIC_PATTERNS.some(re => re.test(mem.content))) {
      logger.info({ content: mem.content.slice(0, 80) }, 
        'Memory rejected: project-scoped fact without repository attribution');
      return false;
    }
    return true;
  });
}
```

### 4.4 ExtractionContext 增字段

```ts
export interface ExtractionContext {
  // ... 现有字段
  repository?: string | null;  // 由 caller 传入(从 cwd 解析)
}
```

调用点(`event-handler.ts` / `executor.ts` 结束后)需带上 `repository: resolveRepositoryForCwd(workdir)`。

---

## 五、Search / Injector 改造

### 5.1 `src/memory/search.ts` (在 L131 后插入)

```ts
// Repository scope filtering
if (PROJECT_SCOPED_TYPES.has(memory.type)) {
  // 项目类记忆: memory.repository 必须等于当前 query.repository 才可见
  // 若 memory.repository 为 null (历史数据/无归属): 一并屏蔽,避免污染
  if (!memory.repository || memory.repository !== query.repository) continue;
}
// USER_SCOPED_TYPES (preference) 和 user 类 fact: 不按 repository 过滤,跨项目可见
// CHAT_SCOPED_TYPES (state): 已有 chat 维度,可选地加 chat_id 过滤
if (CHAT_SCOPED_TYPES.has(memory.type) && query.chatId 
    && memory.chatId && memory.chatId !== query.chatId) continue;
```

### 5.2 `src/memory/injector.ts:45-51`

```ts
const results = await search.search({
  query,
  agentId: context.agentId,
  userId: context.userId,
  workspaceDir: context.workspaceDir,
  repository: context.repository,  // 新增
  chatId: context.chatId,           // 现已传入但未用,这次真正传到 search
  limit: 15,
});
```

`InjectionContext` 增 `repository?: string | null` 字段,调用方(`event-handler.ts` 准备 system reminder 时)从 cwd 解析。

---

## 六、迁移与回填

### 6.1 一次性回填脚本

`scripts/memory-backfill-repository.mjs`:

```
对每条 memory:
1. 若 workspace_dir 非空 → resolveCanonicalUrlForCwd(workspace_dir) → 写入 repository
2. 若 workspace_dir 为空但 source_chat_id 命中已知 chat→repo 映射 → 回填
3. 其余保留 NULL
```

### 6.2 NULL 记忆的处理策略

- 项目类(fact/decision/relation)且 repository = NULL → **不注入到任何 project 上下文**(防污染)
- 用户类(preference) repository 一律 NULL → 正常注入
- 已注入污染过的 plan-8 类历史记忆 → 提供 `/memory archive` 批量归档脚本

### 6.3 灰度策略

- Feature flag: `MEMORY_REPOSITORY_SCOPING=true|false`(默认 false)
- 开启后,旧 NULL 项目记忆不再可见 — 损失可控(它们本来就有污染风险)
- 跑 1 周观察,确认无回归后默认开启,2 周后删除 flag

---

## 七、UI / 工具影响

### 7.1 `/memory list`

按 scope 分组展示:
```
🌐 全局 (user-scoped, 8 条)
  - preference: 偏好简洁回复
  - fact: 姜黎是黎叔
📁 anycode (repository-scoped, 12 条)
  - fact: 使用 SQLite + sqlite-vec
  - decision: 选 Pino 而非 Winston
📁 taptap/maker (repository-scoped, 5 条) — 当前不在该 repo, 默认折叠
```

### 7.2 `/memory move`

新增子命令:`/memory move <id> --to-repo <canonical_url>` / `--to-global`,用户手动纠正错归属。

---

## 八、实施路线图

| 阶段 | 内容 | 估时 |
|------|------|------|
| P0 | Schema migration + types 扩展 + scope.ts 工具 | 0.5 day |
| P1 | Extractor prompt 改 + repository 输出 + 拒绝校验 | 1 day |
| P2 | Search/Injector 接入 repository 过滤 (feature flag) | 0.5 day |
| P3 | 回填脚本 + 文档更新 + `/memory list` 分组 | 0.5 day |
| P4 | 灰度 1 周 → 默认开启 → 2 周后删 flag | 监控 |
| P5 (可选) | `/memory move` 手动纠错 | 0.5 day |

**P0+P1+P2 是 MVP**, 完成即可阻止再次发生 maker→anycode 类污染。

---

## 九、替代方案对比

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| chatId 严格隔离 | 改 2 行就生效 | 同项目多话题失去共享,记忆系统价值大跌 | ❌ 否决 |
| workspaceDir 严格过滤 | 已有字段 | workspaceDir 是物理路径,不同 worktree/cache 对应同一 repo 但路径不同;且很多记忆 workspaceDir 为 null | ❌ 不够稳定 |
| 仅改 Prompt,不改 schema | 改动小 | 没有结构化字段,无法在 search 端硬过滤;LLM 仍可能漏写归属 | ⚠️ 半成品 |
| **repository 字段 + 三层作用域** (本方案) | 抽取期+检索期双重保险,scope 语义清晰,扩展性好 | 需 schema migration + 回填 | ✅ 选定 |

---

## 十、风险与对策

| 风险 | 对策 |
|------|------|
| LLM 仍可能漏填 repository | `filterUnattributedProjectMemories` 正则拒绝"项目XX"泛化措辞;Prompt 例子覆盖正反两种 |
| canonical URL 解析失败时 fact 被拒 | 兜底:无法解析 cwd → repository 设为 `local://...`(已是 registry 内的处理方式),不阻塞抽取 |
| 跨仓库讨论的合法记忆被误屏蔽(例如"anycode 借鉴了 maker 的 X") | 此类记忆应被抽取为**两条**,各归属各的仓库;或归属到主仓库,在 content 中显式引用其他仓库名 |
| 回填把 NULL 记忆错绑到当前 cwd | 回填只用 workspace_dir 字段,不用"当前 cwd",安全 |
| 已污染的 plan-8 文档 | 不在本 plan 范围,需单独人工清理 |

---

## 十一、验收标准

1. 新建 anycode 群话题,讨论 maker 项目细节,抽取出的记忆 `repository = https://github.com/taptap/maker`
2. 之后回 anycode 项目工作,`/memory list` 不显示 maker 记忆,injector 也不注入
3. 用户偏好/人员角色类记忆在所有项目可见
4. 跑回归: `npx vitest run` 全绿
5. 新增 `tests/memory/scope.test.ts` 覆盖:
   - 项目类记忆按 repository 过滤
   - user 类记忆跨项目可见
   - NULL repository 的项目类记忆默认屏蔽
   - Prompt 拒绝"项目XX"泛化措辞

---

## 十二、未决问题

- **Q1**: 抽取期如何从对话内容判断"这条事实属于哪个 repo"? 当前依赖 LLM 推断 + 兜底回退到 cwd repository。需测试边界场景(用户贴了别仓库的代码片段讨论)
- **Q2**: 是否给 user 加 user-scoped fact 的二级 tag(如"工作偏好" vs "生活偏好")? 暂不,等需求出现再说
- **Q3**: 跨 chat 的相同 repository 记忆是否需要去重/合并? 现有 supersede 机制已部分覆盖,本 plan 不扩展
