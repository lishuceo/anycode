import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

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

  it('scenario_a_not_supported_yet:父话题已 setup_workspace', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'fork-custom-'));
    try {
      getThreadSessionMock.mockReturnValue(makeParentSession({ workingDir: customDir }));
      const result = await forkSession({
        parentThreadId: PARENT_THREAD_ID, chatId: CHAT_ID, userId: USER_ID, triggerMessageId: TRIGGER_MSG_ID,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('scenario_a_not_supported_yet');
      expect(sendTextMock).not.toHaveBeenCalled();
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
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
