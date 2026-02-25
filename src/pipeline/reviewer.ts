import { claudeExecutor } from '../claude/executor.js';
import { logger } from '../utils/logger.js';
import { REVIEW_AGENT_CONFIGS } from './prompts.js';
import type { ReviewAgentConfig, ReviewResult, ReviewVerdict } from './types.js';

// ============================================================
// 并行 Review — 3 个角色 agent 同时审查，聚合结果
// ============================================================

export interface ParallelReviewOptions {
  reviewType: 'plan' | 'code';
  content: string;
  workingDir: string;
  /** 自定义 agent 配置列表。未提供时使用默认 REVIEW_AGENT_CONFIGS */
  agentConfigs?: ReviewAgentConfig[];
  onAgentComplete?: (completed: number, total: number, role: string, approved: boolean, abstained: boolean) => Promise<void>;
}

/**
 * 解析 review agent 输出中的 APPROVED/REJECTED
 */
export function parseVerdict(output: string): { approved: boolean; feedback: string } {
  const lines = output.trim().split('\n');
  const firstLine = lines[0]?.trim().toUpperCase() ?? '';

  if (firstLine === 'APPROVED' || firstLine.startsWith('APPROVED')) {
    return { approved: true, feedback: lines.slice(1).join('\n').trim() };
  }

  if (firstLine === 'REJECTED' || firstLine.startsWith('REJECTED')) {
    return { approved: false, feedback: lines.slice(1).join('\n').trim() };
  }

  // 无法解析 → 搜索全文
  if (/\bAPPROVED\b/i.test(output) && !/\bREJECTED\b/i.test(output)) {
    return { approved: true, feedback: output };
  }

  // 默认 REJECTED（宁可多审一轮）
  logger.warn({ firstLine: lines[0] }, 'Could not parse review verdict, defaulting to REJECTED');
  return { approved: false, feedback: output };
}

/**
 * 并行执行 3 个 review agent，聚合结果
 *
 * 聚合策略：
 * - 任一非弃权 agent REJECTED → 整体 REJECTED
 * - 全部弃权 → 整体 REJECTED (fail-closed)
 * - 其余 → 整体 APPROVED
 */
export async function parallelReview(options: ParallelReviewOptions): Promise<ReviewResult> {
  const { reviewType, content, workingDir, agentConfigs, onAgentComplete } = options;
  const allConfigs = agentConfigs ?? REVIEW_AGENT_CONFIGS;
  // plan review 时跳过 codeReviewOnly agent
  const configs = reviewType === 'plan'
    ? allConfigs.filter(c => !c.codeReviewOnly)
    : allConfigs;
  const total = configs.length;
  let completed = 0;

  const promises = configs.map(async (agentConfig): Promise<ReviewVerdict> => {
    // 自定义执行器路径（如 Codex CLI）
    if (agentConfig.customExecute) {
      const startTime = Date.now();
      try {
        const verdict = await agentConfig.customExecute(content, workingDir);
        completed++;
        await onAgentComplete?.(completed, total, agentConfig.role, verdict.approved, verdict.abstained);
        return verdict;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        logger.error(
          { role: agentConfig.role, reviewType, err },
          'Custom review agent threw exception, marking as abstained',
        );
        const verdict: ReviewVerdict = {
          role: agentConfig.role,
          approved: false,
          abstained: true,
          feedback: `Agent 异常: ${err instanceof Error ? err.message : String(err)}`,
          costUsd: 0,
          durationMs,
        };
        completed++;
        await onAgentComplete?.(completed, total, agentConfig.role, false, true);
        return verdict;
      }
    }

    const systemPrompt = reviewType === 'plan'
      ? agentConfig.planReviewSystemPrompt
      : agentConfig.codeReviewSystemPrompt;

    const startTime = Date.now();

    try {
      const result = await claudeExecutor.execute({
        sessionKey: `pipeline-${reviewType}_review-${agentConfig.role}-${Date.now()}`,
        prompt: content,
        workingDir,
        systemPromptOverride: systemPrompt,
        maxBudgetUsd: 5,
        maxTurns: 30,
      });

      const durationMs = Date.now() - startTime;

      if (!result.success) {
        logger.warn(
          { role: agentConfig.role, reviewType, error: result.error },
          'Review agent failed, marking as abstained',
        );
        const verdict: ReviewVerdict = {
          role: agentConfig.role,
          approved: false,
          abstained: true,
          feedback: `Agent 执行失败: ${result.error || '未知错误'}`,
          costUsd: result.costUsd ?? 0,
          durationMs,
        };
        completed++;
        await onAgentComplete?.(completed, total, agentConfig.role, false, true);
        return verdict;
      }

      const parsed = parseVerdict(result.output);
      const verdict: ReviewVerdict = {
        role: agentConfig.role,
        approved: parsed.approved,
        abstained: false,
        feedback: parsed.feedback,
        costUsd: result.costUsd ?? 0,
        durationMs,
      };

      completed++;
      await onAgentComplete?.(completed, total, agentConfig.role, parsed.approved, false);
      return verdict;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      logger.error(
        { role: agentConfig.role, reviewType, err },
        'Review agent threw exception, marking as abstained',
      );
      const verdict: ReviewVerdict = {
        role: agentConfig.role,
        approved: false,
        abstained: true,
        feedback: `Agent 异常: ${err instanceof Error ? err.message : String(err)}`,
        costUsd: 0,
        durationMs,
      };
      completed++;
      await onAgentComplete?.(completed, total, agentConfig.role, false, true);
      return verdict;
    }
  });

  const verdicts = await Promise.all(promises);

  // 聚合策略
  const nonAbstained = verdicts.filter(v => !v.abstained);
  const allAbstained = nonAbstained.length === 0;
  const anyRejected = nonAbstained.some(v => !v.approved);

  // 全部弃权 → fail-closed
  const approved = !allAbstained && !anyRejected;

  // 合并反馈：只包含 REJECTED 或弃权的 agent 反馈
  const feedbackParts: string[] = [];
  for (const v of verdicts) {
    const agentCfg = configs.find(c => c.role === v.role);
    const icon = agentCfg?.icon ?? '❓';
    if (v.abstained) {
      feedbackParts.push(`${icon} [${v.role}] (弃权) ${v.feedback}`);
    } else if (!v.approved) {
      feedbackParts.push(`${icon} [${v.role}] ${v.feedback}`);
    }
  }

  return {
    approved,
    verdicts,
    consolidatedFeedback: feedbackParts.join('\n\n'),
  };
}
