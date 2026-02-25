import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { parseVerdict } from './reviewer.js';
import { REVIEW_AGENT_CONFIGS, CODEX_CODE_REVIEW_PROMPT } from './prompts.js';
import type { ReviewAgentConfig, ReviewVerdict } from './types.js';

// ============================================================
// Codex CLI Review Agent — 通过 codex exec 子进程执行代码审查
// ============================================================

const execFileAsync = promisify(execFile);

/**
 * 检查 Codex review 是否启用
 */
export function isCodexEnabled(): boolean {
  return config.codex.enabled;
}

/**
 * 预先获取 git diff 输出，内嵌到 prompt 中
 *
 * Codex 的 read-only sandbox (Landlock) 会限制外部命令执行，
 * 所以我们自己跑 git diff，把结果喂给 codex。
 */
async function getGitDiff(workingDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['diff', '--no-color'],
      { cwd: workingDir, timeout: 10_000, maxBuffer: 512 * 1024 },
    );
    return stdout.trim() || '(no uncommitted changes)';
  } catch {
    return '(failed to get git diff)';
  }
}

/**
 * 通过 Codex CLI 执行代码审查
 *
 * 调用 `codex exec` 非交互模式，解析输出中的 APPROVED/REJECTED 判定。
 * 预先获取 git diff 内嵌到 prompt，避免 sandbox 限制。
 * CLI 失败或超时时返回 abstained verdict。
 */
export async function executeCodexReview(
  content: string,
  workingDir: string,
): Promise<ReviewVerdict> {
  const startTime = Date.now();
  const timeoutMs = config.codex.timeoutSeconds * 1000;

  try {
    // 预获取 git diff，内嵌到 prompt
    const diff = await getGitDiff(workingDir);
    const prompt = `${content}\n\n## Git Diff\n\`\`\`diff\n${diff}\n\`\`\``;

    const { stdout } = await execFileAsync(
      config.codex.command,
      [
        'exec',
        '--full-auto',
        '--sandbox', 'read-only',
        '--cd', workingDir,
        prompt,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1MB
        env: process.env,
      },
    );

    const durationMs = Date.now() - startTime;
    const parsed = parseVerdict(stdout);

    logger.info(
      { role: 'codex', approved: parsed.approved, durationMs },
      'Codex review completed',
    );

    return {
      role: 'codex',
      approved: parsed.approved,
      abstained: false,
      feedback: parsed.feedback,
      costUsd: 0, // Codex CLI 不报告 cost，外部计费
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const isTimeout = err instanceof Error && 'killed' in err && (err as unknown as { killed: boolean }).killed;
    const reason = isTimeout
      ? `Codex CLI 超时 (${config.codex.timeoutSeconds}s)`
      : `Codex CLI 执行失败: ${err instanceof Error ? err.message : String(err)}`;

    logger.warn({ err, role: 'codex', durationMs }, reason);

    return {
      role: 'codex',
      approved: false,
      abstained: true,
      feedback: reason,
      costUsd: 0,
      durationMs,
    };
  }
}

// ============================================================
// Codex Review Agent 配置 + 动态 agent 列表
// ============================================================

const CODEX_REVIEW_AGENT_CONFIG: ReviewAgentConfig = {
  role: 'codex',
  icon: '⚡',
  // Codex 仅参与 code review，plan review prompt 不会被使用
  planReviewSystemPrompt: '',
  codeReviewSystemPrompt: CODEX_CODE_REVIEW_PROMPT,
  codeReviewOnly: true,
  customExecute: executeCodexReview,
};

/**
 * 获取 code review 阶段的 agent 配置列表
 *
 * 返回基础 3 个 Claude agent + 可选的 Codex agent（由 CODEX_ENABLED 控制）
 */
export function getCodeReviewAgentConfigs(): ReviewAgentConfig[] {
  if (isCodexEnabled()) {
    return [...REVIEW_AGENT_CONFIGS, CODEX_REVIEW_AGENT_CONFIG];
  }
  return REVIEW_AGENT_CONFIGS;
}
