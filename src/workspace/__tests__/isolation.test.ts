// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  realpathSync: vi.fn((p: string) => p),
  readFileSync: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: {
    claude: { defaultWorkDir: '/root/dev' },
    repoCache: { dir: '/repos/cache' },
    workspace: { baseDir: '/tmp/workspaces', branchPrefix: 'feat/claude-session', maxAgeDays: 3 },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../manager.js', () => ({
  setupWorkspace: vi.fn(),
}));

// Mock registry to control source repo paths cache
const mockSourceRepoPaths = new Set<string>();
vi.mock('../registry.js', () => ({
  getSourceRepoPaths: () => mockSourceRepoPaths,
}));

import { existsSync, realpathSync } from 'node:fs';
import { isInsideSourceRepo } from '../isolation.js';

const mockExistsSync = vi.mocked(existsSync);
const mockRealpathSync = vi.mocked(realpathSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockSourceRepoPaths.clear();
  mockRealpathSync.mockImplementation((p: string) => p as any);
  mockExistsSync.mockReturnValue(false);
});

describe('isInsideSourceRepo', () => {
  describe('with cached source repo paths', () => {
    beforeEach(() => {
      mockSourceRepoPaths.add('/root/dev/my-repo');
      mockSourceRepoPaths.add('/root/dev/another-repo');
    });

    it('should return true for source repo root', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isInsideSourceRepo('/root/dev/my-repo')).toBe(true);
    });

    it('should return true for subdirectory of source repo', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isInsideSourceRepo('/root/dev/my-repo/src/index.ts')).toBe(true);
    });

    it('should return true for deep nested path', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isInsideSourceRepo('/root/dev/my-repo/src/components/Button.tsx')).toBe(true);
    });

    it('should return false for DEFAULT_WORK_DIR itself', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isInsideSourceRepo('/root/dev')).toBe(false);
    });

    it('should return false for path outside DEFAULT_WORK_DIR', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isInsideSourceRepo('/tmp/other/file.ts')).toBe(false);
    });

    it('should return false for WORKSPACE_BASE_DIR paths', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/tmp/workspaces') return true;
        return true;
      });
      mockRealpathSync.mockImplementation((p: string) => p as any);
      expect(isInsideSourceRepo('/tmp/workspaces/my-repo-abc123/file.ts')).toBe(false);
    });

    it('should return false for .repo-cache paths', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/repos/cache') return true;
        return true;
      });
      expect(isInsideSourceRepo('/repos/cache/github.com/org/repo.git/HEAD')).toBe(false);
    });

    it('should return false for non-matching repo', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isInsideSourceRepo('/root/dev/unknown-repo/file.ts')).toBe(false);
    });
  });

  describe('Write new file (path does not exist)', () => {
    beforeEach(() => {
      mockSourceRepoPaths.add('/root/dev/my-repo');
    });

    it('should check parent dir for new files', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/root/dev/my-repo/src/new-file.ts') return false; // file doesn't exist
        if (p === '/root/dev/my-repo/src') return true; // parent exists
        return false;
      });
      expect(isInsideSourceRepo('/root/dev/my-repo/src/new-file.ts')).toBe(true);
    });
  });

  describe('fallback (cache empty)', () => {
    it('should traverse upward to find .git', () => {
      // No cached paths
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/root/dev') return true;
        if (p === '/root/dev/my-repo/src/index.ts') return true;
        if (p === '/root/dev/my-repo/src/.git') return false;
        if (p === '/root/dev/my-repo/.git') return true; // found!
        return false;
      });
      expect(isInsideSourceRepo('/root/dev/my-repo/src/index.ts')).toBe(true);
    });

    it('should return false if no .git found up to projectsDir', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/root/dev') return true;
        if (p === '/root/dev/not-a-repo/file.ts') return true;
        return false; // no .git anywhere
      });
      expect(isInsideSourceRepo('/root/dev/not-a-repo/file.ts')).toBe(false);
    });

    it('should return false when defaultWorkDir does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(isInsideSourceRepo('/root/dev/repo/file.ts')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should return true (fail-closed) when realpathSync throws', () => {
      mockExistsSync.mockReturnValue(true);
      mockRealpathSync.mockImplementation(() => { throw new Error('ENOENT'); });
      // Security: fail-closed — treat unresolvable paths as protected
      expect(isInsideSourceRepo('/root/dev/my-repo/file.ts')).toBe(true);
    });
  });
});
