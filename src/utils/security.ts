import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * 检查用户是否在白名单中
 */
export function isUserAllowed(userId: string): boolean {
  const { allowedUserIds } = config.security;
  // 白名单为空则允许所有用户
  if (allowedUserIds.length === 0) return true;
  return allowedUserIds.includes(userId);
}

/**
 * 检查用户是否为管理员（拥有完整代码编辑权限）
 * 未配置 OWNER_USER_ID 时所有人都是 owner（向后兼容）
 */
export function isOwner(userId: string): boolean {
  const { ownerUserId } = config.security;
  if (!ownerUserId) return true;
  return userId === ownerUserId;
}

/** 防止并发调用 autoDetectOwner 的重入 guard */
let settingOwner = false;

/**
 * 自动设置首个用户为 owner（OWNER_USER_ID 未配置时）。
 * 将 owner 写入内存 config 并回写 .env 持久化。
 * @returns true 如果本次调用设置了 owner（首次），false 如果已有 owner
 */
export function autoDetectOwner(userId: string): boolean {
  if (config.security.ownerUserId) return false;
  if (settingOwner) return false;

  // 校验 userId 格式（飞书 open_id: ou_ 前缀 + 字母数字下划线）
  if (!/^[a-zA-Z0-9_]+$/.test(userId)) {
    logger.warn({ userId }, 'autoDetectOwner: invalid userId format, skipping');
    return false;
  }

  settingOwner = true;

  // 设置内存中的 owner
  config.security.ownerUserId = userId;
  logger.info({ userId }, 'Auto-detected owner from first message');

  // 回写 .env 持久化
  try {
    const envPath = resolve(process.cwd(), '.env');
    const content = readFileSync(envPath, 'utf-8');

    // 替换已有的 OWNER_USER_ID 行（含注释状态），或追加
    const ownerLine = `OWNER_USER_ID=${userId}`;
    let updated: string;
    if (/^#?\s*OWNER_USER_ID=/m.test(content)) {
      updated = content.replace(/^#?\s*OWNER_USER_ID=.*/m, ownerLine);
    } else {
      updated = content.trimEnd() + '\n' + ownerLine + '\n';
    }

    writeFileSync(envPath, updated, 'utf-8');
    logger.info({ userId, envPath }, 'OWNER_USER_ID written to .env');
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to write OWNER_USER_ID to .env (in-memory value still active)');
  }

  return true;
}

/** 危险命令模式 */
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/(?!\S)/,           // rm -rf /
  /mkfs\./,                         // 格式化磁盘
  /dd\s+if=/,                       // dd 写盘
  />\s*\/dev\/sd/,                   // 写入磁盘设备
  /\bshutdown(\s+([+-]\w|now\b)|\s*$)/m, // shutdown (bare), shutdown -h now, shutdown +5, shutdown now
  /\breboot\b(\s+(-\w|now\b)|\s*$)/m,     // reboot (bare), reboot -f, reboot now
  /\binit\s+0/,                     // init 0
];

/**
 * 检查用户输入是否包含危险命令
 */
export function containsDangerousCommand(input: string): boolean {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(input)) {
      logger.warn({ input, pattern: pattern.source }, 'Dangerous command detected');
      return true;
    }
  }
  return false;
}
