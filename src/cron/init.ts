import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { CronStore } from './store.js';
import { CronScheduler } from './scheduler.js';
import type { CronTaskExecutor, CronMessageSender } from './scheduler.js';

let cronStore: CronStore | null = null;
let cronScheduler: CronScheduler | null = null;

export function getCronScheduler(): CronScheduler | null {
  return cronScheduler;
}

export async function initializeCron(deps: {
  executeTask: CronTaskExecutor;
  sendMessage: CronMessageSender;
}): Promise<void> {
  if (!config.cron.enabled) {
    logger.info('Cron scheduler disabled (CRON_ENABLED != true)');
    return;
  }

  cronStore = new CronStore(config.cron.dbPath);
  cronScheduler = new CronScheduler({
    store: cronStore,
    executeTask: deps.executeTask,
    sendMessage: deps.sendMessage,
  });

  await cronScheduler.start();
  logger.info('Cron scheduler initialized and started');
}

export function cleanCronRuns(): void {
  if (!cronStore) return;
  const deleted = cronStore.cleanOldRuns(30);
  if (deleted > 0) {
    logger.info({ deleted }, 'cron: cleaned old run records');
  }
}

export function closeCron(): void {
  if (cronScheduler) {
    cronScheduler.stop();
    cronScheduler = null;
  }
  if (cronStore) {
    cronStore.close();
    cronStore = null;
  }
}
