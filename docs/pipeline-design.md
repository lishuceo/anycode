# 自动开发管道：多 Agent Plan + Review 设计方案

## 目标流程

```
用户消息
  → Step 1: Plan Agent 生成方案
  → Step 2: N 个 Review Agent 并行审查方案 → 汇总 → 不通过则回 Step 1（最多 2 轮）
  → Step 3: Implement Agent 写代码 + 跑测试
  → Step 4: N 个 Review Agent 并行审查代码 → 汇总 → 不通过则回 Step 3（最多 2 轮）
  → Step 5: Push + PR
```

简单问答、代码探索等非修改任务不走此管道，沿用现有单次 execute() 路径。

---

## 架构概览

```
event-handler.ts
  │
  ├── 简单任务 → claudeExecutor.execute()       (现有路径)
  │
  └── 代码修改 → PipelineOrchestrator.run()      (新增)
                    │
                    ├── Step planAgent       → 1x query()
                    ├── Step planReview      → Nx query() 并行
                    ├── Step implementAgent  → 1x query()
                    ├── Step codeReview      → Nx query() 并行
                    └── Step pushAgent       → 1x query()
```

### 新增文件结构

```
src/pipeline/
  types.ts          # PipelinePhase, PipelineState, ReviewVerdict 等类型定义
  orchestrator.ts   # PipelineOrchestrator — 状态机驱动的多步编排
  reviewer.ts       # 并行 review 调度 + 结果聚合
  prompts.ts        # 各角色 system prompt
```

---

## 核心设计

### 1. 状态机 (orchestrator.ts)

```typescript
type PipelinePhase =
  | 'plan'
  | 'plan_review'
  | 'implement'
  | 'code_review'
  | 'push'
  | 'done'
  | 'failed';

interface PipelineState {
  phase: PipelinePhase;
  userPrompt: string;
  workingDir: string;
  plan?: string;              // Step 1 输出
  planReview?: ReviewResult;  // Step 2 输出
  implementSummary?: string;  // Step 3 输出 (diff 摘要)
  codeReview?: ReviewResult;  // Step 4 输出
  pushResult?: string;        // Step 5 输出 (PR 链接等)
  retries: Record<string, number>;
}

interface PipelineCallbacks {
  onPhaseChange?: (phase: PipelinePhase, detail?: string) => Promise<void>;
  onStreamUpdate?: (text: string) => Promise<void>;
}

class PipelineOrchestrator {
  async run(
    prompt: string,
    workingDir: string,
    callbacks: PipelineCallbacks,
  ): Promise<PipelineState> {
    let state: PipelineState = {
      phase: 'plan',
      userPrompt: prompt,
      workingDir,
      retries: {},
    };

    while (state.phase !== 'done' && state.phase !== 'failed') {
      await callbacks.onPhaseChange?.(state.phase);

      switch (state.phase) {
        case 'plan':
          state = await this.doPlan(state, callbacks);
          break;
        case 'plan_review':
          state = await this.doReview(state, 'plan', callbacks);
          break;
        case 'implement':
          state = await this.doImplement(state, callbacks);
          break;
        case 'code_review':
          state = await this.doReview(state, 'code', callbacks);
          break;
        case 'push':
          state = await this.doPush(state, callbacks);
          break;
      }
    }

    return state;
  }
}
```

**状态转移规则:**

```
plan ──成功──→ plan_review
plan ──失败──→ failed

plan_review ──通过──→ implement
plan_review ──拒绝 & retries < 2──→ plan (携带反馈)
plan_review ──拒绝 & retries >= 2──→ failed

implement ──成功──→ code_review
implement ──失败──→ failed

code_review ──通过──→ push
code_review ──拒绝 & retries < 2──→ implement (携带反馈)
code_review ──拒绝 & retries >= 2──→ failed

push ──成功──→ done
push ──失败──→ failed (但代码已写好，报告手动步骤)
```

### 2. 并行 Review (reviewer.ts)

```typescript
interface ReviewAgent {
  role: string;
  systemPrompt: string;
}

interface ReviewVerdict {
  role: string;
  approved: boolean;
  summary: string;
  issues: string[];
}

interface ReviewResult {
  approved: boolean;
  verdicts: ReviewVerdict[];
  consolidated: string;
}

async function parallelReview(
  agents: ReviewAgent[],
  content: string,
  workingDir: string,
): Promise<ReviewResult> {
  const promises = agents.map(agent =>
    claudeExecutor.execute({
      sessionKey: `review-${agent.role}-${Date.now()}`,
      prompt: `审查以下内容，严格按格式输出：\n\n${content}`,
      workingDir,
      // review agent 独立运行，不继承会话、不保存摘要
    })
  );

  const results = await Promise.allSettled(promises);
  const verdicts = results.map((r, i) => parseVerdict(r, agents[i]));

  // 聚合策略：任一 agent 明确 REJECTED → 整体不通过
  const approved = verdicts.every(v => v.approved);
  const consolidated = verdicts
    .map(v => `### [${v.role}] ${v.approved ? 'APPROVED' : 'REJECTED'}\n${v.summary}`)
    .join('\n\n');

  return { approved, verdicts, consolidated };
}
```

**输出解析策略:**
- 要求 review agent 输出第一行为 `APPROVED` 或 `REJECTED`
- 解析失败时默认 `REJECTED`（宁可多审一轮，不放过问题）
- 单个 agent 超时/崩溃 → 该 agent 视为弃权，不阻塞整体

### 3. 角色化 System Prompts (prompts.ts)

```typescript
export const PLAN_AGENT_PROMPT = `你是一个技术方案设计师。
根据用户需求，分析现有代码，输出结构化的实施方案。

输出格式：
## 需求理解
(一句话总结)

## 影响范围
(列出需要修改的文件和原因)

## 实施步骤
(编号列表，每步具体到函数级别)

## 风险点
(可能出问题的地方)
`;

