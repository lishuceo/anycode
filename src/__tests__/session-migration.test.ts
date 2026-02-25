import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Session database migration v7→v8 (agent prefix)', () => {
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-migration-test-'));
    dbPath = join(tempDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should prefix existing session keys with agent:dev:', async () => {
    // Create a v7 database with old-format keys
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Create tables at v7
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    db.exec(`INSERT INTO schema_version VALUES (7)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
        working_dir TEXT NOT NULL, conversation_id TEXT, conversation_cwd TEXT,
        thread_id TEXT, thread_root_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
        working_dir TEXT NOT NULL, conversation_id TEXT, conversation_cwd TEXT,
        routing_completed INTEGER DEFAULT 0, routing_state TEXT,
        pipeline_context TEXT, approved INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `);
    db.exec(`CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, user_id TEXT,
      working_dir TEXT, summary TEXT, created_at TEXT
    )`);

    // Insert old-format data
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'idle', ?, ?)`).run(
      'chat1:user1', 'chat1', 'user1', '/tmp/work', now, now,
    );
    db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'idle', ?, ?)`).run(
      'chat2:user2', 'chat2', 'user2', '/tmp/work2', now, now,
    );
    db.prepare(`INSERT INTO thread_sessions VALUES (?, ?, ?, ?, NULL, NULL, 1, NULL, NULL, 1, ?, ?)`).run(
      'thread_abc', 'chat1', 'user1', '/tmp/work', now, now,
    );
    db.close();

    // Now import SessionDatabase which should run migration v7→v8
    const { SessionDatabase } = await import('../session/database.js');
    const sessionDb = new SessionDatabase(dbPath);

    // Old keys should be prefixed
    const migratedSession = sessionDb.get('agent:dev:chat1:user1');
    expect(migratedSession).toBeDefined();
    expect(migratedSession!.chatId).toBe('chat1');

    const migratedThread = sessionDb.getThreadSession('agent:dev:thread_abc');
    expect(migratedThread).toBeDefined();
    expect(migratedThread!.chatId).toBe('chat1');

    // Old keys should no longer exist
    expect(sessionDb.get('chat1:user1')).toBeUndefined();
    expect(sessionDb.getThreadSession('thread_abc')).toBeUndefined();

    // Second session also migrated
    expect(sessionDb.get('agent:dev:chat2:user2')).toBeDefined();

    sessionDb.close();
  });

  it('should not double-prefix already migrated keys', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    db.exec(`INSERT INTO schema_version VALUES (7)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
        working_dir TEXT NOT NULL, conversation_id TEXT, conversation_cwd TEXT,
        thread_id TEXT, thread_root_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
        working_dir TEXT NOT NULL, conversation_id TEXT, conversation_cwd TEXT,
        routing_completed INTEGER DEFAULT 0, routing_state TEXT,
        pipeline_context TEXT, approved INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `);
    db.exec(`CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, user_id TEXT,
      working_dir TEXT, summary TEXT, created_at TEXT
    )`);

    const now = new Date().toISOString();
    // Insert already-prefixed key (simulates partial migration)
    db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'idle', ?, ?)`).run(
      'agent:dev:chat1:user1', 'chat1', 'user1', '/tmp/work', now, now,
    );
    db.close();

    const { SessionDatabase } = await import('../session/database.js');
    const sessionDb = new SessionDatabase(dbPath);

    // Should still be accessible (not double-prefixed)
    expect(sessionDb.get('agent:dev:chat1:user1')).toBeDefined();
    expect(sessionDb.get('agent:dev:agent:dev:chat1:user1')).toBeUndefined();

    sessionDb.close();
  });
});

describe('SessionManager agent-aware keys', () => {
  it('should generate correct session keys with agentId', async () => {
    const { SessionManager } = await import('../session/manager.js');
    const mgr = new SessionManager();

    expect(mgr.makeKey('chat1', 'user1')).toBe('agent:dev:chat1:user1');
    expect(mgr.makeKey('chat1', 'user1', 'chat')).toBe('agent:chat:chat1:user1');
    expect(mgr.makeKey('chat1', 'user1', 'pm')).toBe('agent:pm:chat1:user1');

    expect(mgr.makeThreadKey('thread_abc')).toBe('agent:dev:thread_abc');
    expect(mgr.makeThreadKey('thread_abc', 'chat')).toBe('agent:chat:thread_abc');

    mgr.close();
  });
});
