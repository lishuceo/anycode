import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ensureBareCache, sanitizeRepoUrl } from './cache.js';
import { GIT_LOCAL_CLONE_ARGS } from './git-security.js';

// ============================================================
// 工作区管理器
//
// 负责 git clone 仓库到隔离工作目录。
// - writable 模式：从缓存 local clone + 创建 feature 分支
// - readonly 模式：从缓存 local clone，不创建 feature 分支
// - 无 repoUrl 时 (localPath)：直接 clone 本地路径
// ============================================================

export interface SetupWorkspaceOptions {
  /** 远程仓库 URL (与 localPath 二选一) */
  repoUrl?: string;
  /** 本地仓库路径 (与 repoUrl 二选一) */
  localPath?: string;
  /** 访问模式: readonly 只读分析, writable 需要修改代码 */
  mode?: 'readonly' | 'writable';
  /** 源分支 (clone 时 checkout 的分支) */
  sourceBranch?: string;
  /** 自定义 feature 分支名 (默认自动生成, 仅 writable 模式) */
  featureBranch?: string;
}

export interface SetupWorkspaceResult {
  /** 工作区绝对路径 */
  workspacePath: string;
  /** 创建的分支名 (readonly 模式下为源分支名) */
  branch: string;
  /** 仓库名 */
  repoName: string;
}

/** git 分支名合法字符 */
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
/** git 远程 URL 协议前缀 */
const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/;
/** SSH 简写格式: github.com:user/repo.git (缺少 git@ 前缀) */
const SSH_SHORTHAND_RE = /^[\w.-]+\.\w{2,}:[\w./-]+$/;

/**
 * 归一化仓库 URL
 * - SSH 简写 (github.com:user/repo) → git@github.com:user/repo
 * - 其他格式原样返回
 */
function normalizeRepoUrl(url: string): string {
  if (!GIT_URL_RE.test(url) && SSH_SHORTHAND_RE.test(url)) {
    return `git@${url}`;
  }
  return url;
}


/**
 * 从 URL 或路径提取仓库名
 */
export function deriveRepoName(source: string): string {
  const cleaned = source.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  return basename(cleaned) || 'repo';
}

/**
 * 创建隔离工作区
 *
 * 流程 (repoUrl 有值时):
 *   1. 通过 ensureBareCache() 获取/更新 bare clone 缓存
 *   2. 从 bare cache local clone 到工作区 (快速)
 *   3. writable: 设置 origin 为原始远程地址 + 创建 feature 分支
 *      readonly: 仅切换到 sourceBranch (如指定)
 *
 * 流程 (localPath 有值时):
 *   直接从本地路径 clone (不经过缓存层)
 */
export function setupWorkspace(options: SetupWorkspaceOptions): SetupWorkspaceResult {
  const { localPath, mode = 'writable', sourceBranch, featureBranch } = options;
  // 归一化 URL: github.com:user/repo → git@github.com:user/repo
  const repoUrl = options.repoUrl ? normalizeRepoUrl(options.repoUrl) : undefined;

  const source = repoUrl || localPath;
  if (!source) {
    throw new Error('必须提供 repo_url 或 local_path');
  }

  // 输入校验
  if (repoUrl && !GIT_URL_RE.test(repoUrl)) {
    throw new Error(`无效的仓库 URL: ${repoUrl}`);
  }
  if (localPath) {
    const resolved = resolve(localPath);
    if (!existsSync(resolved)) {
      throw new Error(`本地路径不存在: ${localPath}`);
    }
    // 安全校验：localPath 必须在允许的基目录下（用 realpathSync 跟踪 symlink）
    const realResolved = realpathSync(resolved);
    const resolvedBase = resolve(config.claude.defaultWorkDir);
    const allowedBase = existsSync(resolvedBase) ? realpathSync(resolvedBase) : resolvedBase;
    if (!realResolved.startsWith(allowedBase + '/') && realResolved !== allowedBase) {
      throw new Error(`本地路径不在允许的目录范围内: ${localPath} (允许: ${allowedBase})`);
    }
  }
  if (sourceBranch && !SAFE_BRANCH_RE.test(sourceBranch)) {
    throw new Error(`无效的分支名: ${sourceBranch}`);
  }
  if (featureBranch && !SAFE_BRANCH_RE.test(featureBranch)) {
    throw new Error(`无效的分支名: ${featureBranch}`);
  }

  // 确定 clone 源: 有 repoUrl 时走缓存层，否则直接用 localPath
  let cloneSource: string;
  if (repoUrl) {
    cloneSource = ensureBareCache(repoUrl);
    logger.info({ repoUrl: sanitizeRepoUrl(repoUrl), cachePath: cloneSource }, 'Using bare cache as clone source');
  } else {
    cloneSource = source;
  }

  const repoName = deriveRepoName(source);
  const shortId = randomBytes(3).toString('hex');
  const branchPrefix = config.workspace.branchPrefix;
  const dirName = `${repoName}-${mode === 'writable' ? branchPrefix.replace(/\//g, '-') : 'readonly'}-${shortId}`;
  const workspacePath = resolve(config.workspace.baseDir, dirName);

  // 确保 baseDir 存在
  if (!existsSync(config.workspace.baseDir)) {
    mkdirSync(config.workspace.baseDir, { recursive: true });
    logger.info({ baseDir: config.workspace.baseDir }, 'Created workspace base directory');
  }

  // git clone: manager.ts 的 clone 源总是本地路径（bare cache 或 localPath），
  // 远程 clone 由 cache.ts 的 cloneBareAtomic 负责（使用 GIT_REMOTE_SECURITY_ARGS）
  const cloneArgs: string[] = [
    'clone',
    ...GIT_LOCAL_CLONE_ARGS,
  ];
  if (sourceBranch) {
    cloneArgs.push('--branch', sourceBranch);
  }
  cloneArgs.push(cloneSource, workspacePath);

  logger.info({ mode, source: cloneSource, workspacePath }, 'Cloning to workspace');

  try {
    execFileSync('git', cloneArgs, {
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone 失败: ${msg}`);
  }

  if (mode === 'writable') {
    // writable: 设置 remote origin 为原始远程地址 (剥离认证信息)
    if (repoUrl) {
      try {
        execFileSync('git', ['remote', 'set-url', 'origin', sanitizeRepoUrl(repoUrl)], {
          cwd: workspacePath,
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg }, 'Failed to set remote URL, continuing');
      }
    }

    // 创建 feature 分支
    const branchName = featureBranch || `${branchPrefix}-${shortId}`;
    logger.info({ branch: branchName, cwd: workspacePath }, 'Creating feature branch');

    try {
      execFileSync('git', ['checkout', '-b', branchName], {
        cwd: workspacePath,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`创建分支失败: ${msg}`);
    }

    logger.info({ workspacePath, branch: branchName, repoName, mode }, 'Workspace setup complete');
    return { workspacePath, branch: branchName, repoName };
  }

  // readonly: 不创建 feature 分支
  logger.info({ workspacePath, repoName, mode }, 'Readonly workspace setup complete');
  return { workspacePath, branch: sourceBranch || 'default', repoName };
}