export const REVIEW_AGENTS: ReviewAgent[] = [
  {
    role: 'correctness',
    systemPrompt: `你是代码正确性审查员。
审查维度：逻辑错误、边界条件、类型安全、错误处理遗漏。
不关注代码风格。
输出格式：第一行 APPROVED 或 REJECTED，后跟问题列表。`,
  },
  {
    role: 'security',
    systemPrompt: `你是安全审查员。
审查维度：注入漏洞、权限绕过、敏感信息泄露、不安全的依赖。
不关注功能正确性。
输出格式：第一行 APPROVED 或 REJECTED，后跟问题列表。`,
  },
  {
    role: 'architecture',
    systemPrompt: `你是架构审查员。
审查维度：与现有代码风格一致性、抽象层次合理性、可维护性、接口设计。
不关注具体实现细节。
输出格式：第一行 APPROVED 或 REJECTED，后跟问题列表。`,
  },
];

export const IMPLEMENT_AGENT_PROMPT = `你是一个高级开发工程师。
根据已审批的技术方案，精确实施代码修改。

规则：
- 严格按方案执行，不擅自扩展范围
- 写完代码后运行测试
- 测试失败则修复，最多重试 2 轮
- 不要 git add . 或 git add -A
- 不要提交 .env 等敏感文件
`;
```

### 4. 飞书卡片集成

新增 `buildPipelineCard()` 显示管道进度：

```
┌──────────────────────────────────────┐
│ 🤖 Claude Code - 自动开发管道        │  (蓝色 header)
├──────────────────────────────────────┤
│ 指令: 添加用户注册功能...            │
├──────────────────────────────────────┤
│ ✅ 方案设计    → 已完成              │
│ ✅ 方案审查    → 3/3 通过            │
│ 🔄 代码实现    → 执行中...           │
│ ⬚ 代码审查                          │
│ ⬚ 推送 & PR                         │
├──────────────────────────────────────┤
│ ⏳ 阶段 3/5 | ⏱️ 45s                │
└──────────────────────────────────────┘
```

### 5. event-handler.ts 集成

```typescript
async function executeClaudeTask(prompt, chatId, userId, messageId, rootId) {
  // ... 现有的 session / thread 逻辑 ...

  const isPipelineTask = detectCodeTask(prompt);

  if (isPipelineTask) {
    const orchestrator = new PipelineOrchestrator();
    const finalState = await orchestrator.run(prompt, session.workingDir, {
      onPhaseChange: async (phase) => {
        if (progressMsgId) {
          await feishuClient.updateCard(progressMsgId, buildPipelineCard(prompt, phase));
        }
      },
      onStreamUpdate,
    });
    // 根据 finalState 构建最终结果卡片
  } else {
    // 现有单次 execute() 逻辑
  }
}
```

`detectCodeTask()` 可以用关键词匹配 + 让第一轮 plan agent 自行判断是否需要走管道。

---

## 可靠性保障

| 风险 | 对策 |
|------|------|
| Review Agent 输出格式不可控 | 强制首行 APPROVED/REJECTED，解析失败默认 REJECTED |
| 单个 review agent 超时/崩溃 | `Promise.allSettled`；失败 agent 视为弃权，不阻塞 |
| Plan 反复不通过死循环 | 每个 phase 硬限 2 次重试，超出则 failed，报告分歧 |
| Pipeline 中途进程崩溃 | PipelineState 可序列化到 DB，重启后从上一个完成的 phase 恢复 |
| 并行 review 资源消耗 | Review agent 设低预算 (maxBudgetUsd: 0.5, maxTurns: 10) |
| 用户等待焦虑 | 每个 phase 切换更新卡片，review 阶段显示 "2/3 agents 完成" |
| Review 反馈传递失真 | 把 consolidated review 原文注入下一轮 plan/implement 的 prompt |

---

## 成本估算

单次完整管道（无重试）：

| 步骤 | query 次数 |
|------|-----------|
| Plan | 1 |
| Plan Review | 3 (并行) |
| Implement | 1 |
| Code Review | 3 (并行) |
| Push | 1 |
| **合计** | **9** |

有重试最多 9 + 2×(1+3) = **17 次**。建议在管道触发前向用户确认。

---

## 实施建议

分两步：

1. **Phase A**: Pipeline 状态机 + 阶段卡片（不带并行 review，先用单 agent self-review）
   - 验证多步编排的稳定性、卡片更新、错误恢复
2. **Phase B**: 接入并行 Review Agent
   - 调优各角色 prompt，校准 approved/rejected 阈值
   - 性能调优（并行度、超时、预算）
