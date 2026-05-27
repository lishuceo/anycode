import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// 必须在 import 被测模块之前 mock 依赖。
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { sendTextMock, replyInThreadMock, getThreadSessionMock, createForkedThreadSessionMock } = vi.hoisted(() => ({
  sendTextMock: vi.fn(),
  replyInThreadMock: vi.fn(),
  getThreadSessionMock: vi.fn(),
  createForkedThreadSessionMock: vi.fn(),
}));
vi.mock('../../feishu/client.js', () => ({
  feishuClient: {
    sendText: sendTextMock,
    replyInThread: replyInThreadMock,
  },
}));
vi.mock('../manager.js', () => ({
  sessionManager: {
    getThreadSession: getThreadSessionMock,
    createForkedThreadSession: createForkedThreadSessionMock,
  },
}));

// config 里只用到 claude.defaultWorkDir,vi.mock 会被 hoist 到顶部,
// 因此用 vi.hoisted 让临时目录在 mock 之前初始化。
const { TEST_DEFAULT_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  return { TEST_DEFAULT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fork-default-')) };
});
vi.mock('../../config.js', () => ({
  config: {
    claude: { defaultWorkDir: TEST_DEFAULT_DIR },
  },
}));

import { forkSession } from '../fork.js';
import { resolveSessionJsonlPath } from '../jsonl-fork.js';

const PARENT_CONV_ID = 'parent-conv-id-001';
const CHAT_ID = 'oc_chat_test';
const USER_ID = 'ou_user_test';
const PARENT_THREAD_ID = 'omt_parent_thread';
const TRIGGER_MSG_ID = 'om_trigger';

