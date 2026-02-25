import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mock before vi.mock hoisting
const mockExecFile = vi.hoisted(() => vi.fn());

// Mock config before importing module under test
vi.mock('../../config.js', () => ({
  config: {
    codex: {
      enabled: true,
      command: 'codex',
      timeoutSeconds: 120,
    },
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

// Mock transitive dependency from reviewer.ts → claude/executor.ts
vi.mock('../../claude/executor.js', () => ({
  claudeExecutor: { execute: vi.fn() },
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import { isCodexEnabled, executeCodexReview } from '../codex-reviewer.js';
import { config } from '../../config.js';

// execFile is promisified, so the mock needs to call the callback
function setupExecFile(stdout: string, stderr = '') {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout, stderr });
    },
  );
}

function setupExecFileError(error: Error) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      cb(error);
    },
  );
}

describe('codex-reviewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // isCodexEnabled
  // ============================================================

  describe('isCodexEnabled', () => {
    it('should return true when config.codex.enabled is true', () => {
      expect(isCodexEnabled()).toBe(true);
    });

    it('should return false when config.codex.enabled is false', () => {
      (config.codex as { enabled: boolean }).enabled = false;
      expect(isCodexEnabled()).toBe(false);
      (config.codex as { enabled: boolean }).enabled = true; // restore
    });
  });

  // ============================================================
  // executeCodexReview — 成功路径
  // ============================================================

  describe('executeCodexReview — success', () => {
    it('should return approved verdict when codex outputs APPROVED', async () => {
      setupExecFile('APPROVED\nCode looks good, no issues found.');

      const verdict = await executeCodexReview('review this code', '/tmp/work');

      expect(verdict.role).toBe('codex');
      expect(verdict.approved).toBe(true);
      expect(verdict.abstained).toBe(false);
      expect(verdict.feedback).toContain('Code looks good');
      expect(verdict.costUsd).toBe(0);
    });

    it('should return rejected verdict when codex outputs REJECTED', async () => {
      setupExecFile('REJECTED\n- [high] src/main.ts:10 — SQL injection vulnerability');

      const verdict = await executeCodexReview('review this code', '/tmp/work');

      expect(verdict.role).toBe('codex');
      expect(verdict.approved).toBe(false);
      expect(verdict.abstained).toBe(false);
      expect(verdict.feedback).toContain('SQL injection');
    });

    it('should pass correct arguments to codex exec', async () => {
      setupExecFile('APPROVED');

      await executeCodexReview('review prompt', '/my/workspace');

      // 2 calls: first git diff, then codex exec
      expect(mockExecFile).toHaveBeenCalledTimes(2);

      // First call: git diff
      const [gitCmd, gitArgs] = mockExecFile.mock.calls[0];
      expect(gitCmd).toBe('git');
      expect(gitArgs).toEqual(['diff', 'HEAD', '--no-color']);

      // Second call: codex exec
      const [cmd, args] = mockExecFile.mock.calls[1];
      expect(cmd).toBe('codex');
      expect(args).toContain('exec');
      expect(args).toContain('--full-auto');
      expect(args).toContain('--sandbox');
      expect(args).toContain('read-only');
      expect(args).toContain('--cd');
      expect(args).toContain('/my/workspace');
    });
  });

  // ============================================================
  // executeCodexReview — 失败路径
  // ============================================================

  describe('executeCodexReview — failure', () => {
    it('should return abstained verdict when codex CLI fails', async () => {
      setupExecFileError(new Error('command not found: codex'));

      const verdict = await executeCodexReview('review this', '/tmp/work');

      expect(verdict.role).toBe('codex');
      expect(verdict.approved).toBe(false);
      expect(verdict.abstained).toBe(true);
      expect(verdict.feedback).toContain('command not found');
    });

    it('should return abstained verdict on timeout', async () => {
      const timeoutError = new Error('Process timed out') as NodeJS.ErrnoException;
      (timeoutError as NodeJS.ErrnoException & { killed: boolean }).killed = true;
      setupExecFileError(timeoutError);

      const verdict = await executeCodexReview('review this', '/tmp/work');

      expect(verdict.role).toBe('codex');
      expect(verdict.approved).toBe(false);
      expect(verdict.abstained).toBe(true);
      expect(verdict.feedback).toContain('超时');
    });
  });
});
