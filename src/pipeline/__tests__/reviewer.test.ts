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

import { parallelReview } from '../reviewer.js';
import { claudeExecutor } from '../../claude/executor.js';

const mockExecute = vi.mocked(claudeExecutor.execute);

function makeResult(overrides: Partial<ClaudeResult> = {}): ClaudeResult {
  return {
    success: true,
    output: 'APPROVED',
    durationMs: 100,
    costUsd: 0.01,
    ...overrides,
  };
}

describe('parallelReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockReset();
  });

  // ============================================================
  // 全部通过
  // ============================================================

  describe('all approved', () => {
    it('should return approved when all agents approve', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\n代码逻辑正确', costUsd: 0.10 }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\n无安全问题', costUsd: 0.08 }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\n架构合理', costUsd: 0.05 }));

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      expect(result.approved).toBe(true);
      expect(result.verdicts).toHaveLength(3);
      expect(result.verdicts.every(v => v.approved)).toBe(true);
      expect(result.verdicts.every(v => !v.abstained)).toBe(true);
      expect(result.consolidatedFeedback).toBe('');
    });

    it('should use plan review prompts when reviewType is plan', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      expect(mockExecute).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 3; i++) {
        const call = mockExecute.mock.calls[i][0];
        expect(call.systemPromptOverride).toContain('审查');
        expect(call.maxBudgetUsd).toBe(5);
        expect(call.maxTurns).toBe(30);
      }
    });

    it('should use code review prompts when reviewType is code', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      await parallelReview({
        reviewType: 'code',
        content: '请审查代码',
        workingDir: '/tmp',
      });

      expect(mockExecute).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 3; i++) {
        const call = mockExecute.mock.calls[i][0];
        expect(call.systemPromptOverride).toContain('代码审查');
      }
    });
  });

  // ============================================================
  // 部分拒绝
  // ============================================================

  describe('partial rejection', () => {
    it('should return rejected when any non-abstained agent rejects', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\n没问题', costUsd: 0.10 }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n存在SQL注入风险', costUsd: 0.08 }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\n架构OK', costUsd: 0.05 }));

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      expect(result.approved).toBe(false);
      expect(result.consolidatedFeedback).toContain('SQL注入');
      expect(result.consolidatedFeedback).toContain('security');
    });

    it('should include all rejected agent feedback in consolidatedFeedback', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n逻辑错误' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n安全漏洞' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const result = await parallelReview({
        reviewType: 'code',
        content: '请审查代码',
        workingDir: '/tmp',
      });

      expect(result.approved).toBe(false);
      expect(result.consolidatedFeedback).toContain('逻辑错误');
      expect(result.consolidatedFeedback).toContain('安全漏洞');
      expect(result.consolidatedFeedback).toContain('correctness');
      expect(result.consolidatedFeedback).toContain('security');
    });
  });

  // ============================================================
  // 单 agent 崩溃 (弃权)
  // ============================================================

  describe('single agent crash (abstained)', () => {
    it('should mark crashed agent as abstained and still approve if others approve', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\n没问题' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'timeout', costUsd: 0.02 }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\n架构OK' }));

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      expect(result.approved).toBe(true);
      const abstainedVerdicts = result.verdicts.filter(v => v.abstained);
      expect(abstainedVerdicts).toHaveLength(1);
      expect(abstainedVerdicts[0].role).toBe('security');
    });

    it('should mark agent as abstained when execute throws', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      expect(result.approved).toBe(true);
      const abstainedVerdicts = result.verdicts.filter(v => v.abstained);
      expect(abstainedVerdicts).toHaveLength(1);
      expect(abstainedVerdicts[0].feedback).toContain('network error');
    });
  });

  // ============================================================
  // 全部弃权 — fail-closed
  // ============================================================

  describe('all abstained (fail-closed)', () => {
    it('should return rejected when all agents are abstained', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ success: false, error: 'crash1' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'crash2' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'crash3' }));

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      expect(result.approved).toBe(false);
      expect(result.verdicts.every(v => v.abstained)).toBe(true);
    });
  });

  // ============================================================
  // onAgentComplete 回调
  // ============================================================

  describe('onAgentComplete callback', () => {
    it('should call onAgentComplete for each agent with correct parameters', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'REJECTED\n问题' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const onAgentComplete = vi.fn();

      await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
        onAgentComplete,
      });

      expect(onAgentComplete).toHaveBeenCalledTimes(3);

      // All calls should have total=3
      for (const call of onAgentComplete.mock.calls) {
        expect(call[1]).toBe(3); // total
      }

      // Verify roles are present (order may vary due to parallel execution)
      const roles = onAgentComplete.mock.calls.map((c: unknown[]) => c[2]);
      expect(roles).toContain('correctness');
      expect(roles).toContain('security');
      expect(roles).toContain('architecture');
    });

    it('should call onAgentComplete for abstained agents', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'crash' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const onAgentComplete = vi.fn();

      await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
        onAgentComplete,
      });

      expect(onAgentComplete).toHaveBeenCalledTimes(3);

      // Find the abstained call
      const abstainedCall = onAgentComplete.mock.calls.find((c: unknown[]) => c[4] === true);
      expect(abstainedCall).toBeDefined();
      expect(abstainedCall![2]).toBe('security');
      expect(abstainedCall![3]).toBe(false); // approved
      expect(abstainedCall![4]).toBe(true);  // abstained
    });
  });

  // ============================================================
  // 预算和轮数约束
  // ============================================================

  describe('budget and turns constraints', () => {
    it('should pass maxBudgetUsd: 5 and maxTurns: 30 to each agent', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      for (let i = 0; i < 3; i++) {
        const call = mockExecute.mock.calls[i][0];
        expect(call.maxBudgetUsd).toBe(5);
        expect(call.maxTurns).toBe(30);
      }
    });
  });

  // ============================================================
  // Cost 累计
  // ============================================================

  describe('cost tracking', () => {
    it('should track cost from all agents including abstained', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED', costUsd: 0.10 }))
        .mockResolvedValueOnce(makeResult({ success: false, error: 'crash', costUsd: 0.02 }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED', costUsd: 0.05 }));

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      const totalCost = result.verdicts.reduce((sum, v) => sum + v.costUsd, 0);
      expect(totalCost).toBeCloseTo(0.17);
    });
  });

  // ============================================================
  // Verdict 解析
  // ============================================================

  describe('verdict parsing', () => {
    it('should parse APPROVED on first line', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\nsome suggestions' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED\nimprovement ideas' }));

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      expect(result.approved).toBe(true);
    });

    it('should default to REJECTED when verdict is unparseable', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: '我觉得还行吧' }))  // unparseable
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      // unparseable defaults to REJECTED → overall rejected
      expect(result.approved).toBe(false);
    });

    it('should detect APPROVED in body text when first line is not a verdict', async () => {
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: '审查意见\n\n结论：APPROVED，方案合理' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
      });

      expect(result.approved).toBe(true);
    });
  });

  // ============================================================
  // customExecute 支持
  // ============================================================

  describe('customExecute agent', () => {
    it('should use customExecute when provided instead of claudeExecutor', async () => {
      const customExecute = vi.fn().mockResolvedValue({
        role: 'codex',
        approved: true,
        abstained: false,
        feedback: 'Looks great',
        costUsd: 0,
        durationMs: 500,
      });

      // 3 Claude agents + 1 custom agent
      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const { REVIEW_AGENT_CONFIGS } = await import('../prompts.js');

      const result = await parallelReview({
        reviewType: 'code',
        content: '请审查代码',
        workingDir: '/tmp',
        agentConfigs: [
          ...REVIEW_AGENT_CONFIGS,
          {
            role: 'codex',
            icon: '⚡',
            planReviewSystemPrompt: '',
            codeReviewSystemPrompt: 'review code',
            customExecute,
            codeReviewOnly: true,
          },
        ],
      });

      expect(result.approved).toBe(true);
      expect(result.verdicts).toHaveLength(4);
      expect(customExecute).toHaveBeenCalledWith('请审查代码', '/tmp');
      // claudeExecutor should only be called 3 times (not for the custom agent)
      expect(mockExecute).toHaveBeenCalledTimes(3);
    });

    it('should mark custom agent as abstained when customExecute throws', async () => {
      const customExecute = vi.fn().mockRejectedValue(new Error('CLI crashed'));

      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const { REVIEW_AGENT_CONFIGS } = await import('../prompts.js');

      const result = await parallelReview({
        reviewType: 'code',
        content: '请审查代码',
        workingDir: '/tmp',
        agentConfigs: [
          ...REVIEW_AGENT_CONFIGS,
          {
            role: 'codex',
            icon: '⚡',
            planReviewSystemPrompt: '',
            codeReviewSystemPrompt: '',
            customExecute,
          },
        ],
      });

      // 3 Claude agents approved + 1 custom abstained → overall approved
      expect(result.approved).toBe(true);
      const codexVerdict = result.verdicts.find(v => v.role === 'codex');
      expect(codexVerdict?.abstained).toBe(true);
      expect(codexVerdict?.feedback).toContain('CLI crashed');
    });

    it('should reject when custom agent rejects', async () => {
      const customExecute = vi.fn().mockResolvedValue({
        role: 'codex',
        approved: false,
        abstained: false,
        feedback: 'Security issue found',
        costUsd: 0,
        durationMs: 1000,
      });

      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const { REVIEW_AGENT_CONFIGS } = await import('../prompts.js');

      const result = await parallelReview({
        reviewType: 'code',
        content: '请审查代码',
        workingDir: '/tmp',
        agentConfigs: [
          ...REVIEW_AGENT_CONFIGS,
          {
            role: 'codex',
            icon: '⚡',
            planReviewSystemPrompt: '',
            codeReviewSystemPrompt: '',
            customExecute,
          },
        ],
      });

      expect(result.approved).toBe(false);
      expect(result.consolidatedFeedback).toContain('Security issue found');
    });

    it('should skip codeReviewOnly agents during plan review', async () => {
      const customExecute = vi.fn();

      mockExecute
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }))
        .mockResolvedValueOnce(makeResult({ output: 'APPROVED' }));

      const { REVIEW_AGENT_CONFIGS } = await import('../prompts.js');

      const result = await parallelReview({
        reviewType: 'plan',
        content: '请审查方案',
        workingDir: '/tmp',
        agentConfigs: [
          ...REVIEW_AGENT_CONFIGS,
          {
            role: 'codex',
            icon: '⚡',
            planReviewSystemPrompt: '',
            codeReviewSystemPrompt: '',
            customExecute,
            codeReviewOnly: true,
          },
        ],
      });

      expect(result.approved).toBe(true);
      // codex should be skipped entirely
      expect(result.verdicts).toHaveLength(3);
      expect(customExecute).not.toHaveBeenCalled();
      expect(result.verdicts.find(v => v.role === 'codex')).toBeUndefined();
    });
  });
});
