// ============================================================
// Memory System — Repository Scope Resolver
// ============================================================
//
// 决定一条记忆归属到哪个仓库。用于按 repository 作用域过滤,
// 防止跨项目记忆污染（如 maker 的事实污染 anycode 上下文）。
//
// 解析顺序:
//   1. 输入路径 → git remote 'origin' → canonical URL (https://host/org/repo)
//   2. 输入路径在 bare cache 内 → 从路径直接推导
//   3. 失败兜底: local://<absolute-path>
//
// canonical URL 与 workspace/registry.ts 的 toCanonicalUrl() 保持一致,
// 这是跨整个系统的 repo 主键。

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { toCanonicalUrl } from '../workspace/registry.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** repository 字符串前缀,标识不可推断的本地路径 */
const LOCAL_SCHEME = 'local://';

/**
 * 从 cwd 推断当前所属的 canonical repo URL。
 * 永不抛错,失败时返回 null（让调用方决定是否回退到 user-scope）。
 */
export function resolveRepositoryForCwd(cwd: string | undefined | null): string | null {
  if (!cwd) return null;

  const abs = resolve(cwd);
  if (!existsSync(abs)) return null;

  // Bare cache: /path/to/.repo-cache/host/org/repo.git
  const cacheDir = resolve(config.repoCache.dir);
  if (abs.startsWith(cacheDir + '/') || abs === cacheDir) {
    const rel = abs.slice(cacheDir.length + 1);
    // 取前三段 host/org/repo.git
    const parts = rel.split('/').slice(0, 3);
    if (parts.length === 3 && parts[2].endsWith('.git')) {
      return `https://${parts.slice(0, 2).join('/')}/${parts[2].replace(/\.git$/, '')}`;
    }
  }

  // 普通仓库 / worktree: 从 git remote 解析
  const gitDir = findGitDir(abs);
  if (gitDir) {
    const url = getOriginUrl(gitDir);
    if (url) {
      try {
        return toCanonicalUrl(url);
      } catch (err) {
        logger.debug({ err, url }, 'Failed to canonicalize remote URL');
      }
    }
    // 有 git 但没有 origin: 用 git 顶层目录作为身份
    return `${LOCAL_SCHEME}${gitDir}`;
  }

  // 完全不是 git 目录
  return `${LOCAL_SCHEME}${abs}`;
}

/** 向上找最近的 .git 目录所在的 work tree 顶层路径 */
function findGitDir(start: string): string | null {
  let cur = start;
  for (let i = 0; i < 30; i++) {
    const gitPath = `${cur}/.git`;
    if (existsSync(gitPath)) {
      // .git 既可以是目录(普通仓库),也可以是文件(worktree)
      try {
        return statSync(gitPath).isDirectory() || statSync(gitPath).isFile() ? cur : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** 读 git remote get-url origin,失败返回 null */
function getOriginUrl(repoDir: string): string | null {
  try {
    const url = execFileSync('git', [
      '-c', 'core.hooksPath=/dev/null',
      '-C', repoDir,
      'remote', 'get-url', 'origin',
    ], { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return url || null;
  } catch {
    return null;
  }
}

/** 判断是否为不可推断的 local fallback (用于回填和审计) */
export function isLocalRepository(repository: string | null | undefined): boolean {
  return typeof repository === 'string' && repository.startsWith(LOCAL_SCHEME);
}
