import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { GIT_REMOTE_SECURITY_ARGS } from './git-security.js';

// ============================================================
// 仓库缓存管理
//
// 维护本地 bare clone 镜像，作为 local clone 的快速源。
// - URL 解析与路径穿越校验
// - bare clone 创建与 fetch 更新
// - 原子目录创建 (tmp + rename)
// - 过期 / LRU 清理
// ============================================================

/** 最近 fetch 时间记录 (cachePath → timestamp) */
const lastFetchTime = new Map<string, number>();

// ============================================================
// URL 解析
// ============================================================

/**
 * 将仓库 URL 解析为缓存路径（相对于 REPO_CACHE_DIR）
 *
 * 支持格式:
 *   https://github.com/foo/bar.git
 *   git@github.com:foo/bar.git
 *   ssh://git@github.com/foo/bar.git
 *
 * 返回: github.com/foo/bar.git (小写, 规范化)
 */
export function repoUrlToCachePath(repoUrl: string): string {
  let host: string;
  let pathname: string;

  // git@host:path 格式 (SSH shorthand)
  const sshMatch = repoUrl.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    host = sshMatch[1];
    pathname = sshMatch[2];
  } else {
    // HTTP(S), SSH, Git 协议 — 使用 URL 类解析
    try {
      const url = new URL(repoUrl);
      // 剥离认证信息，保留 host[:port]
      host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
      pathname = url.pathname;
    } catch {
      throw new Error(`无法解析仓库 URL: ${repoUrl}`);
    }
  }

  // 规范化路径: 去除前导 /, 去除 .git 后缀, 再统一追加 .git
  pathname = pathname.replace(/^\/+/, '').replace(/\.git\/?$/, '');

  if (!host || !pathname) {
    throw new Error(`无法解析仓库 URL: ${repoUrl}`);
  }

  // 路径段校验: 禁止 .., 空段, 以 . 开头
  const segments = `${host}/${pathname}`.split('/');
  for (const seg of segments) {
    if (!seg || seg === '..' || seg.startsWith('.')) {
      throw new Error(`仓库 URL 包含非法路径段: "${seg}"`);
    }
  }

  // 统一小写 + 追加 .git
  const relativePath = `${host}/${pathname}.git`.toLowerCase();

  // 路径穿越防护: resolve 后校验是否仍在 cacheDir 下
  const cacheDir = config.repoCache.dir;
  const fullPath = resolve(cacheDir, relativePath);
  if (!fullPath.startsWith(resolve(cacheDir) + '/')) {
    throw new Error(`缓存路径穿越防护: ${relativePath}`);
  }

  return relativePath;
}

/**
 * 从仓库 URL 剥离认证信息，返回安全的 URL
 * 用于 git remote set-url origin
 */
export function sanitizeRepoUrl(repoUrl: string): string {
  // SSH shorthand 不含认证信息
  if (/^git@/.test(repoUrl)) return repoUrl;

  try {
    const url = new URL(repoUrl);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return repoUrl;
  }
}

// ============================================================
// 缓存操作
// ============================================================


/**
 * 确保仓库的 bare clone 缓存存在且是最新的
 * 返回缓存的绝对路径
 */
export function ensureBareCache(repoUrl: string): string {
  const relativePath = repoUrlToCachePath(repoUrl);
  const cachePath = resolve(config.repoCache.dir, relativePath);

  if (existsSync(cachePath)) {
    // 缓存已存在，检查是否需要 fetch
    fetchIfStale(cachePath);
  } else {
    // 首次访问，创建 bare clone (原子操作)
    cloneBareAtomic(repoUrl, cachePath);
  }

  return cachePath;
}

/**
 * bare clone 到临时目录，成功后 rename (原子创建)
 */
