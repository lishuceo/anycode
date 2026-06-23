// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// execFile 被 promisify 包裹，mock 必须调用末位回调，否则 await 永远挂起。
// 默认实现：成功（cb(null, ...)）；失败用例在测试内 mockImplementation 覆盖。
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') (cb as (e: unknown, r: unknown) => void)(null, { stdout: '', stderr: '' });
  }),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => Buffer.from('deadbeef', 'hex')),
}));

vi.mock('../../config.js', () => ({
  config: {
    repoCache: {
      dir: '/repos/cache',
      maxAgeDays: 30,
      maxSizeGb: 50,
      fetchIntervalMin: 10,
    },
    workspace: {
      baseDir: '/tmp/workspaces',
    },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { execFile } from 'node:child_process';
import { existsSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { repoUrlToCachePath, sanitizeRepoUrl, ensureBareCache, cleanupTmpDirs, cleanupExpiredCaches } from '../cache.js';

const mockExecFile = vi.mocked(execFile);
/** 让 mock 的 execFile 以回调失败（promisify 后即 reject） */
function makeExecFileFail(message: string) {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') (cb as (e: unknown) => void)(new Error(message));
    return undefined as never;
  });
}
/** 恢复 mock 的 execFile 默认成功行为 */
function makeExecFileSucceed() {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') (cb as (e: unknown, r: unknown) => void)(null, { stdout: '', stderr: '' });
    return undefined as never;
  });
}
const mockExistsSync = vi.mocked(existsSync);
const mockRenameSync = vi.mocked(renameSync);
const mockRmSync = vi.mocked(rmSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  // clearAllMocks 只清调用历史、不恢复实现：显式重置 execFile 为默认成功，
  // 避免上一个用例的 makeExecFileFail 泄漏到下一个用例。
  makeExecFileSucceed();
});

// ============================================================
// repoUrlToCachePath
// ============================================================

describe('repoUrlToCachePath', () => {
  it('should parse HTTPS URL', () => {
    expect(repoUrlToCachePath('https://github.com/foo/bar.git'))
      .toBe('github.com/foo/bar.git');
  });

  it('should parse HTTPS URL without .git suffix', () => {
    expect(repoUrlToCachePath('https://github.com/foo/bar'))
      .toBe('github.com/foo/bar.git');
  });

  it('should parse SSH shorthand (git@host:path)', () => {
    expect(repoUrlToCachePath('git@github.com:foo/bar.git'))
      .toBe('github.com/foo/bar.git');
  });

  it('should parse ssh:// URL', () => {
    expect(repoUrlToCachePath('ssh://git@github.com/foo/bar.git'))
      .toBe('github.com/foo/bar.git');
  });

  it('should handle multi-level GitLab groups', () => {
    expect(repoUrlToCachePath('https://gitlab.com/org/subgroup/project'))
      .toBe('gitlab.com/org/subgroup/project.git');
  });

  it('should preserve port in host', () => {
    expect(repoUrlToCachePath('https://git.corp.com:8443/org/repo'))
      .toBe('git.corp.com:8443/org/repo.git');
  });

  it('should strip authentication info from URL', () => {
    expect(repoUrlToCachePath('https://user:token@github.com/foo/bar'))
      .toBe('github.com/foo/bar.git');
  });

  it('should normalize to lowercase', () => {
    expect(repoUrlToCachePath('https://GitHub.com/Foo/Bar.git'))
      .toBe('github.com/foo/bar.git');
  });

  it('should reject URL with path traversal (..)', () => {
    // URL class auto-resolves ".." so we test via git@ format which doesn't
    expect(() => repoUrlToCachePath('git@github.com:foo/../../etc/passwd'))
      .toThrow('非法路径段');
  });

  it('should reject URL with dot-prefixed segment', () => {
    expect(() => repoUrlToCachePath('https://github.com/.hidden/repo'))
      .toThrow('非法路径段');
  });

  it('should reject unparseable URL', () => {
    expect(() => repoUrlToCachePath('not-a-url'))
      .toThrow('无法解析仓库 URL');
  });

  it('should reject URL with empty path', () => {
    expect(() => repoUrlToCachePath('https://github.com'))
      .toThrow('无法解析仓库 URL');
  });
});

