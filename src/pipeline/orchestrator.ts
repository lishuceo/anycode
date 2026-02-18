import { claudeExecutor } from '../claude/executor.js';
import { logger } from '../utils/logger.js';
import type { ClaudeResult } from '../claude/types.js';
import type {
  PipelinePhase,
  PipelineState,
  PipelineCallbacks,
  PipelineResult,
} from './types.js';
import {
  PLAN_SYSTEM_PROMPT,
  IMPLEMENT_SYSTEM_PROMPT,
  PUSH_SYSTEM_PROMPT,
  REVIEW_AGENT_CONFIGS,
} from './prompts.js';
import { parallelReview } from './reviewer.js';

// ============================================================
// Pipeline Orchestrator — 状态机驱动的多步开发管道
//
// Phase A: 每步使用单独的 Claude Agent SDK query()
// Review 步骤暂用单 agent 自审，Phase B 将替换为并行多 agent
// ============================================================

const MAX_RETRIES = 2;

export class PipelineOrchestrator {
  /**
   * 执行完整管道
   */
  async run(
    prompt: string,
    workingDir: string,
    callbacks: PipelineCallbacks,
    historySummaries?: string,
  ): Promise<PipelineResult> {
    const startTime = Date.now();

    let state: PipelineState = {
      phase: 'plan',
      userPrompt: prompt,
      workingDir,
      retries: {},
      phaseDurations: {},
      totalCostUsd: 0,
    };

    logger.info({ prompt: prompt.slice(0, 100), workingDir }, 'Pipeline started');

    // 最大迭代保护：5 phases * 2 retries * 2 safety margin
    const MAX_ITERATIONS = 20;
    let iterations = 0;

    while (state.phase !== 'done' && state.phase !== 'failed') {
      if (++iterations > MAX_ITERATIONS) {
        state = { ...state, phase: 'failed', failedAtPhase: state.phase, failureReason: '管道超过最大迭代次数，可能存在循环' };
        break;
      }

      const currentPhase = state.phase;
      const phaseStart = Date.now();

      try { await callbacks.onPhaseChange?.(state); } catch (err) {
        logger.warn({ err, phase: currentPhase }, 'onPhaseChange callback failed');
      }

      logger.info({ phase: currentPhase, retries: state.retries }, 'Pipeline phase starting');

      switch (currentPhase) {
        case 'plan':
          state = await this.doPlan(state, callbacks, historySummaries);
          break;
        case 'plan_review':
          state = await this.doReview(state, 'plan_review', callbacks);
          break;
        case 'implement':
          state = await this.doImplement(state, callbacks);
          break;
        case 'code_review':
          state = await this.doReview(state, 'code_review', callbacks);
          break;
        case 'push':
          state = await this.doPush(state, callbacks);
          break;
      }

      state.phaseDurations[currentPhase] = Date.now() - phaseStart;
    }

    // 最终通知
    try { await callbacks.onPhaseChange?.(state); } catch (err) {
      logger.warn({ err, phase: state.phase }, 'Final onPhaseChange callback failed');
    }

    const durationMs = Date.now() - startTime;
    const summary = this.buildSummary(state);

    logger.info(
      { phase: state.phase, durationMs, costUsd: state.totalCostUsd },
      'Pipeline finished',
    );

    return {
      success: state.phase === 'done',
      state,
      summary,
      durationMs,
      totalCostUsd: state.totalCostUsd,
    };
  }

  // ============================================================
  // Phase: Plan
  // ============================================================

  private async doPlan(
    state: PipelineState,
    callbacks: PipelineCallbacks,
    historySummaries?: string,
  ): Promise<PipelineState> {
    // 如果是重试，带上上次 review 的反馈
    let prompt = state.userPrompt;
    if (state.planReviewResult && !state.planReviewResult.approved) {
      prompt = `${state.userPrompt}\n\n---\n上一版方案被审查拒绝，请根据以下反馈修改方案：\n${state.planReviewResult.consolidatedFeedback}`;
    }

    const result = await this.executeStep(
      `pipeline-plan-${Date.now()}`,
      prompt,
      state.workingDir,
      PLAN_SYSTEM_PROMPT,
      historySummaries,
      callbacks.onStreamUpdate,
    );

    const totalCostUsd = state.totalCostUsd + (result.costUsd ?? 0);

    if (!result.success || !result.output) {
      return {
        ...state,
        totalCostUsd,
        phase: 'failed',
        failedAtPhase: 'plan',
        failureReason: `方案设计失败: ${result.error || '无输出'}`,
      };
    }

    return {
      ...state,
      totalCostUsd,
      phase: 'plan_review',
      plan: result.output,
    };
  }