function makeParentSession(overrides: { workingDir?: string; conversationId?: string | null; conversationCwd?: string | null; approved?: boolean } = {}) {
  return {
    threadId: PARENT_THREAD_ID,
    chatId: CHAT_ID,
    userId: USER_ID,
    workingDir: overrides.workingDir ?? TEST_DEFAULT_DIR,
    conversationId: 'conversationId' in overrides ? (overrides.conversationId ?? undefined) : PARENT_CONV_ID,
    conversationCwd: 'conversationCwd' in overrides ? (overrides.conversationCwd ?? undefined) : TEST_DEFAULT_DIR,
    systemPromptHash: 'hash-abc',
    approved: overrides.approved ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function seedParentJsonl(): string {
  const path = resolveSessionJsonlPath(TEST_DEFAULT_DIR, PARENT_CONV_ID);
  mkdirSync(join(homedir(), '.claude', 'projects'), { recursive: true });
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{"role":"user","content":"hi"}\n{"role":"assistant","content":"hello"}\n');
  return path;
}

describe('forkSession', () => {
  let parentJsonl: string;

  beforeEach(() => {
    sendTextMock.mockReset();
    replyInThreadMock.mockReset();
    getThreadSessionMock.mockReset();
    createForkedThreadSessionMock.mockReset();
    parentJsonl = seedParentJsonl();
  });

  afterEach(() => {
    // 清理父 JSONL + 所有生成的 fork JSONL
    const dir = join(parentJsonl, '..');
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('成功路径:复制 JSONL、创建话题、写入血缘字段', async () => {
    getThreadSessionMock.mockReturnValue(makeParentSession());
    sendTextMock.mockResolvedValue('om_new_root');
    replyInThreadMock.mockResolvedValue({ messageId: 'om_reply', threadId: 'omt_new_thread' });

    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID,
      chatId: CHAT_ID,
      userId: USER_ID,
      triggerMessageId: TRIGGER_MSG_ID,
      description: '验证分支',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newThreadId).toBe('omt_new_thread');
    expect(result.newRootMessageId).toBe('om_new_root');
    expect(result.shortId).toMatch(/^[0-9a-f]{4}$/);
    expect(result.workingDir).toBe(TEST_DEFAULT_DIR);

    // 新 JSONL 应已落盘
    const newJsonl = resolveSessionJsonlPath(TEST_DEFAULT_DIR, result.newConversationId);
    expect(existsSync(newJsonl)).toBe(true);

    // sendText 的标题应包含 shortId 和描述
    expect(sendTextMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock.mock.calls[0][0]).toBe(CHAT_ID);
    expect(sendTextMock.mock.calls[0][1]).toContain(result.shortId);
    expect(sendTextMock.mock.calls[0][1]).toContain('验证分支');

    // DB 写入应带血缘字段
    expect(createForkedThreadSessionMock).toHaveBeenCalledTimes(1);
    const dbArgs = createForkedThreadSessionMock.mock.calls[0][0];
    expect(dbArgs.parentTopicId).toBe(PARENT_THREAD_ID);
    expect(dbArgs.forkShortId).toBe(result.shortId);
    expect(dbArgs.forkedFromMessageId).toBe(TRIGGER_MSG_ID);
    expect(dbArgs.forkPoint).toMatch(/^\d+@\d+/);
    expect(dbArgs.conversationId).toBe(result.newConversationId);
    expect(dbArgs.approved).toBe(true);
  });

  it('parent_not_found:父话题在 DB 中不存在', async () => {
    getThreadSessionMock.mockReturnValue(undefined);
    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('parent_not_found');
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('no_conversation:父话题没有 conversationId', async () => {
    getThreadSessionMock.mockReturnValue(makeParentSession({ conversationId: undefined, conversationCwd: undefined }));
    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_conversation');
  });

  it('parent_jsonl_missing:父 JSONL 文件不存在', async () => {
    rmSync(parentJsonl, { force: true });
    getThreadSessionMock.mockReturnValue(makeParentSession());
    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('parent_jsonl_missing');
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('feishu_thread_create_failed:sendText 返回 undefined,JSONL 应回滚', async () => {
    getThreadSessionMock.mockReturnValue(makeParentSession());
    sendTextMock.mockResolvedValue(undefined);

    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('feishu_thread_create_failed');
    expect(replyInThreadMock).not.toHaveBeenCalled();
    expect(createForkedThreadSessionMock).not.toHaveBeenCalled();

    // 确保没有遗留的 fork JSONL
    const projectDir = join(parentJsonl, '..');
    const leftoverForks = readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith(PARENT_CONV_ID));
    expect(leftoverForks).toEqual([]);
  });

  it('feishu_thread_create_failed:replyInThread 无 threadId,JSONL 应回滚', async () => {
    getThreadSessionMock.mockReturnValue(makeParentSession());
    sendTextMock.mockResolvedValue('om_new_root');
    replyInThreadMock.mockResolvedValue({ messageId: 'om_reply', threadId: undefined });

    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('feishu_thread_create_failed');
    expect(createForkedThreadSessionMock).not.toHaveBeenCalled();

    const projectDir = join(parentJsonl, '..');
    const leftoverForks = readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith(PARENT_CONV_ID));
    expect(leftoverForks).toEqual([]);
  });

  it('异常回滚:sendText throw → JSONL 应清理,返回 unknown', async () => {
    getThreadSessionMock.mockReturnValue(makeParentSession());
    sendTextMock.mockRejectedValue(new Error('feishu 5xx'));

    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown');
    expect(result.message).toContain('feishu 5xx');

    const projectDir = join(parentJsonl, '..');
    const leftoverForks = readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith(PARENT_CONV_ID));
    expect(leftoverForks).toEqual([]);
  });

  it('异常回滚:createForkedThreadSession throw → JSONL 应清理', async () => {
    getThreadSessionMock.mockReturnValue(makeParentSession());
    sendTextMock.mockResolvedValue('om_new_root');
    replyInThreadMock.mockResolvedValue({ messageId: 'om_reply', threadId: 'omt_new_thread' });
    createForkedThreadSessionMock.mockImplementation(() => {
      throw new Error('SQLite disk I/O');
    });

    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown');
    expect(result.message).toContain('SQLite');

    const projectDir = join(parentJsonl, '..');
    const leftoverForks = readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith(PARENT_CONV_ID));
    expect(leftoverForks).toEqual([]);
  });
});

// ============================================================
// 场景 A (P0b): 父话题已 setup_workspace,fork 需要新建 worktree + 继承 WIP
// ============================================================

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, timeout: 10_000 });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# initial\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
}

