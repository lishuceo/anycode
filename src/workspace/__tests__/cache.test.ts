// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
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

import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { repoUrlToCachePath, sanitizeRepoUrl, ensureBareCache, cleanupTmpDirs, cleanupExpiredCaches } from '../cache.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockRenameSync = vi.mocked(renameSync);
const mockRmSync = vi.mocked(rmSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
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
  it('should create bare clone when cache does not exist', () => {
    mockExistsSync.mockImplementation((p) => {
      // parent dir exists, cache path does not
      if (String(p).endsWith('foo')) return true;
      return false;
    });

    const result = ensureBareCache('https://github.com/foo/bar.git');

    expect(result).toContain('/repos/cache/github.com/foo/bar.git');

    // Should call git clone --bare
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const args = mockExecFileSync.mock.calls[0][1];
    expect(args).toContain('clone');
    expect(args).toContain('--bare');
    expect(args).toContain('--config');
    expect(args).toContain('core.hooksPath=/dev/null');
    expect(args).toContain('--no-recurse-submodules');

    // Should rename tmp dir
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
  });

  it('should fetch when cache exists and is stale', () => {
    mockExistsSync.mockReturnValue(true);

    ensureBareCache('https://github.com/foo/bar.git');

    // Should call git fetch --all
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const args = mockExecFileSync.mock.calls[0][1];
    expect(args).toContain('fetch');
    expect(args).toContain('--all');
  });

  it('should skip fetch when recently fetched', () => {
    // Cache exists for both calls
    mockExistsSync.mockReturnValue(true);

    // First call: fetches
    ensureBareCache('https://github.com/foo/qux.git');
    const fetchCalls = mockExecFileSync.mock.calls.filter(
      c => (c[1] as string[]).includes('fetch'),
    );
    expect(fetchCalls).toHaveLength(1);

    mockExecFileSync.mockClear();

    // Second call with same URL: should skip fetch (within interval)
    ensureBareCache('https://github.com/foo/qux.git');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('should cleanup tmp dir on clone failure', () => {
    mockExistsSync.mockImplementation((p) => {
      if (String(p).endsWith('foo')) return true;
      // tmp dir exists for cleanup
      if (String(p).includes('.tmp-')) return true;
      return false;
    });

    mockExecFileSync.mockImplementation(() => {
      throw new Error('clone failed');
    });

    expect(() => ensureBareCache('https://github.com/foo/bar.git'))
      .toThrow('bare clone 失败');

    // Should attempt to clean up tmp dir
    expect(mockRmSync).toHaveBeenCalled();
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
  it('should remove caches older than maxAgeDays', () => {
    mockExistsSync.mockReturnValue(true);

    // Simulate host directory with one old cache
    mockReaddirSync
      .mockReturnValueOnce([{ name: 'github.com', isDirectory: () => true }])  // cacheDir
      .mockReturnValueOnce([{ name: 'foo', isDirectory: () => true }])          // host dir
      .mockReturnValueOnce([]);  // empty after cleanup check

    const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days ago
    mockStatSync.mockReturnValue({ atimeMs: oldTime });

    const cleaned = cleanupExpiredCaches();

    expect(cleaned).toBe(1);
    expect(mockRmSync).toHaveBeenCalled();
  });

  it('should keep recent caches', () => {
    mockExistsSync.mockReturnValue(true);

    mockReaddirSync
      .mockReturnValueOnce([{ name: 'github.com', isDirectory: () => true }])
      .mockReturnValueOnce([{ name: 'foo', isDirectory: () => true }])
      .mockReturnValueOnce([{ name: 'foo', isDirectory: () => true }]); // not empty

    const recentTime = Date.now() - (1 * 24 * 60 * 60 * 1000); // 1 day ago
    mockStatSync.mockReturnValue({ atimeMs: recentTime });

    const cleaned = cleanupExpiredCaches();

    expect(cleaned).toBe(0);
  });
});
