import { execFileSync } from 'node:child_process';
import {
  existsSync, readdirSync, readFileSync,
  writeFileSync, renameSync, mkdirSync, realpathSync,
} from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { repoUrlToCachePath, sanitizeRepoUrl, ensureBareCache } from './cache.js';

// ============================================================
// 仓库 Registry
//
// 维护 DEFAULT_WORK_DIR 下所有仓库的索引文件。
// - JSON (.repo-registry.json) 作为唯一数据源（LLM 直接读 JSON）
// - 使用 canonical repo URL 作为主键
// - 内存缓存源仓库路径集合，供 isInsideSourceRepo 快速匹配
// ============================================================

/** Registry 中单个仓库条目 */
export interface RegistryEntry {
  name: string;
  /** 相对于 DEFAULT_WORK_DIR 的本地路径，无本地副本则为 null */
  localPath: string | null;
  /** 相对于 REPO_CACHE_DIR 的 bare cache 路径，无缓存则为 null */
  cachePath: string | null;
  /** 仓库描述（LLM 或人工填写） */
  description: string | null;
  /** 匹配关键词 */
  keywords: string[];
  /** 技术栈标签 */
  techStack: string[];
  /** 标记为已移除（目录不存在但保留历史关键词） */
  removed?: boolean;
}

/** Registry JSON 文件结构 */
export interface RegistryData {
  repos: Record<string, RegistryEntry>;
}

/** 增量更新字段 */
export interface RegistryUpdate {
  description?: string;
  keywords?: string[];
  techStack?: string[];
}

// ============================================================
// 内存缓存
// ============================================================

/** 已知源仓库的绝对路径集合（由 scanAndSyncRegistry 填充） */
let sourceRepoPaths: Set<string> = new Set();

/**
 * 获取内存中缓存的源仓库根路径集合。
 * 供 isInsideSourceRepo() 做前缀匹配，避免每次遍历文件系统。
 * 缓存未初始化时返回空 Set（调用方应 fallback 到目录遍历）。
 */
export function getSourceRepoPaths(): Set<string> {
  return sourceRepoPaths;
}

// ============================================================
// Canonical URL
// ============================================================

/**
 * 将 git remote URL 规范化为 canonical 格式: https://{host}/{org}/{repo}
 * 去掉 .git 后缀、auth 信息、协议差异。
 * 复用 cache.ts 的 URL 解析逻辑。
 */
export function toCanonicalUrl(repoUrl: string): string {
  // repoUrlToCachePath 返回 "host/org/repo.git" (小写)
  const cachePath = repoUrlToCachePath(repoUrl);
  // 去掉 .git 后缀，构造 https URL
  const withoutGit = cachePath.replace(/\.git$/, '');
  return `https://${withoutGit}`;
}

/**
 * 从 bare cache 路径推导 canonical URL
 * e.g., "github.com/user/repo.git" → "https://github.com/user/repo"
 */
function cachePathToCanonicalUrl(relativePath: string): string {
  const withoutGit = relativePath.replace(/\.git\/?$/, '');
  return `https://${withoutGit}`;
}

// ============================================================
// Registry 文件 I/O
// ============================================================

function registryJsonPath(): string {
  return join(config.claude.defaultWorkDir, '.repo-registry.json');
}

/** 读取现有 registry JSON，不存在则返回空 */
function readRegistry(): RegistryData {
  const path = registryJsonPath();
  if (!existsSync(path)) return { repos: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RegistryData;
  } catch (err) {
    logger.warn({ err, path }, 'Failed to parse registry JSON, starting fresh');
    return { repos: {} };
  }
}

/** 原子写入 registry JSON（tmp + rename） */
function writeRegistry(data: RegistryData): void {
  const path = registryJsonPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);
}

// ============================================================
// Git 工具
// ============================================================

