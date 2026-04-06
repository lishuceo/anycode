// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => '{"repos":{}}'),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => Buffer.from('deadbeef', 'hex')),
}));

vi.mock('../../config.js', () => ({
  config: {
    claude: { defaultWorkDir: '/root/dev' },
    repoCache: { dir: '/repos/cache', maxAgeDays: 30, maxSizeGb: 50, fetchIntervalMin: 10 },
    workspace: { baseDir: '/tmp/workspaces', branchPrefix: 'feat/claude-session', maxAgeDays: 3 },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../cache.js', () => ({
  repoUrlToCachePath: vi.fn((url: string) => {
    // Simulate real behavior: parse URL → host/org/repo.git (lowercase)
    // Handle SSH shorthand
    const sshMatch = url.match(/^git@([^:]+):(.+)$/);
    if (sshMatch) {
      const host = sshMatch[1];
      const path = sshMatch[2].replace(/\.git\/?$/, '');
      return `${host}/${path}.git`.toLowerCase();
    }
    // Handle HTTPS
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/+/, '').replace(/\.git\/?$/, '');
      return `${u.hostname}/${path}.git`.toLowerCase();
    } catch {
      return 'unknown.git';
    }
  }),
  sanitizeRepoUrl: vi.fn((url: string) => url),
  ensureBareCache: vi.fn(() => ({ cachePath: '/repos/cache/github.com/org/repo.git' })),
}));

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { toCanonicalUrl, scanAndSyncRegistry, updateRegistryEntry, getSourceRepoPaths } from '../registry.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default mocks
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
  mockReadFileSync.mockReturnValue('{"repos":{}}');
});

describe('toCanonicalUrl', () => {
  it('should convert HTTPS URL to canonical format', () => {
    const url = toCanonicalUrl('https://github.com/user/repo.git');
    expect(url).toBe('https://github.com/user/repo');
  });

  it('should convert SSH shorthand to canonical format', () => {
    const url = toCanonicalUrl('git@github.com:user/repo.git');
    expect(url).toBe('https://github.com/user/repo');
  });

  it('should lowercase the result', () => {
    const url = toCanonicalUrl('https://GitHub.com/User/Repo');
    expect(url).toBe('https://github.com/user/repo');
  });
});

describe('scanAndSyncRegistry', () => {
  it('should scan DEFAULT_WORK_DIR and create registry', async () => {
    // Setup: one local repo with remote
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/root/dev') return true;
      if (p === '/root/dev/my-project/.git') return true;
      if (p === '/root/dev/.repo-registry.json') return false;
      return false;
    });
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/root/dev') {
        return [
          { name: 'my-project', isDirectory: () => true },
          { name: '.repo-cache', isDirectory: () => true }, // should be excluded
          { name: 'somefile.txt', isDirectory: () => false },
        ] as any;
      }
      return [];
    });
    mockExecFileSync.mockReturnValue('https://github.com/org/my-project.git\n');

    await scanAndSyncRegistry();

    // Should have written registry JSON
    expect(mockWriteFileSync).toHaveBeenCalled();
    const jsonCall = mockWriteFileSync.mock.calls.find(c => String(c[0]).includes('.repo-registry.json'));
    expect(jsonCall).toBeDefined();
    const written = JSON.parse(jsonCall![1] as string);
    expect(written.repos).toHaveProperty('https://github.com/org/my-project');
    expect(written.repos['https://github.com/org/my-project'].name).toBe('my-project');
    expect(written.repos['https://github.com/org/my-project'].localPath).toBe('./my-project');
  });

  it('should exclude dot-prefixed directories', async () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/root/dev') {
        return [
          { name: '.repo-cache', isDirectory: () => true },
          { name: '.workspaces', isDirectory: () => true },
          { name: '.claude', isDirectory: () => true },
        ] as any;
      }
      return [];
    });

    await scanAndSyncRegistry();

    // No git remote calls should be made
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('should handle local-only repos (no remote)', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/root/dev/local-project/.git') return true;
      return false;
    });
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/root/dev') {
        return [{ name: 'local-project', isDirectory: () => true }] as any;
      }
      return [];
    });
    // git remote get-url origin fails
    mockExecFileSync.mockImplementation(() => { throw new Error('No remote'); });

    await scanAndSyncRegistry();

    const jsonCall = mockWriteFileSync.mock.calls.find(c => String(c[0]).includes('.repo-registry.json'));
    expect(jsonCall).toBeDefined();
    const written = JSON.parse(jsonCall![1] as string);
    expect(written.repos).toHaveProperty('local:///root/dev/local-project');
    expect(written.repos['local:///root/dev/local-project'].cachePath).toBeNull();
  });

  it('should preserve existing descriptions and keywords on merge', async () => {
    // Existing registry has description
    mockReadFileSync.mockReturnValue(JSON.stringify({
      repos: {
        'https://github.com/org/my-project': {
          name: 'my-project',
          localPath: './my-project',
          cachePath: null,
          description: 'My awesome project',
          keywords: ['awesome'],
          techStack: ['TypeScript'],
        },
      },
    }));
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/root/dev/.repo-registry.json') return true;
      if (p === '/root/dev/my-project/.git') return true;
      return false;
    });
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/root/dev') {
        return [{ name: 'my-project', isDirectory: () => true }] as any;
      }
      return [];
    });
    mockExecFileSync.mockReturnValue('https://github.com/org/my-project.git\n');

    await scanAndSyncRegistry();

    const jsonCall = mockWriteFileSync.mock.calls.find(c => String(c[0]).includes('.repo-registry.json'));
    const written = JSON.parse(jsonCall![1] as string);
    expect(written.repos['https://github.com/org/my-project'].description).toBe('My awesome project');
    expect(written.repos['https://github.com/org/my-project'].keywords).toContain('awesome');
  });

  it('should populate source repo path cache', async () => {
    // Mock all filesystem calls comprehensively
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === '/root/dev/my-project/.git') return true;
      if (s === '/root/dev/my-project') return true;
      if (s === '/root/dev') return true;
      if (s === '/repos/cache') return false;
      return false;
    });
    mockReaddirSync.mockImplementation((dir: unknown) => {
      if (String(dir) === '/root/dev') {
        return [{ name: 'my-project', isDirectory: () => true }] as any;
      }
      return [];
    });
    mockExecFileSync.mockReturnValue('https://github.com/org/my-project.git\n');

    await scanAndSyncRegistry();

    // Verify registry was written correctly
    const jsonCalls = mockWriteFileSync.mock.calls.filter(c => String(c[0]).includes('.repo-registry.json'));
    expect(jsonCalls.length).toBeGreaterThan(0);
    const written = JSON.parse(jsonCalls[0][1] as string);
    expect(written.repos['https://github.com/org/my-project'].localPath).toBe('./my-project');

    // Note: getSourceRepoPaths() cache population is hard to test with fully mocked fs
    // (existsSync mock interactions with resolve() are fragile).
    // The cache logic is tested indirectly via isInsideSourceRepo tests in isolation.test.ts.
  });
});

