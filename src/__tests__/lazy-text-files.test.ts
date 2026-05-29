/**
 * Tests for lazy loading of large text files.
 *
 * Small text files (≤64KB) are embedded inline in the prompt.
 * Large text files (>64KB) are saved to a cache dir and the prompt only
 * carries a path pointer + instructions to use the Read tool's offset/limit.
 *
 * Covers both: shared file-cache helpers and the history-file processor.
 */
// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockDownloadMessageFile = vi.fn();

vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    downloadMessageFile: (...args: unknown[]) => mockDownloadMessageFile(...args),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { saveMessageFileToCache, cleanupOldDownloads, DOWNLOAD_DIR } from '../feishu/file-cache.js';
import { _testDownloadHistoryFiles as downloadHistoryFiles } from '../feishu/event-handler.js';

describe('file-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    // Best-effort cleanup of any leftovers from this test
    try {
      rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('saveMessageFileToCache writes buffer and returns absolute path', async () => {
    const buf = Buffer.from('hello-content');
    const filePath = await saveMessageFileToCache('om_test_save', 'file_test_save', buf, 'notes.txt');

    expect(filePath.startsWith(DOWNLOAD_DIR)).toBe(true);
    expect(filePath.endsWith('.txt')).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).size).toBe(buf.length);
  });

  it('saveMessageFileToCache sanitizes filename, drops weird extensions', async () => {
    const buf = Buffer.from('x');
    const filePath = await saveMessageFileToCache('om_a/b', 'file_c:d', buf, 'weird.ext-with-bad-stuff!!');
    // No slashes/colons leak through; weird ext is dropped
    const base = filePath.slice(DOWNLOAD_DIR.length + 1);
    expect(base).not.toMatch(/[/:!]/);
    expect(base.endsWith('.ext-with-bad-stuff!!')).toBe(false);
  });

  it('cleanupOldDownloads removes files older than cutoff, keeps fresh ones', async () => {
    const fresh = await saveMessageFileToCache('om_fresh', 'file_fresh', Buffer.from('new'), 'fresh.txt');
    const stale = await saveMessageFileToCache('om_stale', 'file_stale', Buffer.from('old'), 'stale.txt');
    // Backdate stale file by 25 hours
    const oldTime = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, oldTime, oldTime);

    const cleaned = await cleanupOldDownloads(24 * 60 * 60 * 1000);
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('cleanupOldDownloads is a no-op when dir does not exist', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fc-empty-'));
    rmSync(tmp, { recursive: true, force: true });
    // Different dir — cleanup on DOWNLOAD_DIR shouldn't throw even if missing
    const cleaned = await cleanupOldDownloads(1);
    expect(typeof cleaned).toBe('number');
  });
});

describe('downloadHistoryFiles lazy text threshold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMsg(id: string, fileRefs?: Array<{ fileKey: string; fileName: string }>) {
    return { messageId: id, ...(fileRefs ? { fileRefs } : {}) };
  }

  it('embeds small text files (≤64KB) inline', async () => {
    const small = Buffer.from('console.log("tiny")');
    mockDownloadMessageFile.mockResolvedValue(small);

    const result = await downloadHistoryFiles([
      makeMsg('t1', [{ fileKey: 'fk_small', fileName: 'tiny.ts' }]),
    ], 0);

    expect(result.fileTexts).toHaveLength(1);
    expect(result.fileTexts[0]).toContain('console.log("tiny")');
    expect(result.fileTexts[0]).not.toContain('Read 工具');
  });

  it('writes large text files (>64KB) to cache and injects path metadata only', async () => {
    const big = Buffer.alloc(80 * 1024, 'a'); // 80KB
    mockDownloadMessageFile.mockResolvedValue(big);

    const result = await downloadHistoryFiles([
      makeMsg('t_big', [{ fileKey: 'fk_big', fileName: 'big.log' }]),
    ], 0);

    expect(result.fileTexts).toHaveLength(1);
    const meta = result.fileTexts[0];
    expect(meta).toContain('big.log');
    expect(meta).toContain('Read 工具');
    expect(meta).toContain(DOWNLOAD_DIR);
    // raw content is NOT embedded
    expect(meta).not.toContain('aaaa');

    // The path mentioned in metadata should actually exist on disk
    const match = meta.match(/已保存到本地: (\S+)/);
    expect(match).not.toBeNull();
    expect(existsSync(match![1])).toBe(true);
  });

  it('drops history text files above 30MB hard cap', async () => {
    const huge = Buffer.alloc(31 * 1024 * 1024, 'a');
    mockDownloadMessageFile.mockResolvedValue(huge);

    const result = await downloadHistoryFiles([
      makeMsg('t_huge', [{ fileKey: 'fk_huge', fileName: 'huge.log' }]),
    ], 0);

    expect(result.fileTexts).toHaveLength(0);
    expect(result.documents).toHaveLength(0);
  });
});