  // ============================================================
  // Phase: Review (plan_review 和 code_review 共用)
  // 使用并行多 agent review (Phase B)
  // ============================================================

  private async doReview(
    state: PipelineState,
    reviewPhase: 'plan_review' | 'code_review',
    callbacks: PipelineCallbacks,
  ): Promise<PipelineState> {
    const isPlanReview = reviewPhase === 'plan_review';

    // 构建 review prompt
    let content: string;
    if (isPlanReview) {
      content = `请审查以下实施方案：\n\n${state.plan}`;
    } else {
      content = [
        `请审查当前工作目录中的代码变更。`,
        ``,
        `原始需求: ${state.userPrompt}`,
        ``,
        `实施方案: ${state.plan?.slice(0, 1500) || '(无方案)'}`,
        ``,
        `实现报告: ${state.implementOutput?.slice(0, 1500) || '(无报告)'}`,
        ``,
        `请运行 git diff 查看实际变更，然后给出审查意见。`,
      ].join('\n');
    }

    // 构建进度状态 map，用于增量更新
    const agentStatus = new Map<string, string>();
    for (const config of REVIEW_AGENT_CONFIGS) {
      agentStatus.set(config.role, `${config.icon} ${config.role} ⏳`);
    }

    const reviewResult = await parallelReview({
      reviewType: isPlanReview ? 'plan' : 'code',
      content,
      workingDir: state.workingDir,
      onAgentComplete: async (_completed, _total, role, approved, abstained) => {
        const config = REVIEW_AGENT_CONFIGS.find(c => c.role === role);
        const icon = config?.icon ?? '❓';
        const statusIcon = abstained ? '⚠️' : approved ? '✅' : '❌';
        agentStatus.set(role, `${icon} ${role} ${statusIcon}`);

        const progressText = Array.from(agentStatus.values()).join(' | ');
        try {
          await callbacks.onStreamUpdate?.(progressText);
        } catch {
          // ignore callback errors
        }
      },
    });

    // 累加所有 agent 的 cost
    const reviewCost = reviewResult.verdicts.reduce((sum, v) => sum + v.costUsd, 0);
    const totalCostUsd = state.totalCostUsd + reviewCost;

    if (reviewResult.approved) {
      logger.info({ reviewPhase, verdicts: reviewResult.verdicts.map(v => ({ role: v.role, approved: v.approved, abstained: v.abstained })) }, 'Review approved');
      return {
        ...state,
        totalCostUsd,
        phase: isPlanReview ? 'implement' : 'push',
        ...(isPlanReview
          ? { planReviewResult: reviewResult }
          : { codeReviewResult: reviewResult }),
      };
    }

    // REJECTED — 检查重试次数
    const retryKey = reviewPhase;
    const retryCount = (state.retries[retryKey] ?? 0) + 1;

    if (retryCount >= MAX_RETRIES) {
      logger.warn({ reviewPhase, retryCount }, 'Review rejected, max retries reached');
      return {
        ...state,
        totalCostUsd,
        phase: 'failed',
        failedAtPhase: reviewPhase,
        retries: { ...state.retries, [retryKey]: retryCount },
        ...(isPlanReview
          ? { planReviewResult: reviewResult }
          : { codeReviewResult: reviewResult }),
        failureReason: `${isPlanReview ? '方案' : '代码'}审查连续 ${retryCount} 次未通过:\n${reviewResult.consolidatedFeedback}`,
      };
    }

    logger.info({ reviewPhase, retryCount, feedback: reviewResult.consolidatedFeedback.slice(0, 200) }, 'Review rejected, retrying');

    // 回退到上一步重做
    return {
      ...state,
      totalCostUsd,
      phase: isPlanReview ? 'plan' : 'implement',
      retries: { ...state.retries, [retryKey]: retryCount },
      ...(isPlanReview
        ? { planReviewResult: reviewResult }
        : { codeReviewResult: reviewResult }),
    };
  }

  // ============================================================
  // Phase: Implement
  // ============================================================

  private async doImplement(
    state: PipelineState,
    callbacks: PipelineCallbacks,
  ): Promise<PipelineState> {
    let prompt = `请按照以下已审批方案实施代码修改：\n\n${state.plan}`;

    // 如果是重试，带上 code review 反馈
    if (state.codeReviewResult && !state.codeReviewResult.approved) {
      prompt += `\n\n---\n上一版实现被代码审查拒绝，请根据以下反馈修改：\n${state.codeReviewResult.consolidatedFeedback}`;
    }

    const result = await this.executeStep(
      `pipeline-implement-${Date.now()}`,
      prompt,
      state.workingDir,
      IMPLEMENT_SYSTEM_PROMPT,
      undefined,
      callbacks.onStreamUpdate,
    );

    const totalCostUsd = state.totalCostUsd + (result.costUsd ?? 0);

    if (!result.success) {
      return {
        ...state,
        totalCostUsd,
        phase: 'failed',
        failedAtPhase: 'implement',
        failureReason: `代码实现失败: ${result.error || '无输出'}`,
      };
    }

    return {
      ...state,
      totalCostUsd,
      phase: 'code_review',
      implementOutput: result.output,
    };
  }