// ============================================================
// sanitizeRepoUrl
// ============================================================

describe('sanitizeRepoUrl', () => {
  it('should strip credentials from HTTPS URL', () => {
    const result = sanitizeRepoUrl('https://user:token@github.com/foo/bar.git');
    expect(result).not.toContain('user');
    expect(result).not.toContain('token');
    expect(result).toContain('github.com/foo/bar.git');
  });

  it('should return SSH URL unchanged', () => {
    expect(sanitizeRepoUrl('git@github.com:foo/bar.git'))
      .toBe('git@github.com:foo/bar.git');
  });

  it('should handle URL without credentials', () => {
    const url = 'https://github.com/foo/bar.git';
    expect(sanitizeRepoUrl(url)).toContain('github.com/foo/bar.git');
  });
});

// ============================================================
// ensureBareCache
// ============================================================

describe('ensureBareCache', () => {
  it('should create bare clone when cache does not exist', async () => {
    mockExistsSync.mockImplementation((p) => {
      // parent dir exists, cache path does not
      if (String(p).endsWith('foo')) return true;
      return false;
    });

    const result = await ensureBareCache('https://github.com/foo/bar.git');

    expect(result.cachePath).toContain('/repos/cache/github.com/foo/bar.git');

    // Should call git clone --bare (后续 fetch 的新鲜度由显式 refspec 保证)
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const args = mockExecFile.mock.calls[0][1];
    expect(args).toContain('clone');
    expect(args).toContain('--bare');
    // 不用 --mirror：避免把 GitHub 通告的 refs/pull/* 全部拉进缓存
    // （fetch 只更新 heads/tags，永不 prune 这些 pull ref，徒增体积）
    expect(args).not.toContain('--mirror');
    expect(args).toContain('--config');
    expect(args).toContain('core.hooksPath=/dev/null');
    expect(args).toContain('--no-recurse-submodules');

    // Should rename tmp dir
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
  });

  it('should fetch with explicit heads refspec when cache exists and is stale', async () => {
    mockExistsSync.mockReturnValue(true);

    await ensureBareCache('https://github.com/foo/bar.git');

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const args = mockExecFile.mock.calls[0][1];
    expect(args).toContain('fetch');
    expect(args).toContain('--prune');
    expect(args).toContain('origin');
    expect(args).toContain('+refs/heads/*:refs/heads/*');
  });

  it('should NOT use bare `fetch --all` (regression: frozen heads on refspec-less --bare caches)', async () => {
    // 根因回归守卫：早期 git clone --bare 创建的缓存无 remote.origin.fetch refspec，
    // fetch --all 只刷新 FETCH_HEAD 而不移动 refs/heads/*，缓存分支永久冻结。
    // 必须用显式 refspec，且不得退回 --all。
    mockExistsSync.mockReturnValue(true);

    await ensureBareCache('https://github.com/foo/frozen-heads-regression.git');

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('+refs/heads/*:refs/heads/*');
    expect(args).not.toContain('--all');
  });

  it('should skip fetch when recently fetched', async () => {
    // Cache exists for both calls
    mockExistsSync.mockReturnValue(true);

    // First call: fetches
    await ensureBareCache('https://github.com/foo/qux.git');
    const fetchCalls = mockExecFile.mock.calls.filter(
      c => (c[1] as string[]).includes('fetch'),
    );
    expect(fetchCalls).toHaveLength(1);

    mockExecFile.mockClear();

    // Second call with same URL: should skip fetch (within interval)
    await ensureBareCache('https://github.com/foo/qux.git');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('should cleanup tmp dir on clone failure', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (String(p).endsWith('foo')) return true;
      // tmp dir exists for cleanup
      if (String(p).includes('.tmp-')) return true;
      return false;
    });

    makeExecFileFail('clone failed');

    await expect(ensureBareCache('https://github.com/foo/bar.git'))
      .rejects.toThrow('bare clone 失败');

    // Should attempt to clean up tmp dir
    expect(mockRmSync).toHaveBeenCalled();
  });

  // ============================================================
  // 回归守卫：网络 git 不得阻塞事件循环
  // 根因：早期 cloneBareAtomic 用 execFileSync，clone 卡到 timeout 期间
  // 整个单进程 bridge 冻结，所有会话毫无响应（飞书事件无法 ACK → 重投 → 被当陈旧丢弃）。
  // ============================================================
  it('should NOT block the event loop while a bare clone is in flight', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (String(p).endsWith('foo')) return true; // parent dir exists
      return false;                                // cache path does not
    });

    // 模拟一个"慢" clone：回调延后到下一个宏任务才触发（代表网络 IO 未完成）。
    let release: () => void = () => {};
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      release = () => cb(null, { stdout: '', stderr: '' });
      return undefined as never;
    });

    const clonePromise = ensureBareCache('https://github.com/foo/slow.git');

    // clone 尚未返回时，事件循环必须仍然活着：一个并发的微/宏任务能照常推进。
    let concurrentRan = false;
    await new Promise<void>((r) => setTimeout(() => { concurrentRan = true; r(); }, 0));
    expect(concurrentRan).toBe(true);

    // 放行 clone，整体顺利完成（证明 await 让出了事件循环而非同步阻塞）。
    release();
    await expect(clonePromise).resolves.toMatchObject({
      cachePath: expect.stringContaining('/repos/cache/github.com/foo/slow.git'),
    });
  });
});

