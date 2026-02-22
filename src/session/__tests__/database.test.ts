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

describe('SessionDatabase — thread_sessions', () => {
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

  describe('upsertThreadSession', () => {
    it('should insert a new thread session', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-1',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      const session = db.getThreadSession('thread-1');
      expect(session).toBeDefined();
      expect(session!.threadId).toBe('thread-1');
      expect(session!.chatId).toBe('chat-1');
      expect(session!.userId).toBe('user-1');
      expect(session!.workingDir).toBe('/projects/repo-a');
      expect(session!.conversationId).toBeUndefined();
    });

    it('should update existing thread session on conflict', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-1',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      db.upsertThreadSession({
        threadId: 'thread-1',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-b',
        conversationId: 'conv-1',
        conversationCwd: '/projects/repo-b',
        createdAt: now,
        updatedAt: new Date(),
      });

      const session = db.getThreadSession('thread-1');
      expect(session!.workingDir).toBe('/projects/repo-b');
      expect(session!.conversationId).toBe('conv-1');
    });
  });

  describe('getThreadSession', () => {
    it('should return undefined for non-existent thread', () => {
      expect(db.getThreadSession('non-existent')).toBeUndefined();
    });
  });

  describe('updateThreadConversationId', () => {
    it('should update conversationId and cwd', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-1',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      db.updateThreadConversationId('thread-1', 'conv-abc', '/projects/repo-a');

      const session = db.getThreadSession('thread-1');
      expect(session!.conversationId).toBe('conv-abc');
      expect(session!.conversationCwd).toBe('/projects/repo-a');
    });
  });

  describe('updateThreadWorkingDir', () => {
    it('should update workingDir and clear conversationId', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-1',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        conversationId: 'conv-old',
        conversationCwd: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      db.updateThreadWorkingDir('thread-1', '/projects/repo-b');

      const session = db.getThreadSession('thread-1');
      expect(session!.workingDir).toBe('/projects/repo-b');
      expect(session!.conversationId).toBeUndefined();
      expect(session!.conversationCwd).toBeUndefined();
    });
  });

  describe('deleteExpiredThreadSessions', () => {
    it('should return 0 when no thread sessions exist', () => {
      const cleaned = db.deleteExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);
      expect(cleaned).toBe(0);
    });

    it('should not delete recent thread sessions', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-1',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      const cleaned = db.deleteExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);
      expect(cleaned).toBe(0);
      expect(db.getThreadSession('thread-1')).toBeDefined();
    });

    it('should delete thread sessions older than threshold', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-old',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });
      db.upsertThreadSession({
        threadId: 'thread-new',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-b',
        createdAt: now,
        updatedAt: now,
      });

      // Back-date the old thread session
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      (db as any).db.prepare(
        "UPDATE thread_sessions SET updated_at = ? WHERE thread_id = 'thread-old'"
      ).run(oldDate);

      const cleaned = db.deleteExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);
      expect(cleaned).toBe(1);
      expect(db.getThreadSession('thread-old')).toBeUndefined();
      expect(db.getThreadSession('thread-new')).toBeDefined();
    });
  });

  describe('getExpiredThreadSessions', () => {
    it('should return empty array when no thread sessions exist', () => {
      const expired = db.getExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);
      expect(expired).toEqual([]);
    });

    it('should not return recent thread sessions', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-1',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      const expired = db.getExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);
      expect(expired).toEqual([]);
    });

    it('should return expired thread sessions with correct data', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-old',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/workspaces/repo-abc123',
        createdAt: now,
        updatedAt: now,
      });
      db.upsertThreadSession({
        threadId: 'thread-new',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/workspaces/repo-def456',
        createdAt: now,
        updatedAt: now,
      });

      // Back-date the old thread session
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      (db as any).db.prepare(
        "UPDATE thread_sessions SET updated_at = ? WHERE thread_id = 'thread-old'"
      ).run(oldDate);

      const expired = db.getExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);
      expect(expired).toHaveLength(1);
      expect(expired[0].threadId).toBe('thread-old');
      expect(expired[0].workingDir).toBe('/workspaces/repo-abc123');
      expect(expired[0].chatId).toBe('chat-1');
      expect(expired[0].userId).toBe('user-1');
    });

    it('should return data consistent with deleteExpiredThreadSessions', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-a',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/workspaces/a',
        createdAt: now,
        updatedAt: now,
      });
      db.upsertThreadSession({
        threadId: 'thread-b',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/workspaces/b',
        createdAt: now,
        updatedAt: now,
      });

      // Back-date both
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      (db as any).db.prepare(
        "UPDATE thread_sessions SET updated_at = ? WHERE thread_id IN ('thread-a', 'thread-b')"
      ).run(oldDate);

      const expired = db.getExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);
      const deleted = db.deleteExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);

      // Same count
      expect(expired).toHaveLength(2);
      expect(deleted).toBe(2);
    });
  });

  describe('cutoff-based methods', () => {
    it('should use the same cutoff for get and delete to avoid TOCTOU', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-cutoff',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/workspaces/cutoff-test',
        createdAt: now,
        updatedAt: now,
      });

      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      (db as any).db.prepare(
        "UPDATE thread_sessions SET updated_at = ? WHERE thread_id = 'thread-cutoff'"
      ).run(oldDate);

      // Use same cutoff for both operations
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const expired = db.getExpiredThreadSessionsByCutoff(cutoff);
      const deleted = db.deleteExpiredThreadSessionsByCutoff(cutoff);

      expect(expired).toHaveLength(1);
      expect(deleted).toBe(1);
      expect(expired[0].threadId).toBe('thread-cutoff');
    });
  });

  describe('touchThreadSession', () => {
    it('should update the updated_at timestamp', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-touch',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/workspaces/touch-test',
        createdAt: now,
        updatedAt: now,
      });

      // Back-date to make it "old"
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      (db as any).db.prepare(
        "UPDATE thread_sessions SET updated_at = ? WHERE thread_id = 'thread-touch'"
      ).run(oldDate);

      // Verify it would be expired
      const beforeTouch = db.getExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);
      expect(beforeTouch).toHaveLength(1);

      // Touch it
      db.touchThreadSession('thread-touch');

      // Should no longer be expired
      const afterTouch = db.getExpiredThreadSessions(30 * 24 * 60 * 60 * 1000);
      expect(afterTouch).toHaveLength(0);

      // Data should still be intact
      const session = db.getThreadSession('thread-touch');
      expect(session!.workingDir).toBe('/workspaces/touch-test');
    });
  });

  describe('thread_sessions survive session cleanup', () => {
    it('should not be affected by deleteExpired on sessions table', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-1',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      // Create and expire a global session
      db.upsert('chat-1:user-1', {
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/tmp',
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });

      db.deleteExpired(24 * 60 * 60 * 1000);

      // Global session gone, but thread session survives
      expect(db.get('chat-1:user-1')).toBeUndefined();
      expect(db.getThreadSession('thread-1')).toBeDefined();
    });
  });

  describe('setThreadPipelineContext', () => {
    it('should store and retrieve pipeline context', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-pipe',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      db.setThreadPipelineContext('thread-pipe', {
        prompt: '实现用户登录功能',
        summary: 'Pipeline 完成，已创建 PR #42',
        workingDir: '/projects/repo-a',
      });

      const session = db.getThreadSession('thread-pipe');
      expect(session!.pipelineContext).toEqual({
        prompt: '实现用户登录功能',
        summary: 'Pipeline 完成，已创建 PR #42',
        workingDir: '/projects/repo-a',
      });
    });

    it('should also mark routing as completed', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-pipe-2',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      db.setThreadPipelineContext('thread-pipe-2', {
        prompt: 'fix bug',
        summary: 'done',
        workingDir: '/projects/repo-a',
      });

      const session = db.getThreadSession('thread-pipe-2');
      expect(session!.routingCompleted).toBe(true);
    });

    it('should return undefined pipelineContext when not set', () => {
      const now = new Date();
      db.upsertThreadSession({
        threadId: 'thread-no-pipe',
        chatId: 'chat-1',
        userId: 'user-1',
        workingDir: '/projects/repo-a',
        createdAt: now,
        updatedAt: now,
      });

      const session = db.getThreadSession('thread-no-pipe');
      expect(session!.pipelineContext).toBeUndefined();
    });
  });
});
