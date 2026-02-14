import { config } from '../config';
import { logger } from './logger';

/**
 * 检查用户是否在白名单中
 */
export function isUserAllowed(userId: string): boolean {
  const { allowedUserIds } = config.security;
  // 白名单为空则允许所有用户
  if (allowedUserIds.length === 0) return true;
  return allowedUserIds.includes(userId);
}

/** 危险命令模式 */
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/(?!\S)/,  // rm -rf /
  /mkfs\./,               // 格式化磁盘
  /dd\s+if=/,             // dd 写盘
  />\s*\/dev\/sd/,         // 写入磁盘设备
  /shutdown/,
  /reboot/,
  /init\s+0/,
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
