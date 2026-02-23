import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaudeResult } from '../../claude/types.js';
import type { ReviewResult } from '../types.js';

vi.mock('../../claude/executor.js', () => ({
  claudeExecutor: {
    execute: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../reviewer.js', () => ({
  parallelReview: vi.fn(),
}));

import { PipelineOrchestrator } from '../orchestrator.js';
import { claudeExecutor } from '../../claude/executor.js';
import { parallelReview } from '../reviewer.js';

const mockExecute = vi.mocked(claudeExecutor.execute);
const mockParallelReview = vi.mocked(parallelReview);

function makeResult(overrides: Partial<ClaudeResult> = {}): ClaudeResult {
  return {
    success: true,
    output: 'mock output',
    durationMs: 100,
    costUsd: 0.01,
    ...overrides,
  };
}

function makeReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    approved: true,
    verdicts: [
      { role: 'correctness', approved: true, abstained: false, feedback: '', costUsd: 0.05, durationMs: 100 },
      { role: 'security', approved: true, abstained: false, feedback: '', costUsd: 0.04, durationMs: 100 },
      { role: 'architecture', approved: true, abstained: false, feedback: '', costUsd: 0.03, durationMs: 100 },
    ],
    consolidatedFeedback: '',
    ...overrides,
  };
}

const noopCallbacks = { onPhaseChange: vi.fn() };

