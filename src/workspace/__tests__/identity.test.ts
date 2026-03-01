// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: {
    repoCache: {
      dir: '/repos/cache',
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
import { getRepoIdentity, clearIdentityCache } from '../identity.js';

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  clearIdentityCache();
});

describe('getRepoIdentity', () => {
  it('should normalize HTTPS remote URL via repoUrlToCachePath', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('https://github.com/org/repo.git\n'));

    const identity = getRepoIdentity('/tmp/workspaces/repo-feat-abc123');

    expect(identity).toBe('github.com/org/repo.git');
  });

  it('should normalize SSH remote URL via repoUrlToCachePath', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('git@github.com:org/repo.git\n'));

    const identity = getRepoIdentity('/tmp/workspaces/repo-feat-def456');

    expect(identity).toBe('github.com/org/repo.git');
  });

  it('should strip REPO_CACHE_DIR prefix for bare cache path', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/repos/cache/github.com/org/repo.git\n'));

    const identity = getRepoIdentity('/tmp/workspaces/repo-readonly-aaa111');

    expect(identity).toBe('github.com/org/repo.git');
  });

  it('should resolve local path remote to absolute path', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/home/ubuntu/projects/myrepo\n'));

    const identity = getRepoIdentity('/tmp/workspaces/myrepo-feat-bbb222');

    expect(identity).toBe('/home/ubuntu/projects/myrepo');
  });

  it('should fall back to workDir when git config fails (not a git repo)', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    const identity = getRepoIdentity('/home/ubuntu/projects/plain-dir');

    expect(identity).toBe('/home/ubuntu/projects/plain-dir');
  });

  it('should fall back to workDir when remote URL is empty', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('\n'));

    const identity = getRepoIdentity('/home/ubuntu/projects/no-remote');

    expect(identity).toBe('/home/ubuntu/projects/no-remote');
  });

  it('should cache results for the same workDir', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('https://github.com/org/repo.git\n'));

    const id1 = getRepoIdentity('/tmp/workspaces/repo-feat-ccc333');
    const id2 = getRepoIdentity('/tmp/workspaces/repo-feat-ccc333');

    expect(id1).toBe(id2);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('should produce same identity for different clones of the same remote repo', () => {
    // Writable clone: remote set to original URL
    mockExecFileSync.mockReturnValue(Buffer.from('https://github.com/org/repo.git\n'));
    const writableIdentity = getRepoIdentity('/tmp/workspaces/repo-feat-aaa111');

    clearIdentityCache();

    // Readonly clone: remote points to bare cache
    mockExecFileSync.mockReturnValue(Buffer.from('/repos/cache/github.com/org/repo.git\n'));
    const readonlyIdentity = getRepoIdentity('/tmp/workspaces/repo-readonly-bbb222');

    expect(writableIdentity).toBe(readonlyIdentity);
    expect(writableIdentity).toBe('github.com/org/repo.git');
  });

  it('should handle remote URL normalization failure gracefully', () => {
    // An unparseable remote URL — resolved relative to workDir
    mockExecFileSync.mockReturnValue(Buffer.from('not-a-valid-url\n'));

    const identity = getRepoIdentity('/tmp/workspaces/weird-repo');

    // Falls through to path resolution: resolve(workDir, remoteUrl)
    expect(identity).toBe('/tmp/workspaces/weird-repo/not-a-valid-url');
  });

  it('should resolve relative remote path against workDir, not process.cwd', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('../other-repo\n'));

    const identity = getRepoIdentity('/tmp/workspaces/myrepo-feat-aaa111');

    expect(identity).toBe('/tmp/workspaces/other-repo');
  });
});