// ============================================================
// cleanupTmpDirs
// ============================================================

describe('cleanupTmpDirs', () => {
  it('should remove .tmp-* directories', () => {
    mockExistsSync.mockReturnValue(true);

    // First call: /repos/cache entries, second call: /tmp/workspaces entries
    // Subsequent calls for recursion into normal-dir: return empty
    let callCount = 0;
    mockReaddirSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // /repos/cache
        return [
          { name: 'repo.git.tmp-abc123', isDirectory: () => true },
          { name: 'file.txt', isDirectory: () => false },
        ];
      }
      if (callCount === 2) {
        // /tmp/workspaces
        return [
          { name: 'workspace.tmp-def456', isDirectory: () => true },
        ];
      }
      return [];
    });

    const cleaned = cleanupTmpDirs();

    expect(cleaned).toBe(2);
    expect(mockRmSync).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// cleanupExpiredCaches
// ============================================================

describe('cleanupExpiredCaches', () => {
  it('should remove .git caches older than maxAgeDays', () => {
    mockExistsSync.mockReturnValue(true);

    // 3-level structure: cacheDir → github.com → foo → bar.git
    let callCount = 0;
    mockReaddirSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return [{ name: 'github.com', isDirectory: () => true }]; // cacheDir
      if (callCount === 2) return [{ name: 'foo', isDirectory: () => true }];         // host
      if (callCount === 3) return [{ name: 'bar.git', isDirectory: () => true }];     // owner
      return []; // empty checks after cleanup
    });

    const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days ago
    mockStatSync.mockReturnValue({ mtimeMs: oldTime });

    const cleaned = cleanupExpiredCaches();

    expect(cleaned).toBe(1);
    expect(mockRmSync).toHaveBeenCalled();
  });

  it('should keep recent .git caches', () => {
    mockExistsSync.mockReturnValue(true);

    let callCount = 0;
    mockReaddirSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return [{ name: 'github.com', isDirectory: () => true }];
      if (callCount === 2) return [{ name: 'foo', isDirectory: () => true }];
      if (callCount === 3) return [{ name: 'bar.git', isDirectory: () => true }];
      return [{ name: 'bar.git', isDirectory: () => true }]; // not empty
    });

    const recentTime = Date.now() - (1 * 24 * 60 * 60 * 1000); // 1 day ago
    mockStatSync.mockReturnValue({ mtimeMs: recentTime });

    const cleaned = cleanupExpiredCaches();

    expect(cleaned).toBe(0);
  });
});
