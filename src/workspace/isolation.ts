import { existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { setupWorkspace } from './manager.js';

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
export function ensureIsolatedWorkspace(
  workingDir: string,
  mode: 'readonly' | 'writable' = 'writable',
): string {
  // 已在工作区目录下 → 已隔离
  if (isAutoWorkspacePath(workingDir)) {
    return workingDir;
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
      return result.workspacePath;
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

  return workingDir;
}
