import { describe, it, expect } from 'vitest';
import {
  resolveRepositoryForMemory,
  buildRepositoryContextSuffix,
} from '../extractor.js';

describe('resolveRepositoryForMemory', () => {
  const REPO = 'https://github.com/taptap/maker';

  it('attaches project-scoped types to the session repository', () => {
    expect(resolveRepositoryForMemory('fact', REPO)).toBe(REPO);
    expect(resolveRepositoryForMemory('decision', REPO)).toBe(REPO);
    expect(resolveRepositoryForMemory('relation', REPO)).toBe(REPO);
  });

  it('returns null for user-scoped types regardless of session repo', () => {
    expect(resolveRepositoryForMemory('preference', REPO)).toBeNull();
  });

  it('returns null for chat-scoped types regardless of session repo', () => {
    expect(resolveRepositoryForMemory('state', REPO)).toBeNull();
  });

  it('returns null when session has no repo, even for project-scoped types', () => {
    expect(resolveRepositoryForMemory('fact', null)).toBeNull();
    expect(resolveRepositoryForMemory('decision', null)).toBeNull();
  });

  it('treats local:// as unattached (no repo binding)', () => {
    expect(resolveRepositoryForMemory('fact', 'local:///root/dev/scratch')).toBeNull();
  });
});

describe('buildRepositoryContextSuffix', () => {
  it('includes the repo URL when bound', () => {
    const suffix = buildRepositoryContextSuffix('https://github.com/taptap/maker');
    expect(suffix).toContain('https://github.com/taptap/maker');
    expect(suffix).toContain('当前仓库');
    expect(suffix).toContain('不要提取');
  });

  it('warns that no repo is bound when null', () => {
    const suffix = buildRepositoryContextSuffix(null);
    expect(suffix).toContain('没有绑定到具体仓库');
    expect(suffix).toContain('不要提取');
  });

  it('treats local:// as unbound', () => {
    const suffix = buildRepositoryContextSuffix('local:///tmp/foo');
    expect(suffix).toContain('没有绑定到具体仓库');
    expect(suffix).not.toContain('local://');
  });
});
