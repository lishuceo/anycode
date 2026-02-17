import type { ClaudeResult } from '../claude/types.js';

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
  | 'done'
  | 'failed';

/** 阶段元信息（用于卡片展示） */
export const PHASE_META: Record<PipelinePhase, { label: string; index: number }> = {
  plan:        { label: '方案设计', index: 1 },
  plan_review: { label: '方案审查', index: 2 },
  implement:   { label: '代码实现', index: 3 },
  code_review: { label: '代码审查', index: 4 },
  push:        { label: '推送 & PR', index: 5 },
  done:        { label: '完成', index: 6 },
  failed:      { label: '失败', index: 6 },
};

export const TOTAL_PHASES = 5;

/** 管道状态（可序列化，用于恢复） */
export interface PipelineState {
  phase: PipelinePhase;
  userPrompt: string;
  workingDir: string;
  /** Step 1 输出：实施方案文本 */
  plan?: string;
  /** Step 2 输出：审查结果 */
  planReviewFeedback?: string;
  /** Step 3 输出：实现摘要 */
  implementOutput?: string;
  /** Step 4 输出：代码审查结果 */
  codeReviewFeedback?: string;
  /** Step 5 输出：推送/PR 结果 */
  pushOutput?: string;
  /** 各阶段重试计数 */
  retries: Record<string, number>;
  /** 各阶段耗时 (ms) */
  phaseDurations: Record<string, number>;
  /** 总花费 (USD) */
  totalCostUsd: number;
  /** 失败原因 */
  failureReason?: string;
}

/** 管道回调 */
export interface PipelineCallbacks {
  /** 阶段变更通知（用于更新飞书卡片） */
  onPhaseChange?: (state: PipelineState) => Promise<void>;
  /** 流式输出更新 */
  onStreamUpdate?: (text: string) => Promise<void>;
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

/** 单步执行结果（内部使用） */
export interface StepResult {
  success: boolean;
  output: string;
  costUsd: number;
  /** 下一个阶段 */
  nextPhase: PipelinePhase;
}
