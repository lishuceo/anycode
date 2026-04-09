import fs from 'node:fs';
import { config, validateConfig, setMultiBotMode } from './config.js';
import { logger, cleanupOldLogs, LOG_FILE } from './utils/logger.js';
import { startServer, closeServer } from './server.js';
import { sessionManager } from './session/manager.js';
import { claudeExecutor } from './claude/executor.js';
import { cleanupTmpDirs, cleanupExpiredCaches } from './workspace/cache.js';
import { pipelineStore } from './pipeline/store.js';
import { recoverInterruptedPipelines } from './pipeline/runner.js';
import { killOrphanedClaudeProcesses } from './utils/process-cleanup.js';
import { feishuClient, initDefaultClient, runWithAccountId } from './feishu/client.js';
import { cleanupExpiredApprovals } from './feishu/approval.js';
import { accountManager } from './feishu/multi-account.js';
import { validateBindings } from './agent/router.js';
import { loadAgentConfig, startConfigWatcher, stopConfigWatcher, reloadAgentConfig, deriveBotAccounts, deriveBindings, getExplicitBindings } from './agent/config-loader.js';
import { chatBotRegistry } from './feishu/bot-registry.js';
import { initializeMemory, closeMemory, runMemoryMaintenance } from './memory/init.js';
import { warmup as warmupQuickAck } from './utils/quick-ack.js';
import { initializeCron, closeCron, cleanCronRuns } from './cron/init.js';
import { scanAndSyncRegistry } from './workspace/registry.js';
import { initGitHubOrgCache } from './claude/executor.js';
import { executeClaudeTask, executeDirectTask } from './feishu/event-handler.js';
import { agentRegistry } from './agent/registry.js';
import type { AgentId } from './agent/types.js';

const INTERRUPTED_SESSIONS_FILE = '/tmp/anycode-interrupted.json';

async function main(): Promise<void> {
  logger.info('Starting Feishu Claude Code Bridge...');

  // 检查基础配置
  const errors = validateConfig();
  if (errors.length > 0) {
    for (const err of errors) {
      logger.error(err);
    }
    process.exit(1);
  }

  // 加载 agent 配置文件（含飞书凭证）
  const agentConfigResult = loadAgentConfig();
  if (!agentConfigResult.loaded) {
    logger.error({ error: agentConfigResult.error }, 'Failed to load agents.json — cannot start without agent config');
    logger.error('Run "npm run onboard" to create config/agents.json, or copy from config/agents.example.json');
    process.exit(1);
  }

  // 从 agent 配置推导 bot 账号
  const botAccounts = deriveBotAccounts();
  if (botAccounts.length === 0) {
    logger.error('No feishu credentials found in agents.json — each agent needs a "feishu" field with appId and appSecret');
    process.exit(1);
  }

  const multiBotMode = botAccounts.length > 1;
  setMultiBotMode(multiBotMode);

  // 合并 bindings：显式配置 > 自动推导
  const allBindings = [...getExplicitBindings(), ...deriveBindings()];

  logger.info({
    defaultWorkDir: config.claude.defaultWorkDir,
    timeoutSeconds: config.claude.timeoutSeconds,
    multiBotMode,
    botAccounts: botAccounts.map(a => a.accountId),
  }, 'Configuration loaded');

  // 启动配置文件监听（热重载）
  startConfigWatcher();

  // SIGHUP 手动触发配置重载
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received, reloading agent config...');
    reloadAgentConfig();
  });

  // 启动时清理残留的 .tmp-* 临时目录、孤儿 Claude 子进程和过期日志
  cleanupTmpDirs();
  killOrphanedClaudeProcesses();
  cleanupOldLogs();
  logger.info({ logFile: LOG_FILE }, 'Log file transport active');

  // 异步扫描仓库 registry（不阻塞启动）
  scanAndSyncRegistry().catch(err => {
    logger.warn({ err }, 'Registry scan failed at startup (non-blocking)');
  });

  // 初始化记忆系统（async: 加载 sqlite-vec，创建 DB）
  if (config.memory.enabled) {
    await initializeMemory();
  }

  // 初始化定时任务调度器
  if (config.cron.enabled) {
    await initializeCron({
      executeTask: async (params) => {
        // 用 runWithAccountId 包裹，确保下游 feishuClient 调用路由到正确的 bot 账号
        await runWithAccountId(params.accountId, async () => {
          const agentCfg = agentRegistry.get(params.agentId as AgentId);
          const useDirectMode = agentCfg?.replyMode === 'direct';

          if (useDirectMode) {
            await executeDirectTask(
              params.prompt,
              params.chatId,
              params.userId,
              params.messageId,
              undefined, // images
              undefined, // documents
              params.agentId as AgentId,
              params.threadId,
              params.rootId,
              undefined, // createTime
              { skipQuickAck: true },
            );
          } else {
            await executeClaudeTask(
              params.prompt,
              params.chatId,
              params.userId,
              params.messageId,
              params.rootId,
              params.threadId,
              undefined, // images
              undefined, // documents
              params.agentId as AgentId,
            );
          }
        });
      },
      sendMessage: async (chatId, text, rootId, accountId) => {
        // 用 runWithAccountId 包裹，确保占位消息由正确的 bot 发送
        return runWithAccountId(accountId ?? 'default', async () => {
          if (rootId) {
            return feishuClient.replyTextInThread(rootId, text);
          }
          return feishuClient.sendText(chatId, text);
        });
      },
    });
  }

  // 预取 GitHub 用户组织（用于仓库搜索，fire-and-forget）
  initGitHubOrgCache().catch(() => {});

  // 预热 quick-ack client（避免首次调用冷启动）
  warmupQuickAck();

  // 初始化默认 FeishuClient（所有模式都需要，作为 AsyncLocalStorage 无值时的 fallback）
  initDefaultClient(botAccounts[0].appId, botAccounts[0].appSecret);

  // 初始化 bot 账号（从 agents.json 的 feishu 字段推导）
  if (multiBotMode) {
    // 多 bot 模式：初始化所有账号
    await accountManager.initialize(botAccounts);

    // 校验 binding 配置
    const bindingWarnings = validateBindings(allBindings);
    for (const w of bindingWarnings) {
      logger.warn({ warning: w }, 'Agent binding configuration warning');
    }

    logger.info({
      accounts: botAccounts.map((a) => a.accountId),
      bindings: allBindings.length,
    }, 'Multi-bot mode initialized');
  } else {
    // 单 bot 模式
    const bot = botAccounts[0];
    accountManager.initializeSingleBot(bot.appId, bot.appSecret, bot.botName);

    // 获取机器人信息（用于精确 @mention 检测）
    await feishuClient.fetchBotInfo().catch((err) => {
      logger.warn({ err }, 'Failed to fetch bot info at startup');
    });
  }

  // 启动 HTTP 服务
  startServer(multiBotMode ? undefined : { appId: botAccounts[0].appId, appSecret: botAccounts[0].appSecret });

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
    // 注意：必须 < 进程管理器的 kill timeout（PM2 默认 10s），留出余量给后续清理步骤
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