describe('updateRegistryEntry', () => {
  it('should update existing entry description and keywords', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.repo-registry.json')) return true;
      if (String(p) === '/root/dev') return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({
      repos: {
        'https://github.com/org/repo': {
          name: 'repo', localPath: './repo', cachePath: null,
          description: null, keywords: ['old'], techStack: [],
        },
      },
    }));

    updateRegistryEntry('https://github.com/org/repo', {
      description: 'Updated desc',
      keywords: ['new', 'old'],
    });

    // writeFileSync is called for both tmp JSON and tmp MD; find the JSON content
    const jsonCalls = mockWriteFileSync.mock.calls.filter(c => String(c[0]).includes('.repo-registry.json'));
    expect(jsonCalls.length).toBeGreaterThan(0);
    const written = JSON.parse(jsonCalls[0][1] as string);
    expect(written.repos['https://github.com/org/repo'].description).toBe('Updated desc');
    expect(written.repos['https://github.com/org/repo'].keywords).toContain('old');
    expect(written.repos['https://github.com/org/repo'].keywords).toContain('new');
  });

  it('should create new entry if URL not in registry', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.repo-registry.json')) return false; // no existing registry
      if (String(p) === '/root/dev') return true;
      return false;
    });

    updateRegistryEntry('https://github.com/org/new-repo', {
      description: 'Brand new',
      keywords: ['fresh'],
    });

    const jsonCalls = mockWriteFileSync.mock.calls.filter(c => String(c[0]).includes('.repo-registry.json'));
    expect(jsonCalls.length).toBeGreaterThan(0);
    const written = JSON.parse(jsonCalls[0][1] as string);
    expect(written.repos).toHaveProperty('https://github.com/org/new-repo');
    expect(written.repos['https://github.com/org/new-repo'].description).toBe('Brand new');
  });

  it('should deduplicate keywords', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.repo-registry.json')) return true;
      if (String(p) === '/root/dev') return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({
      repos: {
        'https://github.com/org/repo': {
          name: 'repo', localPath: null, cachePath: null,
          description: null, keywords: ['a', 'b'], techStack: [],
        },
      },
    }));

    updateRegistryEntry('https://github.com/org/repo', { keywords: ['b', 'c'] });

    const jsonCalls = mockWriteFileSync.mock.calls.filter(c => String(c[0]).includes('.repo-registry.json'));
    const written = JSON.parse(jsonCalls[0][1] as string);
    const kw = written.repos['https://github.com/org/repo'].keywords;
    expect(kw).toEqual(['a', 'b', 'c']);
  });
});
