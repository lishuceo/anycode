import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { repoUrlToCachePath } from './cache.js';
import { GIT_URL_RE } from './manager.js';

// ============================================================
// 仓库身份标识
//
// 从工作区路径推导出规范化的仓库标识 (repo identity)，
// 使同一仓库的不同 clone 共享同一个 identity，
// 用于记忆系统的 workspaceDir 隔离。
// ============================================================

/** identity 缓存: workDir → identity */
const identityCache = new Map<string, string>();

/**
 * 从工作区路径推导仓库的规范化标识。
 *
 * 推导逻辑:
 *   1. 读取 git remote.origin.url
 *   2. 如果 URL 在 REPO_CACHE_DIR 下（bare cache 路径）→ 剥离前缀
 *   3. 如果 URL 是远程格式 → repoUrlToCachePath() 归一化
 *   4. 如果 URL 是本地路径 → 递归追溯该路径的 remote，直到找到远程 URL（最多 3 层）
 *   5. 非 git 目录或无 remote → 返回当前路径的 resolve() 结果
 *
 * 结果带 Map 缓存，同一 workDir 只解析一次。
 */
export function getRepoIdentity(workDir: string): string {
  const cached = identityCache.get(workDir);
  if (cached !== undefined) return cached;

  const identity = resolveIdentity(workDir);
  identityCache.set(workDir, identity);
  return identity;
}

/** Max depth to follow local-path remotes to find the upstream URL */
const MAX_FOLLOW_DEPTH = 3;

function resolveIdentity(workDir: string): string {
  const visited = new Set<string>([resolve(workDir)]);
  let currentDir = workDir;

  for (let depth = 0; depth < MAX_FOLLOW_DEPTH; depth++) {
    let remoteUrl: string;
    try {
      remoteUrl = execFileSync('git', ['-C', currentDir, 'config', '--get', 'remote.origin.url'], {
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString().trim();
    } catch {
      // Not a git repo or no remote configured
      return resolve(currentDir);
    }

    if (!remoteUrl) return resolve(currentDir);

    // Case 1: bare cache path (under REPO_CACHE_DIR)
    const cacheDir = resolve(config.repoCache.dir);
    if (remoteUrl.startsWith(cacheDir + '/')) {
      return remoteUrl.slice(cacheDir.length + 1);
    }

    // Case 2: remote URL → normalize via repoUrlToCachePath
    if (GIT_URL_RE.test(remoteUrl)) {
      try {
        return repoUrlToCachePath(remoteUrl);
      } catch {
        // Normalization failed, fall through to path resolution
      }
    }

    // Case 3: local path — follow it to find the upstream remote
    const resolvedPath = resolve(currentDir, remoteUrl);
    if (visited.has(resolvedPath)) {
      // Circular reference, stop following
      return resolvedPath;
    }
    visited.add(resolvedPath);
    currentDir = resolvedPath;
  }

  // Exhausted depth limit, return the last resolved path
  return resolve(currentDir);
}

/** Clear the identity cache (for testing) */
export function clearIdentityCache(): void {
  identityCache.clear();
}
