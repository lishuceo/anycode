// ============================================================
// Pipeline 类型定义
// ============================================================

/** 管道阶段 */
export type PipelinePhase =
  | 'plan'
  | 'plan_review'
  | 'implement'
  | 'code_review'
  | 'push'
  | 'pr_fixup'
  | 'done'
  | 'failed';

/** 管道生命周期状态（比 PipelinePhase 更宽泛） */
export type PipelineStatus =
  | 'pending_confirm'
  | 'running'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'interrupted'
  | 'cancelled';

/** 阶段元信息（用于卡片展示） */
export const PHASE_META: Record<PipelinePhase, { label: string; index: number }> = {
  plan:        { label: '方案设计', index: 1 },
  plan_review: { label: '方案审查', index: 2 },
  implement:   { label: '代码实现', index: 3 },
  code_review: { label: '代码审查', index: 4 },
  push:        { label: '推送 & PR', index: 5 },
  pr_fixup:    { label: 'CI 修复', index: 6 },
  done:        { label: '完成', index: 7 },
  failed:      { label: '失败', index: 7 },
};

export const TOTAL_PHASES = 6;

/** Review agent 角色配置 */
export interface ReviewAgentConfig {
  role: string;
  icon: string;
  planReviewSystemPrompt: string;
  codeReviewSystemPrompt: string;
  /** 自定义执行器。若提供，reviewer 使用它替代 claudeExecutor */
  customExecute?: (content: string, workingDir: string) => Promise<ReviewVerdict>;
  /** 是否仅参与 code review（跳过 plan review） */
  codeReviewOnly?: boolean;
}

/** 单个 review agent 的裁决 */
export interface ReviewVerdict {
  role: string;
  approved: boolean;
  abstained: boolean;  // agent 崩溃/超时时 true
  feedback: string;
  costUsd: number;
  durationMs: number;
}

/** 并行 review 聚合结果 */
export interface ReviewResult {
  approved: boolean;
  verdicts: ReviewVerdict[];
  consolidatedFeedback: string;  // 合并的拒绝反馈，用于注入重试 prompt
}

/** 管道状态（可序列化，用于恢复） */
export interface PipelineState {
  phase: PipelinePhase;
  userPrompt: string;
  workingDir: string;
  /** Step 1 输出：实施方案文本 */
  plan?: string;
  /** Step 2 输出：方案审查结果 */
  planReviewResult?: ReviewResult;
  /** Step 3 输出：实现摘要 */
  implementOutput?: string;
  /** Step 4 输出：代码审查结果 */
  codeReviewResult?: ReviewResult;
  /** Step 5 输出：推送/PR 结果 */
  pushOutput?: string;
  /** Step 6 输出：PR fixup 结果 */
  prFixupOutput?: string;
  /** 各阶段重试计数 */
  retries: Record<string, number>;
  /** 各阶段耗时 (ms) */
  phaseDurations: Record<string, number>;
  /** 总花费 (USD) */
  totalCostUsd: number;
  /** 失败原因 */
  failureReason?: string;
  /** 失败发生在哪个阶段（用于卡片展示失败位置） */
  failedAtPhase?: PipelinePhase;
}

/** 管道回调 */
export interface PipelineCallbacks {
  /** 阶段变更通知（用于更新飞书卡片） */
  onPhaseChange?: (state: PipelineState) => Promise<void>;
  /** 流式输出更新 */
  onStreamUpdate?: (text: string) => Promise<void>;
  /** 活动状态变更（同步回调，仅存储最新状态，搭载在下次卡片更新展示） */
  onActivityChange?: (status: import('../claude/types.js').ActivityStatus) => void;
}

/** 管道最终结果 */
export interface PipelineResult {
  success: boolean;
  state: PipelineState;
  /** 汇总的结果文本（用于飞书展示） */
  summary: string;
  /** 总耗时 (ms) */
  durationMs: number;
  /** 总花费 (USD) */
  totalCostUsd: number;
}