function cloneBareAtomic(repoUrl: string, cachePath: string): void {
  const tmpPath = `${cachePath}.tmp-${randomBytes(4).toString('hex')}`;
  const parentDir = resolve(cachePath, '..');

  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  logger.info({ repoUrl, cachePath }, 'Creating bare clone cache');

  try {
    execFileSync('git', [
      'clone', '--bare',
      ...GIT_REMOTE_SECURITY_ARGS,
      repoUrl, tmpPath,
    ], {
      timeout: 300_000, // 5 min for large repos
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    renameSync(tmpPath, cachePath);
    logger.info({ cachePath }, 'Bare clone cache created');
  } catch (err) {
    // 清理残留的临时目录
    cleanupTmpDir(tmpPath);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`bare clone 失败: ${msg}`);
  }
}

/**
 * 如果上次 fetch 超过 fetchIntervalMin 分钟，执行 git fetch --all
 */
function fetchIfStale(cachePath: string): void {
  const now = Date.now();
  const lastFetch = lastFetchTime.get(cachePath) ?? 0;
  const intervalMs = config.repoCache.fetchIntervalMin * 60 * 1000;

  if (now - lastFetch < intervalMs) {
    logger.debug({ cachePath }, 'Skipping fetch, recently updated');
    return;
  }

  logger.info({ cachePath }, 'Fetching updates for bare cache');

  try {
    execFileSync('git', [
      '-C', cachePath,
      '-c', 'core.hooksPath=/dev/null',
      'fetch', '--all',
      '--no-recurse-submodules',
      '-c', 'protocol.file.allow=never',
    ], {
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    lastFetchTime.set(cachePath, now);
  } catch (err) {
    // fetch 失败不阻断流程，使用过期缓存
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ cachePath, err: msg }, 'Failed to fetch cache, using stale version');
  }
}

// ============================================================
// 缓存清理
// ============================================================

/**
 * 清理残留的 .tmp-* 临时目录
 * 在服务启动时调用
 */
export function cleanupTmpDirs(): number {
  let cleaned = 0;
  const dirs = [config.repoCache.dir, config.workspace.baseDir];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    cleaned += cleanupTmpDirsRecursive(dir);
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up temporary directories');
  }
  return cleaned;
}

function cleanupTmpDirsRecursive(dir: string): number {
  let cleaned = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = join(dir, entry.name);
        if (entry.name.includes('.tmp-')) {
          cleanupTmpDir(fullPath);
          cleaned++;
        } else {
          cleaned += cleanupTmpDirsRecursive(fullPath);
        }
      }
    }
  } catch {
    // 忽略读取失败
  }
  return cleaned;
}

function cleanupTmpDir(tmpPath: string): void {
  try {
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { recursive: true, force: true });
      logger.debug({ tmpPath }, 'Cleaned up temp directory');
    }
  } catch {
    // best effort
  }
}

/**
 * 清理过期缓存 (超过 maxAgeDays 未访问)
 * 在定时 cleanup interval 中调用
 *
 * 缓存目录结构为 host/owner/repo.git（3 级），
 * 递归查找 .git 结尾的目录作为缓存单元进行过期检查。
 */
export function cleanupExpiredCaches(): number {
  const cacheDir = config.repoCache.dir;
  if (!existsSync(cacheDir)) return 0;

  const maxAgeMs = config.repoCache.maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const cleaned = cleanupExpiredRecursive(cacheDir, now, maxAgeMs);

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up expired cache directories');
  }
  return cleaned;
}

function cleanupExpiredRecursive(dir: string, now: number, maxAgeMs: number): number {
  let cleaned = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(dir, entry.name);

      if (entry.name.endsWith('.git')) {
        // 这是一个 bare clone 缓存目录，检查是否过期
        try {
          const stat = statSync(fullPath);
          const age = now - stat.mtimeMs;
          if (age > maxAgeMs) {
            rmSync(fullPath, { recursive: true, force: true });
            lastFetchTime.delete(fullPath);
            cleaned++;
            logger.debug({ path: fullPath, ageDays: Math.floor(age / 86400000) }, 'Removed expired cache');
          }
        } catch {
          // ignore stat errors
        }
      } else {
        // 中间目录 (host, owner)，递归查找
        cleaned += cleanupExpiredRecursive(fullPath, now, maxAgeMs);

        // 如果中间目录变空则删除
        try {
          const remaining = readdirSync(fullPath);
          if (remaining.length === 0) {
            rmSync(fullPath, { recursive: true, force: true });
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return cleaned;
}
