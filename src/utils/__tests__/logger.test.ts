import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock config before importing logger
const testLogDir = join(tmpdir(), `logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock('../../config.js', () => ({
  config: {
    server: {
      logLevel: 'info',
      nodeEnv: 'test',
      logDir: testLogDir,
      logMaxDays: 7,
    },
  },
}));

// Now import the actual module (uses mocked config)
const { cleanupOldLogs, LOG_FILE, LOG_DIR } = await import('../logger.js');

function setFileMtime(filePath: string, daysAgo: number): void {
  const time = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(filePath, time, time);
}

describe('cleanupOldLogs', () => {
  beforeEach(() => {
    mkdirSync(testLogDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test files but keep the directory (logger may still reference it)
    if (existsSync(testLogDir)) {
      for (const f of readdirSync(testLogDir)) {
        if (f !== `anycode-${new Date().toISOString().slice(0, 10)}.log`) {
          rmSync(join(testLogDir, f), { force: true });
        }
      }
    }
  });

  it('should remove log files older than maxDays', () => {
    const oldFile = join(testLogDir, 'anycode-2026-01-01.log');
    writeFileSync(oldFile, 'old log content');
    setFileMtime(oldFile, 10);

    const removed = cleanupOldLogs(7);

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(oldFile)).toBe(false);
  });

  it('should not remove files within maxDays', () => {
    const recentFile = join(testLogDir, 'anycode-recent.log');
    writeFileSync(recentFile, 'recent content');
    setFileMtime(recentFile, 3);

    const removed = cleanupOldLogs(7);

    expect(removed).toBe(0);
    expect(existsSync(recentFile)).toBe(true);
  });

  it('should skip non-anycode log files (e.g. PM2 logs)', () => {
    const pm2File = join(testLogDir, 'pm2-out.log');
    writeFileSync(pm2File, 'pm2 log');
    setFileMtime(pm2File, 30);

    const removed = cleanupOldLogs(7);

    expect(removed).toBe(0);
    expect(existsSync(pm2File)).toBe(true);
  });

  it('should skip non-.log files', () => {
    const txtFile = join(testLogDir, 'readme.txt');
    writeFileSync(txtFile, 'not a log');
    setFileMtime(txtFile, 30);

    const removed = cleanupOldLogs(7);

    expect(removed).toBe(0);
    expect(existsSync(txtFile)).toBe(true);
  });

  it('should remove multiple old files', () => {
    const files = ['anycode-a.log', 'anycode-b.log', 'anycode-c.log'];
    for (const f of files) {
      const path = join(testLogDir, f);
      writeFileSync(path, 'content');
      setFileMtime(path, 15);
    }

    const removed = cleanupOldLogs(7);
    expect(removed).toBe(3);
  });
});

describe('logger exports', () => {
  it('should export LOG_FILE and LOG_DIR as strings', () => {
    expect(typeof LOG_FILE).toBe('string');
    expect(typeof LOG_DIR).toBe('string');
    expect(LOG_FILE).toMatch(/anycode-\d{4}-\d{2}-\d{2}\.log$/);
  });
});