function makeForkChildSession(workdir: string, conversationId: string = PARENT_CONV_ID) {
  return {
    threadId: PARENT_THREAD_ID,
    chatId: CHAT_ID,
    userId: USER_ID,
    workingDir: workdir,
    conversationId,
    conversationCwd: workdir,
    systemPromptHash: 'hash-abc',
    approved: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function seedJsonlAt(workdir: string, conversationId: string): string {
  const path = resolveSessionJsonlPath(workdir, conversationId);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{"role":"user","content":"hi"}\n');
  return path;
}

describe('forkSession - 场景 A (worktree + WIP)', () => {
  let parentWorkdir: string;
  let parentJsonlPath: string;

  beforeEach(() => {
    sendTextMock.mockReset();
    replyInThreadMock.mockReset();
    getThreadSessionMock.mockReset();
    createForkedThreadSessionMock.mockReset();
    sendTextMock.mockResolvedValue('om_new_root');
    replyInThreadMock.mockResolvedValue({ messageId: 'om_reply', threadId: 'omt_new_thread' });

    parentWorkdir = mkdtempSync(join(tmpdir(), 'fork-parent-'));
    initGitRepo(parentWorkdir);
    parentJsonlPath = seedJsonlAt(parentWorkdir, PARENT_CONV_ID);
    getThreadSessionMock.mockReturnValue(makeForkChildSession(parentWorkdir));
  });

  afterEach(() => {
    // 先清 worktree(若有),否则父删了 worktree 引用是悬空的
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: parentWorkdir });
    } catch { /* ignore */ }
    rmSync(parentWorkdir, { recursive: true, force: true });
    // rmSync 不支持 glob,必须手动 readdir + filter 清理 fork 出来的子 worktree
    const tmpRoot = join(parentWorkdir, '..');
    const baseName = parentWorkdir.split('/').pop()!;
    if (existsSync(tmpRoot)) {
      for (const entry of readdirSync(tmpRoot)) {
        if (entry.startsWith(`${baseName}-fork-`)) {
          rmSync(join(tmpRoot, entry), { recursive: true, force: true });
        }
      }
    }
    // JSONL 项目目录在 ~/.claude/projects/<encoded-parent-workdir>
    const projectDir = join(parentJsonlPath, '..');
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  });

  it('默认继承父 WIP:staged + unstaged + untracked 全部带过来,父工作树不动', async () => {
    // 准备父 WIP
    writeFileSync(join(parentWorkdir, 'staged.txt'), 'staged-content\n');
    execFileSync('git', ['add', 'staged.txt'], { cwd: parentWorkdir });
    writeFileSync(join(parentWorkdir, 'README.md'), '# initial\nunstaged change\n');
    writeFileSync(join(parentWorkdir, 'untracked.txt'), 'untracked-content\n');

    // 记录父 fork 前 status
    const parentStatusBefore = execFileSync('git', ['status', '--porcelain'],
      { cwd: parentWorkdir, encoding: 'utf8' });

    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 子 worktree 应存在且包含 3 类 WIP 文件
    expect(result.workingDir).toBe(`${parentWorkdir}-fork-${result.shortId}`);
    expect(existsSync(result.workingDir)).toBe(true);
    expect(existsSync(join(result.workingDir, 'staged.txt'))).toBe(true);
    expect(existsSync(join(result.workingDir, 'untracked.txt'))).toBe(true);
    expect(readFileSync(join(result.workingDir, 'README.md'), 'utf8')).toContain('unstaged change');

    // 父工作树 status 与 fork 前完全一致
    const parentStatusAfter = execFileSync('git', ['status', '--porcelain'],
      { cwd: parentWorkdir, encoding: 'utf8' });
    expect(parentStatusAfter).toBe(parentStatusBefore);

    // DB 写入的 workingDir 是新 worktree 路径
    expect(createForkedThreadSessionMock.mock.calls[0][0].workingDir).toBe(result.workingDir);
  });

  it('--clean 跳过 WIP 继承:子 worktree 是纯 HEAD,无未提交改动', async () => {
    writeFileSync(join(parentWorkdir, 'wip.txt'), 'should-not-appear\n');
    execFileSync('git', ['add', 'wip.txt'], { cwd: parentWorkdir });

    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
      clean: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(join(result.workingDir, 'wip.txt'))).toBe(false);
    const childStatus = execFileSync('git', ['status', '--porcelain'],
      { cwd: result.workingDir, encoding: 'utf8' });
    expect(childStatus.trim()).toBe('');
  });

  it('父无 WIP:stash create 返回空,子 worktree 也是纯净的,不报错', async () => {
    // 父就是 init 后干净状态
    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const childStatus = execFileSync('git', ['status', '--porcelain'],
      { cwd: result.workingDir, encoding: 'utf8' });
    expect(childStatus.trim()).toBe('');
  });

  it('worktree_create_failed:父不是 git 仓库 → 干净回滚,无 JSONL/分支泄漏', async () => {
    // 删掉父的 .git 模拟"无法 worktree add" 的失败场景
    rmSync(join(parentWorkdir, '.git'), { recursive: true, force: true });

    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('worktree_create_failed');
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(createForkedThreadSessionMock).not.toHaveBeenCalled();

    const projectDir = join(parentJsonlPath, '..');
    const leftoverForks = readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith(PARENT_CONV_ID));
    expect(leftoverForks).toEqual([]);
  });

  it('feishu 失败时回滚 worktree + branch + JSONL', async () => {
    sendTextMock.mockResolvedValue(undefined);

    const result = await forkSession({
      parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('feishu_thread_create_failed');

    // worktree 目录应被清理
    const forkDirs = readdirSync(join(parentWorkdir, '..'))
      .filter((f) => f.startsWith(`${parentWorkdir.split('/').pop()}-fork-`));
    expect(forkDirs).toEqual([]);

    // 分支应被删除(git branch --list 不返回 fork 分支)
    const branches = execFileSync('git', ['branch', '--list', 'main-fork-*'],
      { cwd: parentWorkdir, encoding: 'utf8' });
    expect(branches.trim()).toBe('');

    // JSONL 应被清理
    const projectDir = join(parentJsonlPath, '..');
    const leftoverForks = readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith(PARENT_CONV_ID));
    expect(leftoverForks).toEqual([]);
  });
});
