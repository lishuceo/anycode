import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 工作区管理器
//
// 负责 git clone 仓库到隔离工作目录，并创建 feature 分支。
// 每次操作创建独立副本，多用户/多任务之间互不干扰。
// ============================================================

export interface SetupWorkspaceOptions {
  /** 远程仓库 URL (与 localPath 二选一) */
  repoUrl?: string;
  /** 本地仓库路径 (与 repoUrl 二选一) */
  localPath?: string;
  /** 源分支 (clone 时 checkout 的分支) */
  sourceBranch?: string;
  /** 自定义 feature 分支名 (默认自动生成) */
  featureBranch?: string;
}

export interface SetupWorkspaceResult {
  /** 工作区绝对路径 */
  workspacePath: string;
  /** 创建的 feature 分支名 */
  branch: string;
  /** 仓库名 */
  repoName: string;
}

/** git 分支名合法字符 */
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
/** git 远程 URL 协议前缀 */
const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/;

/**
 * 从 URL 或路径提取仓库名
 */
export function deriveRepoName(source: string): string {
  // URL: https://github.com/user/repo.git → repo
  // URL: git@github.com:user/repo.git → repo
  // Path: /home/user/projects/my-app → my-app
  const cleaned = source.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  return basename(cleaned) || 'repo';
}

/**
 * 创建隔离工作区：clone 仓库 + 创建 feature 分支
 */
export function setupWorkspace(options: SetupWorkspaceOptions): SetupWorkspaceResult {
  const { repoUrl, localPath, sourceBranch, featureBranch } = options;

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
  }
  if (sourceBranch && !SAFE_BRANCH_RE.test(sourceBranch)) {
    throw new Error(`无效的分支名: ${sourceBranch}`);
  }
  if (featureBranch && !SAFE_BRANCH_RE.test(featureBranch)) {
    throw new Error(`无效的分支名: ${featureBranch}`);
  }

  const repoName = deriveRepoName(source);
  const shortId = randomBytes(3).toString('hex');
  const branchPrefix = config.workspace.branchPrefix;
  const branch = featureBranch || `${branchPrefix}-${shortId}`;
  const dirName = `${repoName}-${branchPrefix.replace(/\//g, '-')}-${shortId}`;
  const workspacePath = resolve(config.workspace.baseDir, dirName);

  // 确保 baseDir 存在
  if (!existsSync(config.workspace.baseDir)) {
    mkdirSync(config.workspace.baseDir, { recursive: true });
    logger.info({ baseDir: config.workspace.baseDir }, 'Created workspace base directory');
  }

  // git clone (使用 execFileSync 避免 shell 注入)
  const cloneArgs: string[] = ['clone'];
  if (sourceBranch) {
    cloneArgs.push('--branch', sourceBranch);
  }
  cloneArgs.push(source, workspacePath);

  logger.info({ args: ['git', ...cloneArgs] }, 'Cloning repository');

  try {
    execFileSync('git', cloneArgs, {
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone 失败: ${msg}`);
  }

  // 创建 feature 分支 (使用 execFileSync 避免 shell 注入)
  logger.info({ branch, cwd: workspacePath }, 'Creating feature branch');

  try {
    execFileSync('git', ['checkout', '-b', branch], {
      cwd: workspacePath,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`创建分支失败: ${msg}`);
  }

  logger.info({ workspacePath, branch, repoName }, 'Workspace setup complete');
  return { workspacePath, branch, repoName };
}
