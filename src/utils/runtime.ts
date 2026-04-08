import { existsSync } from 'node:fs';

export interface RuntimeInfo {
  manager: 'pm2' | 'systemd' | 'docker' | 'unknown';
  processName: string | null;
}

let cached: RuntimeInfo | null = null;

/**
 * 检测当前进程的运行时环境（PM2/systemd/Docker/unknown）
 * 优先级: pm2 > systemd > docker > unknown（处理嵌套场景如 Docker 内跑 PM2）
 */
export function detectRuntime(): RuntimeInfo {
  if (cached) return cached;

  if (process.env.pm_id !== undefined) {
    cached = { manager: 'pm2', processName: process.env.name ?? null };
  } else if (process.env.INVOCATION_ID !== undefined) {
    cached = { manager: 'systemd', processName: null };
  } else if (existsSync('/.dockerenv')) {
    cached = { manager: 'docker', processName: null };
  } else {
    cached = { manager: 'unknown', processName: null };
  }

  return cached;
}

/** Reset cache for testing */
export function _resetRuntimeCache(): void {
  cached = null;
}
