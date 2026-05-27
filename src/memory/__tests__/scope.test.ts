import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockConfig } = vi.hoisted(() => {
  const mockConfig = {
    claude: { defaultWorkDir: '' },
    repoCache: { dir: '' },
  };
  return { mockConfig };
});

vi.mock('../../config.js', () => ({ config: mockConfig }));

import { resolveRepositoryForCwd, isLocalRepository } from '../scope.js';

describe('resolveRepositoryForCwd', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-scope-test-'));
    mockConfig.claude.defaultWorkDir = tempDir;
    mockConfig.repoCache.dir = join(tempDir, '.repo-cache');
    mkdirSync(mockConfig.repoCache.dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null for missing path', () => {
    expect(resolveRepositoryForCwd('/no/such/path/xyz')).toBeNull();
  });

  it('returns null for undefined/null/empty', () => {
    expect(resolveRepositoryForCwd(undefined)).toBeNull();
    expect(resolveRepositoryForCwd(null)).toBeNull();
    expect(resolveRepositoryForCwd('')).toBeNull();
  });

  it('returns canonical URL from git remote origin (HTTPS)', () => {
    const repoDir = join(tempDir, 'my-repo');
    mkdirSync(repoDir, { recursive: true });
    execSync('git init -q', { cwd: repoDir });
    execSync('git remote add origin https://github.com/taptap/maker.git', { cwd: repoDir });

    const result = resolveRepositoryForCwd(repoDir);
    expect(result).toBe('https://github.com/taptap/maker');
  });

  it('returns canonical URL from git remote origin (SSH)', () => {
    const repoDir = join(tempDir, 'ssh-repo');
    mkdirSync(repoDir, { recursive: true });
    execSync('git init -q', { cwd: repoDir });
    execSync('git remote add origin git@github.com:lishuceo/anycode.git', { cwd: repoDir });

    const result = resolveRepositoryForCwd(repoDir);
    expect(result).toBe('https://github.com/lishuceo/anycode');
  });

  it('walks up to find .git in parent', () => {
    const repoDir = join(tempDir, 'parent-repo');
    const subDir = join(repoDir, 'src', 'nested');
    mkdirSync(subDir, { recursive: true });
    execSync('git init -q', { cwd: repoDir });
    execSync('git remote add origin https://github.com/foo/bar.git', { cwd: repoDir });

    const result = resolveRepositoryForCwd(subDir);
    expect(result).toBe('https://github.com/foo/bar');
  });

  it('derives canonical URL from bare cache path', () => {
    const bareDir = join(mockConfig.repoCache.dir, 'github.com', 'taptap', 'maker.git');
    mkdirSync(bareDir, { recursive: true });

    const result = resolveRepositoryForCwd(bareDir);
    expect(result).toBe('https://github.com/taptap/maker');
  });

  it('falls back to local:// when no git and not in cache', () => {
    const plainDir = join(tempDir, 'plain');
    mkdirSync(plainDir, { recursive: true });

    const result = resolveRepositoryForCwd(plainDir);
    expect(result).toMatch(/^local:\/\//);
    expect(result).toContain('plain');
  });

  it('falls back to local://<gitDir> when git has no origin remote', () => {
    const repoDir = join(tempDir, 'no-remote');
    mkdirSync(repoDir, { recursive: true });
    execSync('git init -q', { cwd: repoDir });

    const result = resolveRepositoryForCwd(repoDir);
    expect(isLocalRepository(result)).toBe(true);
    expect(result).toContain('no-remote');
  });

  it('different worktrees of same repo resolve to same canonical URL', () => {
    // Main repo
    const repoDir = join(tempDir, 'main');
    mkdirSync(repoDir, { recursive: true });
    execSync('git init -q -b main', { cwd: repoDir });
    execSync('git remote add origin https://github.com/foo/bar.git', { cwd: repoDir });
    writeFileSync(join(repoDir, 'README.md'), 'init');
    execSync('git -c user.email=t@t -c user.name=t add . && git -c user.email=t@t -c user.name=t commit -q -m init', {
      cwd: repoDir,
      shell: '/bin/bash',
    });

    // Add a worktree
    const wtDir = join(tempDir, 'wt-branch');
    execSync(`git worktree add -q -b feat/test ${wtDir}`, { cwd: repoDir });

    const mainResult = resolveRepositoryForCwd(repoDir);
    const wtResult = resolveRepositoryForCwd(wtDir);
    expect(mainResult).toBe('https://github.com/foo/bar');
    expect(wtResult).toBe('https://github.com/foo/bar');
  });
});

describe('isLocalRepository', () => {
  it('detects local:// prefix', () => {
    expect(isLocalRepository('local:///root/dev/foo')).toBe(true);
  });

  it('rejects canonical URLs', () => {
    expect(isLocalRepository('https://github.com/foo/bar')).toBe(false);
  });

  it('handles null/undefined', () => {
    expect(isLocalRepository(null)).toBe(false);
    expect(isLocalRepository(undefined)).toBe(false);
  });
});
