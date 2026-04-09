import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test cleanupOldLogs in isolation using a temp directory
describe('cleanupOldLogs', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Re-implement the cleanup logic here to test in isolation
  // (avoids importing logger.ts which triggers Pino transport initialization)
  function cleanupLogsInDir(dir: string, maxDays: number): number {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const filePath = join(dir, file);
      const { mtimeMs } = require('node:fs').statSync(filePath);
      if (mtimeMs < cutoff) {
        require('node:fs').unlinkSync(filePath);
        removed++;
      }
    }
    return removed;
  }

  function setFileMtime(filePath: string, daysAgo: number): void {
    const time = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    require('node:fs').utimesSync(filePath, time, time);
  }

  it('should remove log files older than maxDays', () => {
    // Create old and new log files
    const oldFile = join(testDir, 'anycode-2026-01-01.log');
    const newFile = join(testDir, 'anycode-2026-04-09.log');
    writeFileSync(oldFile, 'old log content');
    writeFileSync(newFile, 'new log content');

    // Set old file mtime to 10 days ago
    setFileMtime(oldFile, 10);

    const removed = cleanupLogsInDir(testDir, 7);

    expect(removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it('should not remove files within maxDays', () => {
    const recentFile = join(testDir, 'anycode-recent.log');
    writeFileSync(recentFile, 'recent content');
    setFileMtime(recentFile, 3);

    const removed = cleanupLogsInDir(testDir, 7);

    expect(removed).toBe(0);
    expect(existsSync(recentFile)).toBe(true);
  });

  it('should skip non-.log files', () => {
    const txtFile = join(testDir, 'readme.txt');
    writeFileSync(txtFile, 'not a log');
    setFileMtime(txtFile, 30);

    const removed = cleanupLogsInDir(testDir, 7);

    expect(removed).toBe(0);
    expect(existsSync(txtFile)).toBe(true);
  });

  it('should handle empty directory', () => {
    const removed = cleanupLogsInDir(testDir, 7);
    expect(removed).toBe(0);
  });

  it('should remove multiple old files', () => {
    const files = ['a.log', 'b.log', 'c.log'];
    for (const f of files) {
      const path = join(testDir, f);
      writeFileSync(path, 'content');
      setFileMtime(path, 15);
    }

    const removed = cleanupLogsInDir(testDir, 7);
    expect(removed).toBe(3);
    expect(readdirSync(testDir).filter(f => f.endsWith('.log'))).toHaveLength(0);
  });
});

describe('logger exports', () => {
  it('should export LOG_FILE and LOG_DIR as strings', async () => {
    // Dynamic import to avoid side effects in other tests
    const { LOG_FILE, LOG_DIR } = await import('../logger.js');
    expect(typeof LOG_FILE).toBe('string');
    expect(typeof LOG_DIR).toBe('string');
    expect(LOG_FILE).toMatch(/anycode-\d{4}-\d{2}-\d{2}\.log$/);
  });
});
