import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { SessionDatabase } from '../database.js';

describe('SessionDatabase — session_summaries', () => {
  let db: SessionDatabase;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-db-test-'));
    db = new SessionDatabase(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('insertSummary', () => {
    it('should insert a summary without error', () => {
      expect(() => {
        db.insertSummary('chat1', 'user1', '/tmp', 'summary text');
      }).not.toThrow();
    });

    it('should insert multiple summaries for the same user', () => {
      db.insertSummary('chat1', 'user1', '/tmp', 'summary 1');
      db.insertSummary('chat1', 'user1', '/tmp', 'summary 2');
      db.insertSummary('chat1', 'user1', '/tmp', 'summary 3');

      const summaries = db.getRecentSummaries('chat1', 'user1', 10);
      expect(summaries).toHaveLength(3);
    });
  });

  describe('getRecentSummaries', () => {
    it('should return empty array when no summaries exist', () => {
      const summaries = db.getRecentSummaries('chat1', 'user1', 5);
      expect(summaries).toEqual([]);
    });

    it('should return summaries in chronological order (oldest first)', () => {
      db.insertSummary('chat1', 'user1', '/tmp', 'first');
      db.insertSummary('chat1', 'user1', '/tmp', 'second');
      db.insertSummary('chat1', 'user1', '/tmp', 'third');

      const summaries = db.getRecentSummaries('chat1', 'user1', 5);
      expect(summaries).toEqual(['first', 'second', 'third']);
    });

    it('should respect the limit parameter', () => {
      for (let i = 1; i <= 10; i++) {
        db.insertSummary('chat1', 'user1', '/tmp', `summary ${i}`);
      }

      const summaries = db.getRecentSummaries('chat1', 'user1', 3);
      expect(summaries).toHaveLength(3);
      // Should return the 3 most recent, in chronological order
      expect(summaries).toEqual(['summary 8', 'summary 9', 'summary 10']);
    });

    it('should isolate summaries by chatId', () => {
      db.insertSummary('chat1', 'user1', '/tmp', 'chat1 summary');
      db.insertSummary('chat2', 'user1', '/tmp', 'chat2 summary');

      expect(db.getRecentSummaries('chat1', 'user1', 10)).toEqual(['chat1 summary']);
      expect(db.getRecentSummaries('chat2', 'user1', 10)).toEqual(['chat2 summary']);
    });

    it('should isolate summaries by userId', () => {
      db.insertSummary('chat1', 'user1', '/tmp', 'user1 summary');
      db.insertSummary('chat1', 'user2', '/tmp', 'user2 summary');

      expect(db.getRecentSummaries('chat1', 'user1', 10)).toEqual(['user1 summary']);
      expect(db.getRecentSummaries('chat1', 'user2', 10)).toEqual(['user2 summary']);
    });
  });

  describe('cleanOldSummaries', () => {
    it('should return 0 when no summaries to clean', () => {
      const cleaned = db.cleanOldSummaries(30);
      expect(cleaned).toBe(0);
    });

    it('should not clean recent summaries', () => {
      db.insertSummary('chat1', 'user1', '/tmp', 'recent summary');

      const cleaned = db.cleanOldSummaries(30);
      expect(cleaned).toBe(0);
      expect(db.getRecentSummaries('chat1', 'user1', 10)).toHaveLength(1);
    });

    it('should clean summaries older than maxAgeDays', () => {
      // Insert a summary, then manually back-date it via raw SQL
      db.insertSummary('chat1', 'user1', '/tmp', 'old summary');

      // Back-date by directly accessing the db (hack for testing)
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      (db as any).db.prepare(
        "UPDATE session_summaries SET created_at = ? WHERE summary = 'old summary'"
      ).run(oldDate);

      // Insert a recent one
      db.insertSummary('chat1', 'user1', '/tmp', 'new summary');

      const cleaned = db.cleanOldSummaries(30);
      expect(cleaned).toBe(1);

      const remaining = db.getRecentSummaries('chat1', 'user1', 10);
      expect(remaining).toEqual(['new summary']);
    });
  });

  describe('summaries survive session cleanup', () => {
    it('should retain summaries after deleteExpired removes sessions', () => {
      // Create a session
      db.upsert('chat1:user1', {
        chatId: 'chat1',
        userId: 'user1',
        workingDir: '/tmp',
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48h ago
      });

      // Insert summaries for the same user
      db.insertSummary('chat1', 'user1', '/tmp', 'should survive');

      // Clean expired sessions (24h idle)
      const cleaned = db.deleteExpired(24 * 60 * 60 * 1000);
      expect(cleaned).toBe(1);

      // Session is gone
      expect(db.get('chat1:user1')).toBeUndefined();

      // Summaries survive
      const summaries = db.getRecentSummaries('chat1', 'user1', 10);
      expect(summaries).toEqual(['should survive']);
    });
  });
});
