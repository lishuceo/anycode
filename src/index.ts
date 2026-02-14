import { config, validateConfig } from './config';
import { logger } from './utils/logger';
import { startServer } from './server';
import { sessionManager } from './session/manager';
import { claudeExecutor } from './claude/executor';

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
    claudeMode: config.claude.mode,
    defaultWorkDir: config.claude.defaultWorkDir,
    timeoutSeconds: config.claude.timeoutSeconds,
  }, 'Configuration loaded');

  // 启动 HTTP 服务
  startServer();

  // 定时清理过期会话 (每 30 分钟)
  setInterval(() => {
    sessionManager.cleanup();
  }, 30 * 60 * 1000);

  // 优雅退出
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    claudeExecutor.killAll();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    claudeExecutor.killAll();
    process.exit(0);
  });
}

main();
