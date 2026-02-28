import { config, validateConfig, isMultiBotMode } from './config.js';
import { logger } from './utils/logger.js';
import { startServer } from './server.js';
import { sessionManager } from './session/manager.js';
import { claudeExecutor } from './claude/executor.js';
import { cleanupTmpDirs, cleanupExpiredCaches } from './workspace/cache.js';
import { pipelineStore } from './pipeline/store.js';
import { recoverInterruptedPipelines } from './pipeline/runner.js';
import { killOrphanedClaudeProcesses } from './utils/process-cleanup.js';
import { feishuClient } from './feishu/client.js';
import { cleanupExpiredApprovals } from './feishu/approval.js';
import { accountManager } from './feishu/multi-account.js';
import { validateBindings } from './agent/router.js';
import { loadAgentConfig, startConfigWatcher, stopConfigWatcher, reloadAgentConfig } from './agent/config-loader.js';
import { chatBotRegistry } from './feishu/bot-registry.js';

async function main(): Promise<void> {
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
    multiBotMode: isMultiBotMode(),
  }, 'Configuration loaded');

  // 加载 agent 配置文件（热重载支持）
  const agentConfigResult = loadAgentConfig();
  if (agentConfigResult.error && config.agent.configPath) {
    // 显式配置了 AGENT_CONFIG_PATH 但加载失败 → 致命错误
    logger.error({ error: agentConfigResult.error }, 'Failed to load AGENT_CONFIG_PATH');
    process.exit(1);
  }

  // 启动配置文件监听（热重载）
  startConfigWatcher();

  // SIGHUP 手动触发配置重载
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received, reloading agent config...');
    reloadAgentConfig();
  });

  // 启动时清理残留的 .tmp-* 临时目录和孤儿 Claude 子进程
  cleanupTmpDirs();
  killOrphanedClaudeProcesses();

  // 初始化 bot 账号
  if (isMultiBotMode()) {
    // 多 bot 模式：初始化所有账号
    await accountManager.initialize(config.agent.botAccounts);

    // 校验 binding 配置
    const bindingWarnings = validateBindings(config.agent.bindings);
    for (const w of bindingWarnings) {
      logger.warn({ warning: w }, 'Agent binding configuration warning');
    }

    logger.info({
      accounts: config.agent.botAccounts.map((a) => a.accountId),
      bindings: config.agent.bindings.length,
    }, 'Multi-bot mode initialized');
  } else {
    // 单 bot 模式：向后兼容
    accountManager.initializeSingleBot(config.feishu.appId, config.feishu.appSecret);

    // 获取机器人信息（用于精确 @mention 检测）
    await feishuClient.fetchBotInfo().catch((err) => {
      logger.warn({ err }, 'Failed to fetch bot info at startup');
    });
  }

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
    cleanupExpiredApprovals();
    chatBotRegistry.cleanup();
  }, 30 * 60 * 1000);

  // 优雅退出
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down...');
    stopConfigWatcher();
    clearInterval(cleanupInterval);
    claudeExecutor.killAll();
    pipelineStore.markRunningAsInterrupted();

    // 等待正在运行的 task 完成（发送结果卡片到飞书），最多等 15 秒
    // killAll() 关闭 stream → execute() 返回 → executeClaudeTask 发结果卡片 → task 完成
    await claudeExecutor.waitForRunningTasks(15000);

    pipelineStore.close();
    sessionManager.close();
    process.exit(0);
  }

  process.on('SIGINT', () => { shutdown('SIGINT').catch(err => { logger.error({ err }, 'Shutdown error'); process.exit(1); }); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(err => { logger.error({ err }, 'Shutdown error'); process.exit(1); }); });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
