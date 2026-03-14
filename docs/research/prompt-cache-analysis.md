---
summary: "Anthropic API prompt caching 成本分析与优化"
status: completed
owner: claude
last_updated: "2026-03-14"
read_when:
  - 分析 Claude API 费用异常
  - 优化 Agent SDK 调用成本
  - 研究 prompt caching 行为
---

# Prompt Caching 成本分析与优化

## 背景

一个飞书 thread 中的查询累计消耗了 **$69**，其中单条 24-turn 查询花费 **$17.53**。调查发现 prompt caching 命中率远低于预期，核心原因是 **Claude Code CLI 的缓存策略在多 turn 场景下效率低下**。

## 调查过程

### 1. 数据收集

通过 pm2 日志提取该 thread 所有查询的 cache 统计：

```
Query        turns   cost   creation    read    hit%
fresh start    67  $14.11   2,053,661  1,784,855  46.5%
resume 9       10   $1.57     168,917    856,025  83.5%  ← system prompt 没变
resume 15 ★    24  $17.53   2,716,587    643,084  19.1%  ← 典型的差表现
resume 18       2   $1.93     293,680     21,326   6.8%
```

### 2. 关键发现：cache_read/turn 恒定 ~27K

跨所有查询，**每个 turn 的 cache_read 约 27K tokens**，恰好等于 system prompt 大小。对话历史几乎从未被缓存命中。

### 3. 根因分析

#### 根因 1: CLI 的 explicit breakpoint 策略（主因）

**代码位置**: `cli.js` 中 `O6z` 函数

```javascript
let X = j > A.length - 3;  // 只有最后 2 条消息设置 cache_control
```

每个 turn，cache_control breakpoint 随消息增长向后移动。结合 Anthropic API 的两个限制：

- **最多 4 个 explicit breakpoint** — system prompt 占 1-2 个，只剩 2 个给消息
- **20-block lookback 窗口** — 每个 breakpoint 只往前查 20 个 content block

24 turns ≈ 72 content blocks，但 breakpoint 的 lookback 只覆盖最后 ~20 blocks，前面 52 blocks 全部变成 cache_creation。

#### 根因 2: injectMemories() 改变 system prompt（跨 query 问题）

**代码位置**: `src/memory/injector.ts` → `src/claude/executor.ts:437-438`

每次 resume 前，`injectMemories(rawPrompt, ...)` 基于当前用户消息搜索记忆。不同消息 → 不同搜索结果 → system prompt 变化 → 缓存前缀从变化点失效。

**证据**:
- resume 9（距上次 78s）→ 83.5% hit — system prompt 没变
- resume 10（距上次 **7s**）→ 18.5% hit — system prompt 变了，缓存全失效

### 4. 解决方案验证

Anthropic API 支持顶层 `cache_control` 参数，启用 automatic caching：

```json
// messages.create 请求体
{
  "cache_control": {"type": "ephemeral"},  // 自动管理缓存前缀
  "model": "...",
  "messages": [...]
}
```

通过 `CLAUDE_CODE_EXTRA_BODY` 环境变量注入。测试结果（Haiku）：

| 指标 | DEFAULT | AUTO-ONLY | 改善 |
|------|---------|-----------|------|
| Phase 1 cache hit | 66.2% | **89.3%** | +23% |
| Phase 1 cost | $1.12 | **$0.39** | **-65%** |
| Phase 1 cache_creation | 149,822 | **33,972** | -77% |
| Resume cache hit | 0% | 34.6% | +34.6% |
| **总成本** | **$1.42** | **$0.59** | **-58%** |

## 已实施的优化

### 环境变量配置（.env）

```bash
CLAUDE_CODE_EXTRA_BODY={"cache_control":{"type":"ephemeral"}}
```

效果：在 CLI 的 explicit breakpoints 基础上，追加顶层 automatic caching。API 自动管理缓存前缀，不受 4-breakpoint 和 20-block lookback 限制。

## 未解决的问题

### 1. injectMemories() 导致跨 query 缓存失效

每次 resume 前搜索记忆并注入 system prompt，不同的查询文本产生不同的记忆搜索结果 → system prompt 变化 → 整个缓存前缀失效。

**可能的修复方案**：
- 同一 session 内缓存 memoryContext，不每次重新搜索
- 将记忆内容放到 user message 而非 system prompt
- 对记忆搜索结果做确定性排序和 hash，内容不变则复用

### 2. cache_reference 功能未对 SDK 启用

CLI 代码中有 `cache_reference` 机制（用指针替代重发 tool_result），但条件为：

```javascript
$1 = j && C7() === "firstParty" && w.querySource === "repl_main_thread";
// j = false (硬编码), querySource 在 SDK 中不是 "repl_main_thread"
```

这是内部 beta 功能，当前不可用。如果未来开放，可进一步降低成本。

### 3. 长对话的 auto-compact

session 文件 2.4MB / ~614K tokens，远超 200K 上下文窗口。CLI 有 auto-compact 能力（`SDKCompactBoundaryMessage` 类型），但在这个 session 中未触发。可能需要调查 auto-compact 的触发条件。

## 测试脚本

- `scripts/test-cache-optimization.mjs` — 单 query 缓存测试（`--auto-only` 对比）
- `scripts/test-cache-resume.mjs` — resume 场景缓存测试

## 参考资料

- [Prompt caching - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- API 限制：最多 4 个 explicit breakpoint，20-block lookback 窗口
- `cache_control` 顶层参数：自动在最后一个 cacheable block 添加 breakpoint