  // ============================================================
  // Phase: Push
  // ============================================================

  private async doPush(
    state: PipelineState,
    callbacks: PipelineCallbacks,
  ): Promise<PipelineState> {
    const prompt = [
      `请将当前工作目录中的代码变更提交并推送。`,
      ``,
      `原始需求: ${state.userPrompt}`,
      ``,
      `实现摘要: ${state.implementOutput?.slice(0, 1000) || '(无)'}`,
    ].join('\n');

    const result = await this.executeStep(
      `pipeline-push-${Date.now()}`,
      prompt,
      state.workingDir,
      PUSH_SYSTEM_PROMPT,
      undefined,
      callbacks.onStreamUpdate,
    );

    const totalCostUsd = state.totalCostUsd + (result.costUsd ?? 0);

    if (!result.success) {
      // push 失败不算完全失败，代码已经写好了
      return {
        ...state,
        totalCostUsd,
        phase: 'done',
        pushOutput: `推送失败，但代码修改已完成: ${result.error || result.output}`,
      };
    }

    return {
      ...state,
      totalCostUsd,
      phase: 'done',
      pushOutput: result.output,
    };
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 执行单步 Claude query（底层调用 claudeExecutor）
   */
  private async executeStep(
    sessionKey: string,
    prompt: string,
    workingDir: string,
    systemPrompt: string,
    historySummaries?: string,
    onStreamUpdate?: (text: string) => Promise<void>,
  ): Promise<ClaudeResult> {
    return claudeExecutor.execute({
      sessionKey,
      prompt,
      workingDir,
      // pipeline 每步独立，不 resume 上一步的 session
      resumeSessionId: undefined,
      onStreamUpdate,
      historySummaries,
      systemPromptOverride: systemPrompt,
    });
  }

  /**
   * 格式化 review 结果为摘要文本
   */
  private formatReviewSummary(label: string, result: import('./types.js').ReviewResult): string {
    const lines = result.verdicts.map((v) => {
      const config = REVIEW_AGENT_CONFIGS.find(c => c.role === v.role);
      const icon = config?.icon ?? '❓';
      const status = v.abstained ? '⚠️ 弃权' : v.approved ? '✅ 通过' : '❌ 拒绝';
      return `  ${icon} ${v.role}: ${status}`;
    });
    const overall = result.approved ? '✅ 通过' : '❌ 未通过';
    return `**${label}:** ${overall}\n${lines.join('\n')}`;
  }

  /**
   * 构建最终摘要文本
   */
  private buildSummary(state: PipelineState): string {
    if (state.phase === 'failed') {
      const parts: string[] = ['## 管道执行失败'];
      if (state.failureReason) parts.push(`\n**原因:** ${state.failureReason}`);
      if (state.planReviewResult) {
        parts.push(`\n${this.formatReviewSummary('方案审查', state.planReviewResult)}`);
      }
      if (state.plan) parts.push(`\n**方案:**\n${state.plan.slice(0, 1000)}`);
      if (state.codeReviewResult) {
        parts.push(`\n${this.formatReviewSummary('代码审查', state.codeReviewResult)}`);
      }
      if (state.implementOutput) parts.push(`\n**已完成的实现:**\n${state.implementOutput.slice(0, 1000)}`);
      return parts.join('\n');
    }

    const parts: string[] = ['## 管道执行完成'];

    if (state.plan) {
      parts.push(`\n**方案:**\n${state.plan.slice(0, 800)}`);
    }
    if (state.planReviewResult) {
      parts.push(`\n${this.formatReviewSummary('方案审查', state.planReviewResult)}`);
    }
    if (state.implementOutput) {
      parts.push(`\n**实现:**\n${state.implementOutput.slice(0, 800)}`);
    }
    if (state.codeReviewResult) {
      parts.push(`\n${this.formatReviewSummary('代码审查', state.codeReviewResult)}`);
    }
    if (state.pushOutput) {
      parts.push(`\n**推送:**\n${state.pushOutput.slice(0, 500)}`);
    }

    return parts.join('\n');
  }
}