/** 从本地仓库提取基本信息（description, techStack）用于按需填充 registry */
export function extractRepoMeta(repoDir: string): { description?: string; techStack?: string[] } {
  const result: { description?: string; techStack?: string[] } = {};
  try {
    const pkgPath = join(repoDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.description && typeof pkg.description === 'string') {
        result.description = pkg.description;
      }
      // 从 dependencies + devDependencies 提取主要技术栈
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const techStack: string[] = [];
      if (deps.typescript || deps['ts-node'] || deps.tsx) techStack.push('TypeScript');
      if (deps.react || deps['react-dom']) techStack.push('React');
      if (deps.vue) techStack.push('Vue');
      if (deps.next) techStack.push('Next.js');
      if (deps.express) techStack.push('Express');
      if (deps.fastify) techStack.push('Fastify');
      if (deps.prisma || deps['@prisma/client']) techStack.push('Prisma');
      if (deps.vite) techStack.push('Vite');
      if (deps.webpack) techStack.push('Webpack');
      if (techStack.length > 0) result.techStack = techStack;
      return result;
    }
    // Python 项目
    if (existsSync(join(repoDir, 'pyproject.toml')) || existsSync(join(repoDir, 'setup.py'))) {
      result.techStack = ['Python'];
      return result;
    }
    // Go 项目
    if (existsSync(join(repoDir, 'go.mod'))) {
      result.techStack = ['Go'];
      return result;
    }
    // Rust 项目
    if (existsSync(join(repoDir, 'Cargo.toml'))) {
      result.techStack = ['Rust'];
      return result;
    }
    // C/C++ 项目（CMakeLists.txt 可能在子目录）
    const hasCMake = existsSync(join(repoDir, 'CMakeLists.txt'))
      || readdirSync(repoDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .some(d => existsSync(join(repoDir, d.name, 'CMakeLists.txt')));
    if (hasCMake) {
      result.techStack = ['C++'];
    }
  } catch {
    // best-effort
  }
  // Fallback: 从 README.md 提取描述（如果还没有）
  if (!result.description) {
    try {
      const readmePath = join(repoDir, 'README.md');
      if (existsSync(readmePath)) {
        // 只读前 3KB，避免大文件
        const raw = readFileSync(readmePath, 'utf-8').slice(0, 3000);
        const lines = raw.split('\n');
        const contentLines: string[] = [];
        let foundContent = false;

        for (const line of lines) {
          const trimmed = line.trim();
          // 跳过装饰性行
          if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('[') ||
              trimmed.startsWith('>') || trimmed.startsWith('http') ||
              trimmed.startsWith('!') || trimmed.startsWith('---') ||
              trimmed.startsWith('```') || trimmed.startsWith('|')) continue;

          if (trimmed.startsWith('#')) {
            // 标题行：提取标题文本
            const title = trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
            if (title.length >= 3) {
              contentLines.push(title);
              foundContent = true;
            }
            continue;
          }

          // 正文内容行：去掉 markdown 格式
          const clean = trimmed.replace(/\*\*/g, '').replace(/`/g, '').trim();
          if (clean.length >= 5) {
            contentLines.push(clean);
            foundContent = true;
          }

          // 收集到足够信息后停止（标题 + 2-3 段描述，约 300 字符）
          const totalLen = contentLines.join(' ').length;
          if (foundContent && totalLen >= 200) break;
        }

        if (contentLines.length > 0) {
          const desc = contentLines.join(' — ');
          result.description = desc.length > 500 ? desc.slice(0, 497) + '...' : desc;
        }
      }
    } catch {
      // best-effort
    }
  }
  return result;
}

/** 获取本地仓库的 origin remote URL，无 remote 则返回 null */
function getOriginUrl(repoDir: string): string | null {
  try {
    const url = execFileSync('git', [
      '-c', 'core.hooksPath=/dev/null',
      '-C', repoDir,
      'remote', 'get-url', 'origin',
    ], { encoding: 'utf-8', timeout: 5_000 }).trim();
    return url || null;
  } catch {
    return null;
  }
}

// ============================================================
// 扫描与同步
// ============================================================

/**
 * 全量扫描 DEFAULT_WORK_DIR 和 .repo-cache，同步 registry。
 * - 扫描 DEFAULT_WORK_DIR 直接子目录（排除 . 开头）
 * - 扫描 .repo-cache 下所有 bare clone
 * - 以 canonical URL 为主键合并
 * - 保留已有条目的描述和关键词
 * - 更新内存缓存的源仓库路径集合
 */
export async function scanAndSyncRegistry(): Promise<void> {
  const projectsDir = config.claude.defaultWorkDir;
  const cacheDir = config.repoCache.dir;

  logger.info({ projectsDir, cacheDir }, 'Scanning repos for registry sync');

  const existing = readRegistry();
  const discovered = new Map<string, Partial<RegistryEntry> & { localAbsPath?: string }>();

  // 1. 扫描 DEFAULT_WORK_DIR 直接子目录
  try {
    const dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    for (const d of dirs) {
      const absPath = resolve(projectsDir, d.name);
      if (!existsSync(join(absPath, '.git'))) continue;

      const originUrl = getOriginUrl(absPath);
      let canonicalUrl: string;

      if (originUrl) {
        try {
          canonicalUrl = toCanonicalUrl(sanitizeRepoUrl(originUrl));
        } catch {
          logger.warn({ dir: d.name, originUrl }, 'Failed to parse origin URL, using local:// key');
          canonicalUrl = `local://${absPath}`;
        }
      } else {
        canonicalUrl = `local://${absPath}`;
      }

      const localPath = `./${d.name}`;
      const prev = discovered.get(canonicalUrl);
      discovered.set(canonicalUrl, {
        ...prev,
        name: prev?.name || d.name,
        localPath,
        localAbsPath: absPath,
      });
    }
  } catch (err) {
    logger.warn({ err, projectsDir }, 'Failed to scan projects directory');
  }

  // 2. 扫描 .repo-cache
  try {
    if (existsSync(cacheDir)) {
      scanCacheDir(cacheDir, cacheDir, discovered);
    }
  } catch (err) {
    logger.warn({ err, cacheDir }, 'Failed to scan cache directory');
  }

  // 3. 合并到现有 registry
  const merged: Record<string, RegistryEntry> = {};

  // 保留已有条目的描述/关键词
  for (const [url, entry] of Object.entries(existing.repos)) {
    if (discovered.has(url)) {
      // 仓库仍存在，合并
      const disc = discovered.get(url)!;
      merged[url] = {
        name: disc.name || entry.name,
        localPath: disc.localPath ?? entry.localPath,
        cachePath: disc.cachePath ?? entry.cachePath,
        description: entry.description,
        keywords: entry.keywords || [],
        techStack: entry.techStack || [],
      };
      discovered.delete(url);
    } else if (!entry.removed) {
      // 仓库不存在了，标记为 removed（保留关键词以备后续重新添加）
      merged[url] = { ...entry, removed: true };
    }
    // 已 removed 且仍不存在 → 不再保留
  }

  // 追加新发现的仓库（仅结构信息，description/techStack 在 setup_workspace 后按需填充）
  for (const [url, disc] of discovered) {
    merged[url] = {
      name: disc.name || basename(url),
      localPath: disc.localPath ?? null,
      cachePath: disc.cachePath ?? null,
      description: null,
      keywords: [],
      techStack: [],
    };
  }

  const registryData: RegistryData = { repos: merged };
  writeRegistry(registryData);

  // 4. 更新内存缓存
  refreshSourceRepoCache(registryData);

  const activeCount = Object.values(merged).filter(e => !e.removed).length;
  logger.info({ totalRepos: activeCount }, 'Registry sync complete');

  // 5. 异步创建缺失的 bare cache（fire-and-forget）
  ensureMissingBareCaches(registryData).catch(err => {
    logger.warn({ err }, 'Background bare cache creation failed (non-blocking)');
  });
}

