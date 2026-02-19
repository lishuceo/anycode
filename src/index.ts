import { config, validateConfig } from './config.js';
import { logger } from './utils/logger.js';
import { startServer } from './server.js';
import { sessionManager } from './session/manager.js';
import { claudeExecutor } from './claude/executor.js';
import { cleanupTmpDirs, cleanupExpiredCaches } from './workspace/cache.js';
import { pipelineStore } from './pipeline/store.js';
import { recoverInterruptedPipelines } from './pipeline/runner.js';
import { killOrphanedClaudeProcesses } from './utils/process-cleanup.js';

function main(): void {
  logger.info('Starting Feishu Claude Code Bridge...');

  // 检查配置
  const errors = validateConfig();
  if (errors.length > 0) {
    for (const err of errors) {
      logger.error(err);
    }
    logger.error('Please check your .env configuration');
    process.exit(1);
  }

  logger.info({
    defaultWorkDir: config.claude.defaultWorkDir,
    timeoutSeconds: config.claude.timeoutSeconds,
  }, 'Configuration loaded');

  // 启动时清理残留的 .tmp-* 临时目录和孤儿 Claude 子进程
  cleanupTmpDirs();
  killOrphanedClaudeProcesses();

  // 启动 HTTP 服务
  startServer();

  // 恢复被中断的管道（服务重启后通知用户）
  recoverInterruptedPipelines().catch((err) => {
    logger.error({ err }, 'Failed to recover interrupted pipelines');
  });

  // 定时清理过期会话、Claude Code 进程、缓存和管道记录 (每 30 分钟)
  const cleanupInterval = setInterval(() => {
    sessionManager.cleanup();
    claudeExecutor.cleanup();
    cleanupExpiredCaches();
    pipelineStore.cleanExpired(30);
  }, 30 * 60 * 1000);

  // 优雅退出
  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down...');
    clearInterval(cleanupInterval);
    claudeExecutor.killAll();
    pipelineStore.markRunningAsInterrupted();

    // 延迟关闭 DB：killAll() 后 executeClaudeTask 的 catch/finally 仍需写 DB
    // 先等 query handler 完成清理，再关闭连接
    setTimeout(() => {
      pipelineStore.close();
      sessionManager.close();
      process.exit(0);
    }, 3000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
