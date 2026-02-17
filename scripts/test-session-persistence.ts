/**
 * 验证 Session 持久化功能
 * 运行: npx tsx scripts/test-session-persistence.ts
 */
import { rmSync } from 'node:fs';
import { SessionDatabase } from '../src/session/database.js';

const DB_PATH = './data/test-sessions.db';

function cleanup() {
  try { rmSync(DB_PATH, { force: true }); } catch {}
  try { rmSync(DB_PATH + '-wal', { force: true }); } catch {}
  try { rmSync(DB_PATH + '-shm', { force: true }); } catch {}
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

// --- 开始测试 ---
cleanup();

console.log('\n1. 创建数据库 & 基本 CRUD');
{
  const db = new SessionDatabase(DB_PATH);

  // upsert + get
  const now = new Date();
  db.upsert('chat1:user1', {
    chatId: 'chat1',
    userId: 'user1',
    workingDir: '/tmp/test',
    status: 'idle',
    createdAt: now,
    lastActiveAt: now,
  });

  const s = db.get('chat1:user1');
  assert(s !== undefined, 'get 返回已插入的会话');
  assert(s!.chatId === 'chat1', 'chatId 正确');
  assert(s!.userId === 'user1', 'userId 正确');
  assert(s!.workingDir === '/tmp/test', 'workingDir 正确');
  assert(s!.status === 'idle', 'status 正确');
  assert(s!.conversationId === undefined, 'conversationId 为 undefined');
  assert(s!.threadId === undefined, 'threadId 为 undefined');
  assert(s!.createdAt instanceof Date, 'createdAt 是 Date 对象');

  // get 不存在的 key
  assert(db.get('nonexistent') === undefined, 'get 不存在的 key 返回 undefined');

  // delete
  db.delete('chat1:user1');
  assert(db.get('chat1:user1') === undefined, 'delete 后 get 返回 undefined');

  db.close();
}

console.log('\n2. 字段更新方法');
{
  const db = new SessionDatabase(DB_PATH);
  const now = new Date();

  db.upsert('chat2:user2', {
    chatId: 'chat2',
    userId: 'user2',
    workingDir: '/old/dir',
    status: 'idle',
    createdAt: now,
    lastActiveAt: now,
  });

  db.updateWorkingDir('chat2:user2', '/new/dir');
  assert(db.get('chat2:user2')!.workingDir === '/new/dir', 'updateWorkingDir 生效');

  db.updateStatus('chat2:user2', 'busy');
  assert(db.get('chat2:user2')!.status === 'busy', 'updateStatus 生效');

  db.updateConversationId('chat2:user2', 'conv-123');
  assert(db.get('chat2:user2')!.conversationId === 'conv-123', 'updateConversationId 生效');

  db.updateThread('chat2:user2', 'thread-1', 'root-msg-1');
  const s = db.get('chat2:user2')!;
  assert(s.threadId === 'thread-1', 'updateThread threadId 生效');
  assert(s.threadRootMessageId === 'root-msg-1', 'updateThread rootMessageId 生效');

  db.close();
}

console.log('\n3. 跨实例持久化 (模拟重启)');
{
  // 用新实例打开同一个数据库，数据应该还在
  const db = new SessionDatabase(DB_PATH);
  const s = db.get('chat2:user2');
  assert(s !== undefined, '重启后会话仍然存在');
  assert(s!.workingDir === '/new/dir', '重启后 workingDir 保持');
  assert(s!.conversationId === 'conv-123', '重启后 conversationId 保持');
  assert(s!.threadId === 'thread-1', '重启后 threadId 保持');
  db.close();
}

console.log('\n4. resetBusySessions');
{
  const db = new SessionDatabase(DB_PATH);

  // chat2:user2 之前设为 busy
  assert(db.get('chat2:user2')!.status === 'busy', '重启前 status 为 busy');

  const count = db.resetBusySessions();
  assert(count >= 1, `resetBusySessions 重置了 ${count} 条记录`);
  assert(db.get('chat2:user2')!.status === 'idle', '重置后 status 为 idle');

  db.close();
}

console.log('\n5. deleteExpired');
{
  const db = new SessionDatabase(DB_PATH);

  // 插入一个 3 小时前最后活跃的会话
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  db.upsert('old:session', {
    chatId: 'old',
    userId: 'session',
    workingDir: '/tmp',
    status: 'idle',
    createdAt: threeHoursAgo,
    lastActiveAt: threeHoursAgo,
  });

  // 插入一个刚活跃的会话
  db.upsert('new:session', {
    chatId: 'new',
    userId: 'session',
    workingDir: '/tmp',
    status: 'idle',
    createdAt: new Date(),
    lastActiveAt: new Date(),
  });

  // 插入一个 3 小时前活跃但 busy 的会话 (不应被清理)
  db.upsert('busy:session', {
    chatId: 'busy',
    userId: 'session',
    workingDir: '/tmp',
    status: 'busy',
    createdAt: threeHoursAgo,
    lastActiveAt: threeHoursAgo,
  });

  const cleaned = db.deleteExpired(2 * 60 * 60 * 1000); // 2h
  assert(cleaned >= 1, `deleteExpired 清理了 ${cleaned} 条过期会话`);
  assert(db.get('old:session') === undefined, '过期 idle 会话被清理');
  assert(db.get('new:session') !== undefined, '活跃会话保留');
  assert(db.get('busy:session') !== undefined, 'busy 会话不被清理');

  db.close();
}

console.log('\n6. upsert 覆盖更新');
{
  const db = new SessionDatabase(DB_PATH);
  const now = new Date();

  db.upsert('dup:key', {
    chatId: 'dup', userId: 'key', workingDir: '/v1',
    status: 'idle', createdAt: now, lastActiveAt: now,
  });
  db.upsert('dup:key', {
    chatId: 'dup', userId: 'key', workingDir: '/v2',
    conversationId: 'conv-new',
    status: 'busy', createdAt: now, lastActiveAt: now,
  });

  const s = db.get('dup:key')!;
  assert(s.workingDir === '/v2', 'upsert 覆盖 workingDir');
  assert(s.conversationId === 'conv-new', 'upsert 覆盖 conversationId');
  assert(s.status === 'busy', 'upsert 覆盖 status');

  db.close();
}

// --- 汇总 ---
cleanup();
console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