/** 递归扫描 cache 目录，找到所有 bare clone */
function scanCacheDir(
  baseDir: string,
  currentDir: string,
  discovered: Map<string, Partial<RegistryEntry> & { localAbsPath?: string }>,
  depth = 0,
): void {
  if (depth > 4) return; // 防止过深递归

  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) continue;
    const fullPath = join(currentDir, entry.name);

    // bare repo 通常以 .git 结尾且包含 HEAD 文件
    if (entry.name.endsWith('.git') && existsSync(join(fullPath, 'HEAD'))) {
      const relativePath = fullPath.slice(baseDir.length + 1); // e.g., "github.com/org/repo.git"
      const canonicalUrl = cachePathToCanonicalUrl(relativePath);
      const prev = discovered.get(canonicalUrl);
      discovered.set(canonicalUrl, {
        ...prev,
        name: prev?.name || basename(relativePath, '.git'),
        cachePath: relativePath,
      });
    } else {
      // 继续递归（host/org 层级）
      scanCacheDir(baseDir, fullPath, discovered, depth + 1);
    }
  }
}

/** 从 registry data 刷新内存中的源仓库路径缓存 */
function refreshSourceRepoCache(data: RegistryData): void {
  const paths = new Set<string>();
  const projectsDir = config.claude.defaultWorkDir;

  for (const entry of Object.values(data.repos)) {
    if (entry.removed || !entry.localPath) continue;
    const absPath = resolve(projectsDir, entry.localPath);
    if (existsSync(absPath)) {
      try {
        paths.add(realpathSync(absPath));
      } catch {
        paths.add(absPath);
      }
    }
  }

  sourceRepoPaths = paths;
  logger.debug({ count: paths.size }, 'Source repo path cache refreshed');
}

