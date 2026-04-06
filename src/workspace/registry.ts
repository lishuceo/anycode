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
// - JSON (.repo-registry.json) 作为 source of truth
// - Markdown (.repo-registry.md) 自动生成，供 LLM 阅读
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

function registryMdPath(): string {
  return join(config.claude.defaultWorkDir, '.repo-registry.md');
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

/** 从 JSON 生成 Markdown 渲染文件 */
function renderMarkdown(data: RegistryData): void {
  const lines: string[] = [
    '# Repo Registry',
    '<!-- 由系统自动生成，请勿手动编辑。修改 .repo-registry.json 后会自动重新生成 -->',
    '<!-- 主键: canonical repo URL，确保跨目录/缓存的唯一标识 -->',
    '',
  ];

  const entries = Object.entries(data.repos).filter(([, e]) => !e.removed);
  if (entries.length === 0) {
    lines.push('(暂无仓库)');
  }
  for (const [url, entry] of entries) {
    lines.push(`## ${entry.name}`);
    lines.push(`- **ID**: ${url}`);
    lines.push(`- **路径**: ${entry.localPath ?? '(仅在缓存中)'}`);
    lines.push(`- **缓存**: ${entry.cachePath ?? '(本地仓库，无 remote)'}`);
    lines.push(`- **描述**: ${entry.description ?? '(待补充)'}`);
    lines.push(`- **关键词**: ${entry.keywords.length > 0 ? entry.keywords.join(', ') : '(待补充)'}`);
    if (entry.techStack.length > 0) {
      lines.push(`- **技术栈**: ${entry.techStack.join(', ')}`);
    }
    lines.push('');
  }

  const mdPath = registryMdPath();
  const tmpPath = `${mdPath}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, lines.join('\n'), 'utf-8');
  renameSync(tmpPath, mdPath);
}

// ============================================================
// Git 工具
// ============================================================

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

  // 追加新发现的仓库
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
  renderMarkdown(registryData);

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
): void {
  const data = readRegistry();
  const entry = data.repos[canonicalUrl];

  if (entry) {
    if (updates.description !== undefined) entry.description = updates.description;
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
  renderMarkdown(data);
  refreshSourceRepoCache(data);
}
