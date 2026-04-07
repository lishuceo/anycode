import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { setupWorkspace } from './manager.js';
import { getSourceRepoPaths } from './registry.js';

// ============================================================
// 工作区隔离工具
//
// 共享路径判断和工作区隔离逻辑，统一使用 realpathSync 解析
// symlink，与 /project 命令和 router.ts isPathAllowed 保持一致。
// ============================================================

/**
 * 判断路径是否在自动创建的工作区目录（WORKSPACE_BASE_DIR）下。
 * 使用 realpathSync 跟踪 symlink，防止 symlink 绕过前缀检查。
 */
export function isAutoWorkspacePath(dir: string): boolean {
  try {
    const resolvedBase = existsSync(config.workspace.baseDir)
      ? realpathSync(resolve(config.workspace.baseDir))
      : resolve(config.workspace.baseDir);
    // 目录可能已被清理（不存在），此时无法 realpathSync，用 resolve 兜底
    const resolvedDir = existsSync(dir)
      ? realpathSync(resolve(dir))
      : resolve(dir);
    return resolvedDir.startsWith(resolvedBase + '/');
  } catch {
    return false;
  }
}

/**
 * 判断工作目录是否是 anycode 服务自身的仓库（自改自场景）。
 * 通过 package.json name 字段匹配，比路径对比更鲁棒（worktree clone 也能识别）。
 */
export function isServiceOwnRepo(dir: string): boolean {
  try {
    const pkgPath = join(resolve(dir), 'package.json');
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.name === 'anycode';
  } catch {
    return false;
  }
}

/**
 * 判断路径是否位于 DEFAULT_WORK_DIR 下某个源仓库的工作树内。
 * 用于源仓库保护：阻止 agent 直接修改源仓库中的文件。
 *
 * 优先使用 registry 缓存的源仓库路径集合做前缀匹配（O(n)），
 * 缓存未初始化时 fallback 到向上遍历目录树查找 .git。
 *
 * 对于不存在的文件路径（Write 新建文件），resolve 其父目录。
 */
export function isInsideSourceRepo(filePath: string): boolean {
  let resolved: string;
  try {
    if (existsSync(filePath)) {
      resolved = realpathSync(filePath);
    } else {
      // Write 新建文件：文件不存在，resolve 父目录后拼接文件名
      const parentDir = dirname(filePath);
      if (existsSync(parentDir)) {
        resolved = realpathSync(parentDir) + '/' + basename(filePath);
      } else {
        resolved = resolve(filePath);
      }
    }
  } catch (err) {
    // 安全检查 fail-closed：无法解析路径时视为在源仓库内（拒绝写入）
    logger.warn({ err, filePath }, 'isInsideSourceRepo: path resolution failed, failing closed');
    return true;
  }

  // 排除 WORKSPACE_BASE_DIR（已隔离的工作区）
  if (isAutoWorkspacePath(filePath)) return false;

  // 排除 .repo-cache 目录
  try {
    const cacheDir = existsSync(config.repoCache.dir)
      ? realpathSync(config.repoCache.dir)
      : resolve(config.repoCache.dir);
    if (resolved.startsWith(cacheDir + '/') || resolved === cacheDir) return false;
  } catch {
    // repoCache.dir 不存在，不需要排除
  }

  // 快速路径：使用 registry 缓存的源仓库路径集合
  const cachedPaths = getSourceRepoPaths();
  if (cachedPaths.size > 0) {
    for (const repoRoot of cachedPaths) {
      if (resolved === repoRoot || resolved.startsWith(repoRoot + '/')) {
        return true;
      }
    }
    return false;
  }

  // Fallback：缓存未初始化，向上遍历查找 .git
  const projectsDir = existsSync(config.claude.defaultWorkDir)
    ? realpathSync(config.claude.defaultWorkDir)
    : resolve(config.claude.defaultWorkDir);

  if (!resolved.startsWith(projectsDir + '/') && resolved !== projectsDir) {
    return false;
  }

  let current = resolved;
  while (current.length > projectsDir.length) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/**
 * 确保工作目录是隔离的工作区。
 *
 * 对 routing agent 返回的 `use_existing` 路径（指向 projectsDir 下的源仓库），
 * 自动通过 setupWorkspace 创建隔离 clone，使每个话题有独立的工作区。
 *
 * - 已在 WORKSPACE_BASE_DIR 下 → 已隔离（clone_remote 创建），直接返回
 * - 包含 .git 目录 → 是 git 仓库，clone 到新工作区
 * - 其他（如 defaultWorkDir）→ 非 git 仓库，直接返回
 *
 * writable 模式下，clone 失败会抛出异常（不静默回退到共享目录）。
 * readonly 模式下，clone 失败回退到原路径（只读不影响源仓库）。
 */
/** ensureIsolatedWorkspace 返回结果 */
export interface IsolatedWorkspaceResult {
  workingDir: string;
  /** 非阻断性警告（如缓存 fetch 失败） */
  warning?: string;
}

export function ensureIsolatedWorkspace(
  workingDir: string,
  mode: 'readonly' | 'writable' = 'writable',
): IsolatedWorkspaceResult {
  // 已在工作区目录下 → 已隔离
  if (isAutoWorkspacePath(workingDir)) {
    return { workingDir };
  }

  // 检查是否是 git 仓库
  try {
    if (existsSync(join(resolve(workingDir), '.git'))) {
      logger.info({ workingDir, mode }, 'Creating isolated workspace from existing repo');
      const result = setupWorkspace({ localPath: workingDir, mode });
      logger.info(
        { originalDir: workingDir, workspacePath: result.workspacePath, branch: result.branch },
        'Isolated workspace created',
      );
      return { workingDir: result.workspacePath, warning: result.warning };
    }
  } catch (err) {
    if (mode === 'writable') {
      // writable 模式不允许回退到共享目录，抛出让调用方处理
      logger.error({ err, workingDir }, 'Failed to create isolated workspace for writable mode');
      throw new Error(`无法创建隔离工作区: ${(err as Error).message}`);
    }
    // readonly 模式允许回退（只读不影响源仓库）
    logger.warn({ err, workingDir }, 'Failed to create isolated workspace (readonly), using original path');
  }

  return { workingDir };
}
