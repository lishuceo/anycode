import pino from 'pino';
import type { TransportTargetOptions } from 'pino';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config.js';

// Resolve log directory (relative paths resolve from cwd)
const logDir = resolve(config.server.logDir);

// Ensure log directory exists
mkdirSync(logDir, { recursive: true });

// Daily log filename: anycode-YYYY-MM-DD.log
const today = new Date().toISOString().slice(0, 10);
const logFile = join(logDir, `anycode-${today}.log`);

// Build multi-transport: always file + stdout
const targets: TransportTargetOptions[] = [
  // 1) Always write JSON to file (works regardless of startup method)
  {
    target: 'pino/file',
    options: { destination: logFile, mkdir: true, append: true },
    level: config.server.logLevel,
  },
];

if (config.server.nodeEnv === 'development') {
  // Dev: pretty-print to stdout
  targets.push({
    target: 'pino-pretty',
    options: { colorize: true, destination: 1 },
    level: config.server.logLevel,
  });
} else {
  // Prod: JSON to stdout (for PM2/container capture)
  targets.push({
    target: 'pino/file',
    options: { destination: 1 },
    level: config.server.logLevel,
  });
}

export const logger = pino({
  level: config.server.logLevel,
  transport: { targets },
});

/** Absolute path to the current log file */
export const LOG_FILE = logFile;

/** Absolute path to the log directory */
export const LOG_DIR = logDir;

/**
 * Remove log files older than maxDays.
 * Called once at startup — safe to run synchronously during init.
 */
export function cleanupOldLogs(maxDays: number = config.server.logMaxDays): number {
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  try {
    const files = readdirSync(logDir);
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const filePath = join(logDir, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
          removed++;
        }
      } catch {
        // Skip files that can't be stat'd or deleted
      }
    }
  } catch {
    // Log dir might not exist yet in tests
  }

  if (removed > 0) {
    logger.info({ removed, maxDays }, 'Cleaned up old log files');
  }

  return removed;
}
