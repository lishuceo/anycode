import { execSync } from 'node:child_process';
import { logger } from './logger.js';

/**
 * 启动时清理上一次残留的 Claude Code 子进程。
 * PM2 SIGKILL 或服务崩溃后，Agent SDK spawn 的子进程可能成为孤儿进程。
 */
export function killOrphanedClaudeProcesses(): number {
  const myPid = process.pid;
  let killed = 0;

  try {
    // pgrep -fa claude: 列出命令行包含 "claude" 的进程 (PID + cmdline)
    const output = execSync('pgrep -fa claude 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (!output) return 0;

    for (const line of output.split('\n')) {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const cmdline = match[2];

      // 跳过自身
      if (pid === myPid) continue;

      // 只匹配 Claude Code CLI 进程（命令第一段以 claude 结尾）
      // 例如: /usr/local/bin/claude --flags... 或 claude --flags...
      const cmd = cmdline.split(/\s/)[0];
      const basename = cmd.split('/').pop();
      if (basename !== 'claude') continue;

      try {
        process.kill(pid, 'SIGTERM');
        killed++;
        logger.info({ pid, cmdline: cmdline.slice(0, 120) }, 'Killed orphaned Claude process');
      } catch {
        // 进程已退出
      }
    }
  } catch {
    // pgrep 不可用或其他错误 — 非关键，跳过
  }

  if (killed > 0) {
    logger.info({ killed }, 'Cleaned up orphaned Claude processes on startup');
  }
  return killed;
}
