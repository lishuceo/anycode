import { forkSession as forkClaudeCodeSession } from '@anthropic-ai/claude-agent-sdk';

export interface ForkClaudeSessionOptions {
  parentSessionId: string;
  sourceCwd: string;
  title?: string;
}

/**
 * 用官方 Claude Code session fork 语义生成新的 transcript。
 * 调用方仍负责把生成的 JSONL 移到目标 worktree 对应的 project 目录。
 */
export async function forkClaudeSession(opts: ForkClaudeSessionOptions): Promise<string> {
  const result = await forkClaudeCodeSession(opts.parentSessionId, {
    dir: opts.sourceCwd,
    title: opts.title,
  });
  return result.sessionId;
}