/** 为有 remote 但无 bare cache 的本地仓库创建缓存 */
async function ensureMissingBareCaches(data: RegistryData): Promise<void> {
  for (const [url, entry] of Object.entries(data.repos)) {
    if (entry.removed) continue;
    if (entry.cachePath) continue; // 已有缓存
    if (url.startsWith('local://')) continue; // 无 remote 的本地仓库

    try {
      logger.info({ url }, 'Creating bare cache for local repo');
      ensureBareCache(url);

      // 更新 registry 条目的 cachePath
      const cachePath = repoUrlToCachePath(url);
      updateRegistryEntry(url, {}, cachePath);
    } catch (err) {
      logger.warn({ err, url }, 'Failed to create bare cache (non-blocking)');
    }
  }
}

// ============================================================
// 增量更新
// ============================================================

/**
 * 更新 registry 中指定仓库的条目。
 * 以 canonical URL 为主键定位。不存在则自动追加。
 * 使用 atomic write 保证并发安全。
 */
export function updateRegistryEntry(
  canonicalUrl: string,
  updates: RegistryUpdate,
  newCachePath?: string,
  /** force=true 时覆盖已有 description（用于 LLM 主动更新）。默认 false 仅填充空值 */
  force = false,
): void {
  const data = readRegistry();
  const entry = data.repos[canonicalUrl];

  if (entry) {
    // description: 默认仅填充空值；force=true 时允许覆盖（LLM 主动更新）
    if (updates.description !== undefined && (force || !entry.description)) entry.description = updates.description;
    if (updates.keywords?.length) {
      // 追加关键词，去重
      const combined = new Set([...entry.keywords, ...updates.keywords]);
      entry.keywords = [...combined];
    }
    if (updates.techStack?.length) {
      const combined = new Set([...entry.techStack, ...updates.techStack]);
      entry.techStack = [...combined];
    }
    if (newCachePath) entry.cachePath = newCachePath;
  } else {
    // 新条目
    const name = basename(canonicalUrl.replace(/\.git$/, ''));
    data.repos[canonicalUrl] = {
      name,
      localPath: null,
      cachePath: newCachePath ?? null,
      description: updates.description ?? null,
      keywords: updates.keywords ?? [],
      techStack: updates.techStack ?? [],
    };
  }

  writeRegistry(data);
  refreshSourceRepoCache(data);
}
