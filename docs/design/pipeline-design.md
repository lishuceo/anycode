---
summary: "多 Agent 自动开发管道：plan → review → implement → review → push 状态机"
related_paths:
  - src/pipeline/**
last_updated: "2026-04-02"
---

# Pipeline 架构

自动开发管道，通过状态机驱动多步骤代码生成与审查流程。

## 状态机

`PipelineOrchestrator.run()` 驱动 8 个阶段的状态机，最多 20 次迭代：

```
plan → plan_review → implement → code_review → push → pr_fixup → done
                ↑                        ↑
          拒绝时回退（≤2次）         拒绝时回退（≤2次）
```

超过重试上限或异常 → `failed`。

### 阶段详情

| 阶段 | 执行方式 | 关键行为 |
|------|---------|---------|
| `plan` | 单次 `claudeExecutor.execute()` | 注入用户 prompt + thread 历史（仅此阶段） |
| `plan_review` | `parallelReview()` | 跳过 `codeReviewOnly: true` 的 agent |
| `implement` | 单次 execute | 注入上一轮 code review 反馈（如有） |
| `code_review` | `parallelReview()` | 含可选 Codex agent（`codex-reviewer.ts`） |
| `push` | 单次 execute | commit + push + `gh pr create`，失败不影响 done |
| `pr_fixup` | 委托 `/pr-fixup` skill | 等 CI + 修复，10 分钟 idle 超时，始终 → done |

### 回调机制

`PipelineCallbacks` 提供三个钩子：
- `onPhaseChange(phase, detail)` — 阶段切换时通知（用于更新飞书卡片）
- `onStreamUpdate(text)` — 流式文本推送
- `onActivityChange(activity)` — 活动状态变化

## 并行审查

`parallelReview()` 并行执行 N 个 review agent（每个 agent 内部 try/catch，单个失败不阻塞整体）：

**内置 3 个角色：**
- `correctness` — 逻辑错误、边界条件、类型安全
- `security` — 注入漏洞、权限、敏感信息
- `architecture` — 代码风格、设计、可维护性

**可选 Codex agent**（`codex-reviewer.ts`）：
- 通过 `codex exec` 子进程执行
- 因 Codex 只读沙箱限制，git diff 通过 stdin 传入
- 由 `isCodexEnabled()` 配置开关控制

**聚合策略**：
- 任一非弃权 agent REJECTED → 整体 REJECTED
- 全部弃权 → REJECTED（fail-closed）
- 解析失败/超时 → 该 agent 弃权，不阻塞整体（每个 promise 内部 catch）
- 第一行必须是 `APPROVED` 或 `REJECTED`，解析失败默认 REJECTED

## 文件结构

```
src/pipeline/
  orchestrator.ts    # 状态机主循环 (525 行)
  reviewer.ts        # 并行审查调度 + 聚合 (187 行)
  codex-reviewer.ts  # Codex CLI 审查集成
  prompts.ts         # 各角色 system prompt (335 行)
  types.ts           # PipelinePhase, PipelineState, ReviewVerdict, ReviewResult
  runner.ts          # Pipeline 运行入口，与 session/thread 集成
  store.ts           # Pipeline 状态持久化
```

## 关键类型

```typescript
type PipelinePhase = 'plan' | 'plan_review' | 'implement' | 'code_review'
                   | 'push' | 'pr_fixup' | 'done' | 'failed'

interface PipelineState {
  phase, userPrompt, workingDir,
  plan?, planReviewResult?, implementOutput?, codeReviewResult?,
  pushOutput?, prFixupOutput?,
  retries: Record<string, number>,
  phaseDurations: Record<string, number>,
  totalCostUsd: number,
  failureReason?, failedAtPhase?
}

interface ReviewVerdict { role, approved, abstained, feedback, costUsd, durationMs }
interface ReviewResult { approved, verdicts[], consolidatedFeedback }
```

## 设计决策

| 决策 | 理由 |
|------|------|
| 6 个执行阶段 + 2 个终止状态 | 阶段严格顺序，重试只回退一步，不需要图执行引擎 |
| fail-closed 聚合 | 宁可多审一轮，不放过问题 |
| review agent 弃权而非阻塞 | 单个 agent 超时不应阻塞整个管道 |
| push 失败不标记 failed | 代码已写好，push 问题可手动解决 |
| pr_fixup 始终 → done | 最佳努力修复，不无限循环 |
| Codex 可选 | 不是所有部署都有 Codex 访问权限 |
