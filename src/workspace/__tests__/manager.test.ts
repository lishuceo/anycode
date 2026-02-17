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
    expect(result.reused).toBe(false);

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

  it('should clone local repo', () => {
    const result = setupWorkspace({ localPath: '/home/user/projects/my-app' });

    expect(result.repoName).toBe('my-app');
    expect(result.reused).toBe(false);

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
    mockExistsSync.mockImplementation((p) => {
      if (p === '/tmp/workspaces') return true;
      return false;
    });

    setupWorkspace({ repoUrl: 'https://github.com/user/repo' });

    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('should reuse existing workspace directory', () => {
    mockExistsSync.mockReturnValue(true); // baseDir 和 workspacePath 都存在

    const result = setupWorkspace({ repoUrl: 'https://github.com/user/repo' });

    expect(result.reused).toBe(true);
    expect(mockExecFileSync).not.toHaveBeenCalled();
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

  it('should use execFileSync (not execSync) to prevent shell injection', () => {
    setupWorkspace({ repoUrl: 'https://github.com/user/repo; rm -rf /' });

    // execFileSync 传数组参数，不经过 shell 解释
    const cloneCall = mockExecFileSync.mock.calls[0];
    expect(cloneCall[0]).toBe('git');
    // source 作为独立参数传入，不会被 shell 解释
    expect(cloneCall[1]).toContain('https://github.com/user/repo; rm -rf /');
  });

  it('should prefer repoUrl over localPath when both provided', () => {
    const result = setupWorkspace({
      repoUrl: 'https://github.com/user/repo',
      localPath: '/local/path',
    });

    const cloneCall = mockExecFileSync.mock.calls[0];
    expect(cloneCall[1]).toContain('https://github.com/user/repo');
    expect(cloneCall[1]).not.toContain('/local/path');
    expect(result.repoName).toBe('repo');
  });
});
