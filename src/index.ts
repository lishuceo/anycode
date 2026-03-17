import fs from 'node:fs';
import { config, validateConfig, isMultiBotMode } from './config.js';
import { logger } from './utils/logger.js';
import { startServer, closeServer } from './server.js';
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
import { initializeMemory, closeMemory, runMemoryMaintenance } from './memory/init.js';
import { warmup as warmupQuickAck } from './utils/quick-ack.js';
import { initializeCron, closeCron, cleanCronRuns } from './cron/init.js';
import { executeClaudeTask } from './feishu/event-handler.js';

const INTERRUPTED_SESSIONS_FILE = '/tmp/feishu-claude-interrupted.json';

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

  // 初始化记忆系统（async: 加载 sqlite-vec，创建 DB）
  if (config.memory.enabled) {
    await initializeMemory();
  }

  // 初始化定时任务调度器
  if (config.cron.enabled) {
    await initializeCron({
      executeTask: async (params) => {
        await executeClaudeTask(
          params.prompt,
          params.chatId,
          params.userId,
          params.messageId,
          params.rootId,
          params.threadId,
          undefined, // images
          params.agentId as import('./agent/types.js').AgentId,
        );
      },
      sendMessage: async (chatId, text, rootId) => {
        if (rootId) {
          return feishuClient.replyTextInThread(rootId, text);
        }
        return feishuClient.sendText(chatId, text);
      },
    });
  }

  // 预热 quick-ack client（避免首次调用冷启动）
  warmupQuickAck();

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

  // 通知被重启中断的会话
  try {
    if (fs.existsSync(INTERRUPTED_SESSIONS_FILE)) {
      const raw = fs.readFileSync(INTERRUPTED_SESSIONS_FILE, 'utf-8');
      fs.unlinkSync(INTERRUPTED_SESSIONS_FILE);
      const data = JSON.parse(raw) as { sessions?: Array<{ chatId: string }>; timestamp?: number };

      if (data.sessions?.length) {
        const uniqueChatIds = [...new Set(data.sessions.map((s) => s.chatId))];
        logger.info({ chatIds: uniqueChatIds, interruptedAt: data.timestamp }, 'Notifying interrupted sessions after restart');
        for (const chatId of uniqueChatIds) {
          feishuClient.sendText(chatId, '服务已重启完成，之前正在执行的任务被中断。如需继续，请重新发送消息。').catch((err) => {
            logger.warn({ err, chatId }, 'Failed to notify interrupted session');
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to process interrupted sessions file');
  }

  // 定时清理过期会话、Claude Code 进程、缓存和管道记录 (每 30 分钟)
  const cleanupInterval = setInterval(() => {
    sessionManager.cleanup();
    claudeExecutor.cleanup();
    cleanupExpiredCaches();
    pipelineStore.cleanExpired(30);
    cleanupExpiredApprovals();
    chatBotRegistry.cleanup();
    if (config.memory.enabled) {
      runMemoryMaintenance();
    }
    if (config.cron.enabled) {
      cleanCronRuns();
    }
  }, 30 * 60 * 1000);

  // 优雅退出
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down...');
    stopConfigWatcher();
    clearInterval(cleanupInterval);

    // 先关闭 HTTP 服务器，立即释放端口，避免新进程 EADDRINUSE
    await closeServer();

    // 保存被中断的会话信息，重启后发通知
    const runningKeys = claudeExecutor.getRunningQueryKeys();
    if (runningKeys.length > 0) {
      const sessions = runningKeys.map((key) => {
        const parts = key.split(':');
        // 新格式 "agent:{agentId}:{chatId}:{userId}" 或旧格式 "chatId:userId"
        const chatId = parts.length >= 4 ? parts[2] : parts[0];
        return { chatId, sessionKey: key };
      }).filter((s) => s.chatId);

      try {
        fs.writeFileSync(INTERRUPTED_SESSIONS_FILE, JSON.stringify({ sessions, timestamp: Date.now() }));
        logger.info({ count: sessions.length }, 'Saved interrupted sessions for post-restart notification');
      } catch (err) {
        logger.error({ err }, 'Failed to save interrupted sessions');
      }
    }

    claudeExecutor.killAll();
    pipelineStore.markRunningAsInterrupted();

    // 等待正在运行的 task 完成（发送结果卡片到飞书），最多等 8 秒
    // killAll() 关闭 stream → execute() 返回 → executeClaudeTask 发结果卡片 → task 完成
    // 注意：必须 < pm2 kill_timeout (10s)，留出余量给后续清理步骤
    await claudeExecutor.waitForRunningTasks(8000);

    pipelineStore.close();
    sessionManager.close();
    closeMemory();
    closeCron();
    process.exit(0);
  }

  process.on('SIGINT', () => { shutdown('SIGINT').catch(err => { logger.error({ err }, 'Shutdown error'); process.exit(1); }); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(err => { logger.error({ err }, 'Shutdown error'); process.exit(1); }); });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