describe('PipelineOrchestrator', () => {
  let orchestrator: PipelineOrchestrator;

  beforeEach(() => {
    orchestrator = new PipelineOrchestrator();
    vi.clearAllMocks();
    mockExecute.mockReset();
    mockParallelReview.mockReset();
  });

  // ============================================================
  // 完整流程 — 正常路径 (全部 APPROVED)
  // ============================================================

  describe('happy path', () => {
    it('should complete full pipeline: plan → review → implement → review → push → pr_fixup → done', async () => {
      // 4 executor calls: plan, implement, push, pr_fixup
      // 2 parallelReview calls: plan_review, code_review
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: '## 需求理解\nTest plan' }))      // plan
        .mockResolvedValueOnce(makeResult({ output: '## 实现摘要\n修改了 foo.ts' }))   // implement
        .mockResolvedValueOnce(makeResult({ output: '## 推送结果\nPR: #123' }))        // push
        .mockResolvedValueOnce(makeResult({ output: '## CI 修复结果\n全部通过' }));     // pr_fixup

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())   // plan_review
        .mockResolvedValueOnce(makeReviewResult());   // code_review

      const result = await orchestrator.run('添加登录功能', '/tmp/work', noopCallbacks);

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
      expect(mockExecute).toHaveBeenCalledTimes(4);
      expect(mockParallelReview).toHaveBeenCalledTimes(2);
      // Cost: 4 executor calls * 0.01 + 2 review results * (0.05 + 0.04 + 0.03)
      expect(result.totalCostUsd).toBeCloseTo(0.04 + 0.12 + 0.12);
    });

    it('should pass historySummaries only to the plan step', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      await orchestrator.run('task', '/tmp', noopCallbacks, '历史摘要内容');

      // plan step (call 0) should include historySummaries
      const planCall = mockExecute.mock.calls[0][0];
      expect(planCall.historySummaries).toBe('历史摘要内容');

      // subsequent executor steps should not have historySummaries
      for (let i = 1; i < mockExecute.mock.calls.length; i++) {
        expect(mockExecute.mock.calls[i][0].historySummaries).toBeUndefined();
      }
    });

    it('should pass systemPromptOverride to executor steps', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      await orchestrator.run('task', '/tmp', noopCallbacks);

      for (let i = 0; i < mockExecute.mock.calls.length; i++) {
        expect(mockExecute.mock.calls[i][0].systemPromptOverride).toBeDefined();
        expect(typeof mockExecute.mock.calls[i][0].systemPromptOverride).toBe('string');
      }
    });

    it('should call onPhaseChange for every phase transition + final state', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      const onPhaseChange = vi.fn();
      await orchestrator.run('task', '/tmp', { onPhaseChange });

      // 6 phases in loop + 1 final notify = 7
      expect(onPhaseChange).toHaveBeenCalledTimes(7);

      const phases = onPhaseChange.mock.calls.map((c: unknown[]) => (c[0] as { phase: string }).phase);
      expect(phases).toEqual(['plan', 'plan_review', 'implement', 'code_review', 'push', 'pr_fixup', 'done']);
    });

    it('should pass reviewType plan to parallelReview for plan_review phase', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(mockParallelReview.mock.calls[0][0].reviewType).toBe('plan');
      expect(mockParallelReview.mock.calls[1][0].reviewType).toBe('code');
    });
  });

  // ============================================================
  // Plan 失败
  // ============================================================

  describe('plan failure', () => {
    it('should fail if plan agent returns success: false', async () => {
      mockExecute.mockResolvedValueOnce(makeResult({ success: false, error: 'Agent error' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failureReason).toContain('方案设计失败');
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockParallelReview).not.toHaveBeenCalled();
    });

    it('should fail if plan agent returns empty output', async () => {
      mockExecute.mockResolvedValueOnce(makeResult({ output: '' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failedAtPhase).toBe('plan');
    });
  });

  // ============================================================
  // Plan Review — REJECTED + 重试
  // ============================================================

  describe('plan review rejection and retry', () => {
    it('should retry plan once when plan review rejects', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan v1' }))                       // plan
        .mockResolvedValueOnce(makeResult({ output: 'plan v2 (improved)' }))             // plan (retry)
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))                    // implement
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))                         // push
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));                    // pr_fixup

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult({                                        // plan_review → REJECTED
          approved: false,
          verdicts: [
            { role: 'correctness', approved: false, abstained: false, feedback: '方案不完整', costUsd: 0.05, durationMs: 100 },
            { role: 'security', approved: true, abstained: false, feedback: '', costUsd: 0.04, durationMs: 100 },
            { role: 'architecture', approved: true, abstained: false, feedback: '', costUsd: 0.03, durationMs: 100 },
          ],
          consolidatedFeedback: '🐛 [correctness] 方案不完整',
        }))
        .mockResolvedValueOnce(makeReviewResult())                                       // plan_review → APPROVED
        .mockResolvedValueOnce(makeReviewResult());                                      // code_review → APPROVED

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
      expect(mockExecute).toHaveBeenCalledTimes(5);
      expect(mockParallelReview).toHaveBeenCalledTimes(3);

      // Verify retry prompt includes review feedback
      const retryPlanCall = mockExecute.mock.calls[1][0];
      expect(retryPlanCall.prompt).toContain('方案不完整');
    });

    it('should fail after 2 consecutive plan review rejections', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan v1' }))
        .mockResolvedValueOnce(makeResult({ output: 'plan v2' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult({
          approved: false,
          consolidatedFeedback: '问题1',
        }))
        .mockResolvedValueOnce(makeReviewResult({
          approved: false,
          consolidatedFeedback: '问题2',
        }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failureReason).toContain('方案审查');
      expect(result.state.failureReason).toContain('2 次未通过');
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockParallelReview).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // Implement 失败
  // ============================================================

  describe('implement failure', () => {
    it('should fail if implement agent returns success: false', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'compile error' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult());

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failureReason).toContain('代码实现失败');
      expect(result.state.failedAtPhase).toBe('implement');
    });
  });

  // ============================================================
  // Code Review — REJECTED + 重试
  // ============================================================

  describe('code review rejection and retry', () => {
    it('should retry implement once when code review rejects', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v1' }))                     // implement
        .mockResolvedValueOnce(makeResult({ output: 'impl v2 (fixed)' }))              // implement (retry)
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))                       // push
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));                  // pr_fixup

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())                                     // plan_review → APPROVED
        .mockResolvedValueOnce(makeReviewResult({                                      // code_review → REJECTED
          approved: false,
          verdicts: [
            { role: 'correctness', approved: true, abstained: false, feedback: '', costUsd: 0.05, durationMs: 100 },
            { role: 'security', approved: false, abstained: false, feedback: '安全漏洞', costUsd: 0.04, durationMs: 100 },
            { role: 'architecture', approved: true, abstained: false, feedback: '', costUsd: 0.03, durationMs: 100 },
          ],
          consolidatedFeedback: '🔒 [security] 安全漏洞',
        }))
        .mockResolvedValueOnce(makeReviewResult());                                    // code_review → APPROVED

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(5);
      expect(mockParallelReview).toHaveBeenCalledTimes(3);

      // Verify retry prompt includes code review feedback
      const retryImplCall = mockExecute.mock.calls[2][0];
      expect(retryImplCall.prompt).toContain('安全漏洞');
    });

    it('should fail after 2 consecutive code review rejections', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v1' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v2' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult({ approved: false, consolidatedFeedback: 'bug A' }))
        .mockResolvedValueOnce(makeReviewResult({ approved: false, consolidatedFeedback: 'bug B' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failureReason).toContain('代码审查');
    });
  });

  // ============================================================
  // Push 失败 — 不算管道失败
  // ============================================================

  describe('push failure', () => {
    it('should mark done (not failed) when push fails — code is already written', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'git push failed' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
      expect(result.state.pushOutput).toContain('推送失败');
      expect(result.state.pushOutput).toContain('代码修改已完成');
    });
  });

  // ============================================================
  // PR Fixup 失败 — 不算管道失败
  // ============================================================

  describe('pr_fixup failure', () => {
    it('should mark done (not failed) when pr_fixup fails — PR already exists', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))
        .mockResolvedValueOnce(makeResult({ output: 'PR #123' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'CI timed out' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
      expect(result.state.prFixupOutput).toContain('CI 修复未能完全自动化');
      expect(result.state.prFixupOutput).toContain('CI timed out');
    });
  });

  // ============================================================
  // 成本累计 — 包括 review verdicts
  // ============================================================

  describe('cost tracking', () => {
    it('should accumulate costs across all phases including review verdicts', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan', costUsd: 0.10 }))
        .mockResolvedValueOnce(makeResult({ output: 'impl', costUsd: 0.50 }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed', costUsd: 0.02 }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done', costUsd: 0.03 }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult({
          verdicts: [
            { role: 'correctness', approved: true, abstained: false, feedback: '', costUsd: 0.10, durationMs: 100 },
            { role: 'security', approved: true, abstained: false, feedback: '', costUsd: 0.08, durationMs: 100 },
            { role: 'architecture', approved: true, abstained: false, feedback: '', costUsd: 0.05, durationMs: 100 },
          ],
        }))
        .mockResolvedValueOnce(makeReviewResult({
          verdicts: [
            { role: 'correctness', approved: true, abstained: false, feedback: '', costUsd: 0.06, durationMs: 100 },
            { role: 'security', approved: true, abstained: false, feedback: '', costUsd: 0.04, durationMs: 100 },
            { role: 'architecture', approved: true, abstained: false, feedback: '', costUsd: 0.03, durationMs: 100 },
          ],
        }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      // executor: 0.10 + 0.50 + 0.02 + 0.03 = 0.65
      // review1: 0.10 + 0.08 + 0.05 = 0.23
      // review2: 0.06 + 0.04 + 0.03 = 0.13
      // total: 1.01
      expect(result.totalCostUsd).toBeCloseTo(1.01);
    });

    it('should handle undefined costUsd gracefully', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan', costUsd: undefined }))
        .mockResolvedValueOnce(makeResult({ output: 'impl', costUsd: 0.50 }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed', costUsd: undefined }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done', costUsd: undefined }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      // executor: 0 + 0.50 + 0 + 0 = 0.50
      // review costs from default makeReviewResult: 2 * (0.05 + 0.04 + 0.03) = 0.24
      expect(result.totalCostUsd).toBeCloseTo(0.74);
    });
  });

  // ============================================================
  // 摘要生成
  // ============================================================

  describe('summary generation', () => {
    it('should include plan, implement, push, pr_fixup output and review results in success summary', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'my plan details' }))
        .mockResolvedValueOnce(makeResult({ output: 'implementation report' }))
        .mockResolvedValueOnce(makeResult({ output: 'PR #42 created' }))
        .mockResolvedValueOnce(makeResult({ output: 'CI all passed' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.summary).toContain('管道执行完成');
      expect(result.summary).toContain('my plan details');
      expect(result.summary).toContain('implementation report');
      expect(result.summary).toContain('PR #42 created');
      expect(result.summary).toContain('CI all passed');
      expect(result.summary).toContain('方案审查');
      expect(result.summary).toContain('代码审查');
      expect(result.summary).toContain('✅ 通过');
    });

    it('should include failure reason and review details in failed summary', async () => {
      mockExecute.mockResolvedValueOnce(makeResult({ success: false, error: 'timeout' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.summary).toContain('管道执行失败');
      expect(result.summary).toContain('方案设计失败');
    });

    it('should show rejected reviewers in failed summary', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan v1' }))
        .mockResolvedValueOnce(makeResult({ output: 'plan v2' }));

      const rejectedReview = makeReviewResult({
        approved: false,
        verdicts: [
          { role: 'correctness', approved: false, abstained: false, feedback: '逻辑错误', costUsd: 0.05, durationMs: 100 },
          { role: 'security', approved: true, abstained: false, feedback: '', costUsd: 0.04, durationMs: 100 },
          { role: 'architecture', approved: true, abstained: false, feedback: '', costUsd: 0.03, durationMs: 100 },
        ],
        consolidatedFeedback: '逻辑错误',
      });

      mockParallelReview
        .mockResolvedValueOnce(rejectedReview)
        .mockResolvedValueOnce(rejectedReview);

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.summary).toContain('管道执行失败');
      expect(result.summary).toContain('correctness');
      expect(result.summary).toContain('❌ 拒绝');
    });
  });

  // ============================================================
  // workingDir 传递
  // ============================================================

  describe('workingDir propagation', () => {
    it('should pass workingDir to every step and review', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      await orchestrator.run('task', '/my/project', noopCallbacks);

      for (let i = 0; i < mockExecute.mock.calls.length; i++) {
        expect(mockExecute.mock.calls[i][0].workingDir).toBe('/my/project');
      }
      for (let i = 0; i < mockParallelReview.mock.calls.length; i++) {
        expect(mockParallelReview.mock.calls[i][0].workingDir).toBe('/my/project');
      }
    });
  });

  // ============================================================
  // onStreamUpdate 回调
  // ============================================================

  describe('stream update callback', () => {
    it('should forward onStreamUpdate to executor steps', async () => {
      const onStreamUpdate = vi.fn();

      mockExecute.mockImplementation(async (opts) => {
        await opts.onStreamUpdate?.('partial output');
        return makeResult({ output: 'output' });
      });

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      await orchestrator.run('task', '/tmp', {
        onPhaseChange: vi.fn(),
        onStreamUpdate,
      });

      expect(onStreamUpdate).toHaveBeenCalledWith('partial output');
    });
  });

  // ============================================================
  // failedAtPhase 追踪
  // ============================================================

  describe('failedAtPhase tracking', () => {
    it('should set failedAtPhase to plan when plan fails', async () => {
      mockExecute.mockResolvedValueOnce(makeResult({ success: false, error: 'err' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.state.failedAtPhase).toBe('plan');
    });

    it('should set failedAtPhase to implement when implement fails', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'compile error' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult());

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.state.failedAtPhase).toBe('implement');
    });

    it('should set failedAtPhase to plan_review when plan review max retries exceeded', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan v1' }))
        .mockResolvedValueOnce(makeResult({ output: 'plan v2' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult({ approved: false, consolidatedFeedback: '问题1' }))
        .mockResolvedValueOnce(makeReviewResult({ approved: false, consolidatedFeedback: '问题2' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.state.failedAtPhase).toBe('plan_review');
    });

    it('should set failedAtPhase to code_review when code review max retries exceeded', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v1' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v2' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult({ approved: false, consolidatedFeedback: 'bug A' }))
        .mockResolvedValueOnce(makeReviewResult({ approved: false, consolidatedFeedback: 'bug B' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.state.failedAtPhase).toBe('code_review');
    });
  });

  // ============================================================
  // Abort 支持
  // ============================================================

  describe('abort', () => {
    it('should stop pipeline when abort is called before first phase', async () => {
      const orchestrator = new PipelineOrchestrator();
      orchestrator.abort();

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failureReason).toBe('用户手动中止');
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should stop pipeline between phases when abort is called', async () => {
      // Plan executes, plan_review passes, then abort before implement runs
      mockExecute.mockResolvedValueOnce(makeResult({ output: 'plan' }));
      mockParallelReview.mockResolvedValueOnce(makeReviewResult());

      const orch = new PipelineOrchestrator();

      // Abort right when we see implement about to start
      // onPhaseChange is called BEFORE the phase executes
      const onPhaseChange = vi.fn().mockImplementation(async (state: { phase: string }) => {
        if (state.phase === 'implement') {
          orch.abort();
        }
      });

      // Need to provide a mock for implement in case abort timing doesn't prevent it
      mockExecute.mockResolvedValueOnce(makeResult({ output: 'impl' }));

      const result = await orch.run('task', '/tmp', { onPhaseChange });

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failureReason).toBe('用户手动中止');
    });

    it('should expose current session key via getCurrentSessionKey()', async () => {
      let capturedKey: string | undefined;

      mockExecute.mockImplementation(async (opts) => {
        capturedKey = opts.sessionKey;
        return makeResult({ output: 'plan' });
      });

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));

      const orchestrator = new PipelineOrchestrator();
      await orchestrator.run('task', '/tmp', noopCallbacks);

      // getCurrentSessionKey should return the last session key used
      const key = orchestrator.getCurrentSessionKey();
      expect(key).toBeDefined();
      expect(key).toContain('pipeline-');
    });
  });

  // ============================================================
  // MAX_ITERATIONS 循环保护
  // ============================================================

  describe('max iterations protection', () => {
    it('should fail pipeline when iterations exceed MAX_ITERATIONS', async () => {
      // Set up mocks for many iterations
      for (let i = 0; i < 25; i++) {
        mockExecute.mockResolvedValueOnce(makeResult({ output: `plan v${i}` }));
      }
      for (let i = 0; i < 25; i++) {
        mockParallelReview.mockResolvedValueOnce(makeReviewResult({ approved: false, consolidatedFeedback: 'redo' }));
      }

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
    });
  });

  // ============================================================
  // onPhaseChange 回调异常不中断管道
  // ============================================================

  describe('callback error resilience', () => {
    it('should continue pipeline when onPhaseChange throws', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      const failingCallback = vi.fn().mockRejectedValue(new Error('callback exploded'));

      const result = await orchestrator.run('task', '/tmp', {
        onPhaseChange: failingCallback,
      });

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
      expect(failingCallback).toHaveBeenCalled();
    });

    it('should complete pipeline when onPhaseChange throws on final notification', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }))
        .mockResolvedValueOnce(makeResult({ output: 'fixup done' }));

      mockParallelReview
        .mockResolvedValueOnce(makeReviewResult())
        .mockResolvedValueOnce(makeReviewResult());

      let callCount = 0;
      const onPhaseChange = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 7) throw new Error('final callback error');
      });

      const result = await orchestrator.run('task', '/tmp', { onPhaseChange });

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
    });
  });
});
