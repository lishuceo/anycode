// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============================================================
// Mocks
// ============================================================

vi.mock('../../config.js', () => ({
  config: {
    claude: { defaultWorkDir: '/tmp/work', timeoutSeconds: 300, model: 'claude-opus-4-6', thinking: 'adaptive', effort: 'max', maxTurns: 500, maxBudgetUsd: 50, apiBaseUrl: '' },
    repoCache: { dir: '/repos/cache' },
    workspace: { baseDir: '/tmp/workspaces' },
    feishu: { tools: { enabled: false, doc: true, wiki: true, drive: true, bitable: true } },
    cron: { enabled: false },
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

vi.mock('../../workspace/tool.js', () => ({
  createWorkspaceMcpServer: vi.fn(),
}));

vi.mock('../../feishu/tools/index.js', () => ({
  createFeishuToolsMcpServer: vi.fn(),
}));

vi.mock('../../workspace/isolation.js', () => ({
  isAutoWorkspacePath: vi.fn(() => false),
  isServiceOwnRepo: () => false,
  isInsideSourceRepo: vi.fn(() => false),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('../../cron/tool.js', () => ({
  createCronMcpServer: vi.fn(),
}));

vi.mock('../../cron/init.js', () => ({
  getCronScheduler: vi.fn(() => null),
}));

vi.mock('../../memory/init.js', () => ({
  getMemoryStore: vi.fn(() => null),
  getHybridSearch: vi.fn(() => null),
  isMemoryEnabled: vi.fn(() => false),
}));

vi.mock('../../memory/tools/memory-search.js', () => ({
  createMemorySearchMcpServer: vi.fn(),
}));

vi.mock('../../feishu/client.js', () => ({
  feishuClientContext: { getStore: vi.fn(() => undefined) },
}));

// Mock node:child_process execFile
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { initGitHubOrgCache, listKnownOrgs, _resetGitHubOrgCache } from '../executor.js';

// ============================================================
// Tests
// ============================================================

describe('GitHub org auto-discovery', () => {
  beforeEach(() => {
    _resetGitHubOrgCache(null);
    mockExecFile.mockReset();
  });

  describe('initGitHubOrgCache', () => {
    it('should fetch orgs and user login via gh CLI', async () => {
      // Mock two execFile calls: user/orgs and user
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, 'taptap\nEpicGames\n');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, 'lishuceo\n');
        });

      await initGitHubOrgCache();

      // Verify gh was called correctly
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile).toHaveBeenCalledWith(
        'gh', ['api', 'user/orgs', '--jq', '.[].login'],
        expect.objectContaining({ timeout: 10_000 }),
        expect.any(Function),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'gh', ['api', 'user', '--jq', '.login'],
        expect.objectContaining({ timeout: 10_000 }),
        expect.any(Function),
      );

      // Verify cached orgs are available via listKnownOrgs
      const orgs = listKnownOrgs('/nonexistent');
      expect(orgs).toContain('github.com/taptap');
      expect(orgs).toContain('github.com/EpicGames');
      expect(orgs).toContain('github.com/lishuceo');
    });

    it('should deduplicate when user login is also in orgs', async () => {
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, 'myorg\nmyuser\n');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, 'myuser\n');
        });

      await initGitHubOrgCache();

      const orgs = listKnownOrgs('/nonexistent');
      const myuserCount = orgs.filter(o => o === 'github.com/myuser').length;
      expect(myuserCount).toBe(1);
    });

    it('should preserve login when orgs API fails (partial failure)', async () => {
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(new Error('403 Forbidden'));
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, 'lishuceo\n');
        });

      await initGitHubOrgCache();

      const orgs = listKnownOrgs('/nonexistent');
      expect(orgs).toContain('github.com/lishuceo');
    });

    it('should not crash when gh CLI fails completely', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        cb(new Error('gh not found'));
      });

      // Should not throw
      await initGitHubOrgCache();

      // listKnownOrgs should still work (returns empty from nonexistent cache dir)
      const orgs = listKnownOrgs('/nonexistent');
      expect(orgs).toEqual([]);
    });
  });

  describe('listKnownOrgs', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'org-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should discover orgs from cache directory structure', () => {
      // Create cache structure: github.com/taptap/
      mkdirSync(join(tmpDir, 'github.com', 'taptap'), { recursive: true });
      mkdirSync(join(tmpDir, 'github.com', 'facebook'), { recursive: true });

      const orgs = listKnownOrgs(tmpDir);
      expect(orgs).toContain('github.com/taptap');
      expect(orgs).toContain('github.com/facebook');
    });

    it('should merge GitHub API orgs with cache directory orgs', () => {
      // Set up API-discovered orgs
      _resetGitHubOrgCache(['github.com/api-org']);

      // Set up cache directory orgs
      mkdirSync(join(tmpDir, 'github.com', 'cache-org'), { recursive: true });

      const orgs = listKnownOrgs(tmpDir);
      expect(orgs).toContain('github.com/api-org');
      expect(orgs).toContain('github.com/cache-org');
    });

    it('should deduplicate across API and cache sources', () => {
      _resetGitHubOrgCache(['github.com/taptap']);
      mkdirSync(join(tmpDir, 'github.com', 'taptap'), { recursive: true });

      const orgs = listKnownOrgs(tmpDir);
      const count = orgs.filter(o => o === 'github.com/taptap').length;
      expect(count).toBe(1);
    });

    it('should put API-discovered orgs before cache orgs', () => {
      _resetGitHubOrgCache(['github.com/api-first']);
      mkdirSync(join(tmpDir, 'github.com', 'cache-second'), { recursive: true });

      const orgs = listKnownOrgs(tmpDir);
      const apiIdx = orgs.indexOf('github.com/api-first');
      const cacheIdx = orgs.indexOf('github.com/cache-second');
      expect(apiIdx).toBeLessThan(cacheIdx);
    });

    it('should return empty array for nonexistent cache dir', () => {
      const orgs = listKnownOrgs('/nonexistent/path');
      expect(orgs).toEqual([]);
    });
  });
});
