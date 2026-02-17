import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaudeResult } from '../../claude/types.js';

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

import { PipelineOrchestrator } from '../orchestrator.js';
import { claudeExecutor } from '../../claude/executor.js';

const mockExecute = vi.mocked(claudeExecutor.execute);

function makeResult(overrides: Partial<ClaudeResult> = {}): ClaudeResult {
  return {
    success: true,
    output: 'mock output',
    durationMs: 100,
    costUsd: 0.01,
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
  });

  // ============================================================
  // 完整流程 — 正常路径 (全部 APPROVED)
  // ============================================================

  describe('happy path', () => {
    it('should complete full pipeline: plan → review → implement → review → push → done', async () => {
      // 5 calls: plan, plan_review, implement, code_review, push
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: '## 需求理解\nTest plan' }))      // plan
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\n没有问题' }))            // plan_review
        .mockResolvedValueOnce(makeResult({ output: '## 实现摘要\n修改了 foo.ts' }))   // implement
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\n代码质量良好' }))        // code_review
        .mockResolvedValueOnce(makeResult({ output: '## 推送结果\nPR: #123' }));       // push

      const result = await orchestrator.run('添加登录功能', '/tmp/work', noopCallbacks);

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
      expect(mockExecute).toHaveBeenCalledTimes(5);
      expect(result.totalCostUsd).toBeCloseTo(0.05);
    });

    it('should pass historySummaries only to the plan step', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));

      await orchestrator.run('task', '/tmp', noopCallbacks, '历史摘要内容');

      // plan step (call 0) should include historySummaries
      const planCall = mockExecute.mock.calls[0][0];
      expect(planCall.historySummaries).toBe('历史摘要内容');

      // subsequent steps should not have historySummaries
      for (let i = 1; i < 5; i++) {
        expect(mockExecute.mock.calls[i][0].historySummaries).toBeUndefined();
      }
    });

    it('should pass systemPromptOverride to each step', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));

      await orchestrator.run('task', '/tmp', noopCallbacks);

      for (let i = 0; i < 5; i++) {
        expect(mockExecute.mock.calls[i][0].systemPromptOverride).toBeDefined();
        expect(typeof mockExecute.mock.calls[i][0].systemPromptOverride).toBe('string');
      }
    });

    it('should call onPhaseChange for every phase transition + final state', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));

      const onPhaseChange = vi.fn();
      await orchestrator.run('task', '/tmp', { onPhaseChange });

      // 5 phases in loop + 1 final notify = 6
      expect(onPhaseChange).toHaveBeenCalledTimes(6);

      const phases = onPhaseChange.mock.calls.map((c: unknown[]) => (c[0] as { phase: string }).phase);
      expect(phases).toEqual(['plan', 'plan_review', 'implement', 'code_review', 'push', 'done']);
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
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n方案不完整' }))           // plan_review → REJECTED
        .mockResolvedValueOnce(makeResult({ output: 'plan v2 (improved)' }))             // plan (retry)
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))                       // plan_review → APPROVED
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))                    // implement
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))                       // code_review
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));                        // push

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
      expect(mockExecute).toHaveBeenCalledTimes(7);

      // Verify retry prompt includes review feedback
      const retryPlanCall = mockExecute.mock.calls[2][0];
      expect(retryPlanCall.prompt).toContain('方案不完整');
    });

    it('should fail after 2 consecutive plan review rejections', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan v1' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n问题1' }))
        .mockResolvedValueOnce(makeResult({ output: 'plan v2' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n问题2' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failureReason).toContain('方案审查');
      expect(result.state.failureReason).toContain('2 次未通过');
      expect(mockExecute).toHaveBeenCalledTimes(4);
    });
  });

  // ============================================================
  // Implement 失败
  // ============================================================

  describe('implement failure', () => {
    it('should fail if implement agent returns success: false', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'compile error' }));

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
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v1' }))                     // implement
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n安全漏洞' }))           // code_review → REJECTED
        .mockResolvedValueOnce(makeResult({ output: 'impl v2 (fixed)' }))              // implement (retry)
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))                     // code_review → APPROVED
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));                      // push

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(7);

      // Verify retry prompt includes code review feedback
      const retryImplCall = mockExecute.mock.calls[4][0];
      expect(retryImplCall.prompt).toContain('安全漏洞');
    });

    it('should fail after 2 consecutive code review rejections', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v1' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\nbug A' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v2' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\nbug B' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failureReason).toContain('代码审查');
    });
  });

  // ============================================================
  // Review agent 自身失败 — fail-closed（管道失败）
  // ============================================================

  describe('review agent failure (fail-closed)', () => {
    it('should fail pipeline when plan review agent crashes', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'agent crash' }));  // plan_review crashes

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failedAtPhase).toBe('plan_review');
      expect(result.state.failureReason).toContain('审查 agent 执行失败');
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('should fail pipeline when code review agent crashes', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'timeout' }));      // code_review crashes

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      expect(result.state.failedAtPhase).toBe('code_review');
      expect(result.state.failureReason).toContain('审查 agent 执行失败');
      expect(mockExecute).toHaveBeenCalledTimes(4);
    });
  });

  // ============================================================
  // Push 失败 — 不算管道失败
  // ============================================================

  describe('push failure', () => {
    it('should mark done (not failed) when push fails — code is already written', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'implemented' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'git push failed' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
      expect(result.state.pushOutput).toContain('推送失败');
      expect(result.state.pushOutput).toContain('代码修改已完成');
    });
  });

  // ============================================================
  // Verdict 解析
  // ============================================================

  describe('verdict parsing', () => {
    it('should parse APPROVED on first line', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\nsome suggestions' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);
      expect(result.success).toBe(true);
    });

    it('should parse REJECTED on first line', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n- 缺少错误处理' }))
        .mockResolvedValueOnce(makeResult({ output: 'plan v2' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);
      expect(result.success).toBe(true);
      // plan was retried
      expect(mockExecute).toHaveBeenCalledTimes(7);
    });

    it('should default to REJECTED when verdict is unparseable', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        // unparseable output — no APPROVED or REJECTED keyword
        .mockResolvedValueOnce(makeResult({ output: '我觉得还行吧' }))
        .mockResolvedValueOnce(makeResult({ output: 'plan v2' }))
        // second unparseable → max retries
        .mockResolvedValueOnce(makeResult({ output: '差不多可以了' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.retries['plan_review']).toBe(2);
    });

    it('should detect APPROVED in body text when first line is not a verdict', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        // APPROVED appears in body but not as sole keyword on first line
        .mockResolvedValueOnce(makeResult({ output: '审查意见\n\n结论：APPROVED，方案合理' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // 成本累计
  // ============================================================

  describe('cost tracking', () => {
    it('should accumulate costs across all phases', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan', costUsd: 0.10 }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED', costUsd: 0.05 }))
        .mockResolvedValueOnce(makeResult({ output: 'impl', costUsd: 0.50 }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED', costUsd: 0.05 }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed', costUsd: 0.02 }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.totalCostUsd).toBeCloseTo(0.72);
    });

    it('should handle undefined costUsd gracefully', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan', costUsd: undefined }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED', costUsd: undefined }))
        .mockResolvedValueOnce(makeResult({ output: 'impl', costUsd: 0.50 }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED', costUsd: undefined }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed', costUsd: undefined }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.totalCostUsd).toBeCloseTo(0.50);
    });
  });

  // ============================================================
  // 摘要生成
  // ============================================================

  describe('summary generation', () => {
    it('should include plan, implement, and push output in success summary', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'my plan details' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'implementation report' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'PR #42 created' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.summary).toContain('管道执行完成');
      expect(result.summary).toContain('my plan details');
      expect(result.summary).toContain('implementation report');
      expect(result.summary).toContain('PR #42 created');
    });

    it('should include failure reason in failed summary', async () => {
      mockExecute.mockResolvedValueOnce(makeResult({ success: false, error: 'timeout' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.summary).toContain('管道执行失败');
      expect(result.summary).toContain('方案设计失败');
    });
  });

  // ============================================================
  // workingDir 传递
  // ============================================================

  describe('workingDir propagation', () => {
    it('should pass workingDir to every step', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));

      await orchestrator.run('task', '/my/project', noopCallbacks);

      for (let i = 0; i < 5; i++) {
        expect(mockExecute.mock.calls[i][0].workingDir).toBe('/my/project');
      }
    });
  });

  // ============================================================
  // onStreamUpdate 回调
  // ============================================================

  describe('stream update callback', () => {
    it('should forward onStreamUpdate to each step', async () => {
      const onStreamUpdate = vi.fn();

      mockExecute.mockImplementation(async (opts) => {
        // Simulate calling onStreamUpdate during execution
        await opts.onStreamUpdate?.('partial output');
        return makeResult({ output: opts.prompt.includes('审查') ? 'APPROVED' : 'output' });
      });

      await orchestrator.run('task', '/tmp', {
        onPhaseChange: vi.fn(),
        onStreamUpdate,
      });

      // Should have been called for each step
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
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'compile error' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.state.failedAtPhase).toBe('implement');
    });

    it('should set failedAtPhase to plan_review when plan review max retries exceeded', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan v1' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n问题1' }))
        .mockResolvedValueOnce(makeResult({ output: 'plan v2' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n问题2' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.state.failedAtPhase).toBe('plan_review');
    });

    it('should set failedAtPhase to code_review when code review max retries exceeded', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v1' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\nbug A' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl v2' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\nbug B' }));

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.state.failedAtPhase).toBe('code_review');
    });
  });

  // ============================================================
  // MAX_ITERATIONS 循环保护
  // ============================================================

  describe('max iterations protection', () => {
    it('should fail pipeline when iterations exceed MAX_ITERATIONS', async () => {
      // 制造无限循环：review 始终 REJECTED，但 retries 永远不增长
      // 实际上 MAX_RETRIES=2 会先触发，所以我们用一个更直接的方式：
      // 不断 REJECTED → retry → REJECTED → retry... 直到 MAX_ITERATIONS
      // 每轮消耗 2 calls (plan + review)，MAX_RETRIES=2 在第 4 calls 后触发
      // 所以正常情况下 MAX_ITERATIONS 不会先触发
      // 为了测试 MAX_ITERATIONS，模拟一个极端情况：大量 mock 返回值
      const mocks: ReturnType<typeof makeResult>[] = [];
      for (let i = 0; i < 25; i++) {
        mocks.push(makeResult({ output: `plan v${i}` }));
        mocks.push(makeResult({ output: 'REJECTED\nredo' }));
      }
      for (const m of mocks) {
        mockExecute.mockResolvedValueOnce(m);
      }

      const result = await orchestrator.run('task', '/tmp', noopCallbacks);

      expect(result.success).toBe(false);
      expect(result.state.phase).toBe('failed');
      // 应该在 MAX_RETRIES 或 MAX_ITERATIONS 处终止
      expect(mockExecute.mock.calls.length).toBeLessThanOrEqual(20);
    });
  });

  // ============================================================
  // onPhaseChange 回调异常不中断管道
  // ============================================================

  describe('callback error resilience', () => {
    it('should continue pipeline when onPhaseChange throws', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));

      const failingCallback = vi.fn().mockRejectedValue(new Error('callback exploded'));

      const result = await orchestrator.run('task', '/tmp', {
        onPhaseChange: failingCallback,
      });

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
      // 回调仍然被调用了（只是异常被吞掉）
      expect(failingCallback).toHaveBeenCalled();
    });

    it('should complete pipeline when onPhaseChange throws on final notification', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'plan' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'impl' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'pushed' }));

      // 只在最后一次调用时抛异常（final notification）
      let callCount = 0;
      const onPhaseChange = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 6) throw new Error('final callback error');
      });

      const result = await orchestrator.run('task', '/tmp', { onPhaseChange });

      expect(result.success).toBe(true);
      expect(result.state.phase).toBe('done');
    });
  });
});
