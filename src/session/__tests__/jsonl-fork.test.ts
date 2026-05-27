import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeProjectDir,
  resolveSessionJsonlPath,
  copyJsonlAtomic,
  jsonlFingerprint,
} from '../jsonl-fork.js';

describe('encodeProjectDir', () => {
  it('replaces / and . with -', () => {
    expect(encodeProjectDir('/root/dev/.workspaces/anycode-feat-x')).toBe(
      '-root-dev--workspaces-anycode-feat-x',
    );
  });

  it('handles plain /root/dev', () => {
    expect(encodeProjectDir('/root/dev')).toBe('-root-dev');
  });

  it('absolutizes relative paths', () => {
    const encoded = encodeProjectDir('.');
    expect(encoded.startsWith('-')).toBe(true);
  });
});

describe('resolveSessionJsonlPath', () => {
  it('builds <home>/.claude/projects/<encoded>/<convId>.jsonl', () => {
    const p = resolveSessionJsonlPath('/root/dev', 'abc-123');
    expect(p).toMatch(/\.claude\/projects\/-root-dev\/abc-123\.jsonl$/);
  });
});

describe('copyJsonlAtomic', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'jsonl-fork-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('copies file content via temp file + rename', () => {
    const src = join(workDir, 'src.jsonl');
    const dst = join(workDir, 'sub', 'dst.jsonl');
    writeFileSync(src, '{"a":1}\n{"b":2}\n');

    copyJsonlAtomic(src, dst);

    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('creates parent dir if missing', () => {
    const src = join(workDir, 'src.jsonl');
    const dst = join(workDir, 'a', 'b', 'c.jsonl');
    writeFileSync(src, 'x');

    copyJsonlAtomic(src, dst);

    expect(existsSync(dst)).toBe(true);
  });

  it('throws when source missing', () => {
    expect(() => copyJsonlAtomic(join(workDir, 'nope.jsonl'), join(workDir, 'out.jsonl'))).toThrow(
      /source JSONL not found/,
    );
  });

  it('leaves no .tmp files on success', () => {
    const src = join(workDir, 'src.jsonl');
    const dst = join(workDir, 'dst.jsonl');
    writeFileSync(src, 'data');
    copyJsonlAtomic(src, dst);
    const leftover = readdirSync(workDir).filter((f) => f.includes('.tmp.'));
    expect(leftover).toEqual([]);
  });
});

describe('jsonlFingerprint', () => {
  it('returns undefined for missing file', () => {
    expect(jsonlFingerprint('/nonexistent/path.jsonl')).toBeUndefined();
  });

  it('returns size@mtime for existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'));
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, 'hello');
    const fp = jsonlFingerprint(f);
    expect(fp).toMatch(/^5@\d+/);
    rmSync(dir, { recursive: true });
  });
});
