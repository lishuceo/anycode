import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// SessionManager 在构造时就会读 config.db.sessionDbPath 创建 SQLite 文件,
// 因此用 vi.hoisted 准备临时目录,并 mock config,让每个 SessionManager 实例
// 都落到一个隔离 db 文件里。
const { TEST_DB_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  return { TEST_DB_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'manager-test-root-')) };
});

vi.mock('../../config.js', () => ({
  config: {
    db: { sessionDbPath: join(TEST_DB_DIR, 'placeholder.db') },
    claude: { defaultWorkDir: TEST_DB_DIR },
    workspace: { baseDir: join(TEST_DB_DIR, 'workspaces'), maxAgeDays: 3 },
  },
}));

// 注意: 不要 import 全局 sessionManager 单例(它会落到 placeholder.db),
// 而是直接 import 类,每个 case 用独立 db。
import { SessionManager } from '../manager.js';
import { config } from '../../config.js';

describe('SessionManager.createForkedThreadSession', () => {
  let manager: SessionManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(TEST_DB_DIR, 'case-'));
    // 用 mutation 把 mock config 指向本 case 的 db 路径,然后 new 一个新管理器。
    (config.db as { sessionDbPath: string }).sessionDbPath = join(tempDir, 'sessions.db');
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('写入血缘字段,getThreadSession 能读回 parentTopicId/forkShortId/forkPoint/forkedFromMessageId', () => {
    manager.createForkedThreadSession({
      threadId: 'omt_child',
      chatId: 'oc_chat',
      userId: 'ou_user',
      workingDir: '/tmp/work',
      conversationId: 'conv-new',
      conversationCwd: '/tmp/work',
      parentTopicId: 'omt_parent',
      forkShortId: 'a1b2',
      forkedFromMessageId: 'om_trigger',
      forkPoint: '1234@5678.9',
      approved: true,
    });

    const session = manager.getThreadSession('omt_child');
    expect(session).toBeDefined();
    expect(session!.conversationId).toBe('conv-new');
    expect(session!.conversationCwd).toBe('/tmp/work');
    // parentTopicId 应被 makeThreadKey 加 agent 前缀
    expect(session!.parentTopicId).toBe('agent:dev:omt_parent');
    expect(session!.forkShortId).toBe('a1b2');
    expect(session!.forkPoint).toBe('1234@5678.9');
    expect(session!.forkedFromMessageId).toBe('om_trigger');
    expect(session!.approved).toBe(true);
  });

  it('approved 默认不传时应保持 undefined(走 setThreadApproved 分支)', () => {
    manager.createForkedThreadSession({
      threadId: 'omt_child2',
      chatId: 'oc_chat',
      userId: 'ou_user',
      workingDir: '/tmp/work',
      conversationId: 'conv-new',
      conversationCwd: '/tmp/work',
      parentTopicId: 'omt_parent',
      forkShortId: 'cafe',
    });
    const session = manager.getThreadSession('omt_child2');
    expect(session).toBeDefined();
    expect(session!.forkShortId).toBe('cafe');
    // approved 未传 → setThreadApproved 不被触发,DB 默认值(undefined / false)
    expect(session!.approved).toBeFalsy();
  });

  it('重复 upsert 不覆盖 fork 字段:后续 upsertThreadSession 写入,血缘字段保留', () => {
    // 第一步:创建 fork 话题
    manager.createForkedThreadSession({
      threadId: 'omt_child3',
      chatId: 'oc_chat',
      userId: 'ou_user',
      workingDir: '/tmp/work',
      conversationId: 'conv-fork-1',
      conversationCwd: '/tmp/work',
      parentTopicId: 'omt_parent',
      forkShortId: 'beef',
      forkedFromMessageId: 'om_trigger',
      forkPoint: 'fp-init',
      approved: true,
    });

    // 第二步:模拟首条消息走 upsertThreadSession,它没有 fork 字段
    // (上层路径在 thread 已存在时也可能再次 upsert,例如 setup_workspace 切目录前)
    manager.upsertThreadSession('omt_child3', 'oc_chat', 'ou_user', '/tmp/work2');

    const session = manager.getThreadSession('omt_child3');
    expect(session).toBeDefined();
    // working_dir 被 upsert 覆盖
    expect(session!.workingDir).toBe('/tmp/work2');
    // fork 字段必须保留 — 这就是 stmtUpsertThreadSession ON CONFLICT 只更新 4 列的核心契约
    expect(session!.parentTopicId).toBe('agent:dev:omt_parent');
    expect(session!.forkShortId).toBe('beef');
    expect(session!.forkPoint).toBe('fp-init');
    expect(session!.forkedFromMessageId).toBe('om_trigger');
  });

  it('agentId 隔离:不同 agent 下同名 threadId 互不影响', () => {
    manager.createForkedThreadSession({
      threadId: 'omt_shared',
      chatId: 'oc_chat',
      userId: 'ou_user',
      workingDir: '/tmp/dev',
      conversationId: 'conv-dev',
      conversationCwd: '/tmp/dev',
      parentTopicId: 'omt_parent',
      forkShortId: 'd001',
      agentId: 'dev',
    });
    manager.createForkedThreadSession({
      threadId: 'omt_shared',
      chatId: 'oc_chat',
      userId: 'ou_user',
      workingDir: '/tmp/pm',
      conversationId: 'conv-pm',
      conversationCwd: '/tmp/pm',
      parentTopicId: 'omt_parent',
      forkShortId: 'p001',
      agentId: 'pm',
    });

    const devSession = manager.getThreadSession('omt_shared', 'dev');
    const pmSession = manager.getThreadSession('omt_shared', 'pm');
    expect(devSession!.forkShortId).toBe('d001');
    expect(devSession!.workingDir).toBe('/tmp/dev');
    expect(pmSession!.forkShortId).toBe('p001');
    expect(pmSession!.workingDir).toBe('/tmp/pm');
  });
});
