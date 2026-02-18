// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaudeResult } from '../../claude/types.js';

// ============================================================
// Mocks
// ============================================================

const mockExecute = vi.fn<(...args: unknown[]) => Promise<ClaudeResult>>();

vi.mock('../../claude/executor.js', () => ({
  claudeExecutor: {
    execute: (...args: unknown[]) => mockExecute(...args),
    killSession: vi.fn(),
  },
}));

const mockSessionGet = vi.fn();
const mockSessionGetOrCreate = vi.fn();
const mockSessionSetWorkingDir = vi.fn();
const mockSessionSetStatus = vi.fn();
const mockSessionSetConversationId = vi.fn();
const mockSessionSetThread = vi.fn();

vi.mock('../../session/manager.js', () => ({
  sessionManager: {
    get: (...args: unknown[]) => mockSessionGet(...args),
    getOrCreate: (...args: unknown[]) => mockSessionGetOrCreate(...args),
    setWorkingDir: (...args: unknown[]) => mockSessionSetWorkingDir(...args),
    setStatus: (...args: unknown[]) => mockSessionSetStatus(...args),
    setConversationId: (...args: unknown[]) => mockSessionSetConversationId(...args),
    setThread: (...args: unknown[]) => mockSessionSetThread(...args),
    reset: vi.fn(),
  },
}));

vi.mock('../../session/queue.js', () => {
  // 简化版 TaskQueue 用于测试
  const queues = new Map<string, Array<{ resolve: (v: string) => void; reject: (e: Error) => void }>>();
  return {
    taskQueue: {
      enqueue: vi.fn((_chatId: string, _userId: string, _msg: string, _msgId: string) => {
        return new Promise<string>((resolve, reject) => {
          // 不实际入队，测试中直接由 processQueue 驱动
        });
      }),
      dequeue: vi.fn(),
      complete: vi.fn(),
      pendingCount: vi.fn(() => 0),
      cancelPending: vi.fn(() => 0),
      isBusy: vi.fn(() => false),
    },
  };
});

const mockReplyText = vi.fn();
const mockReplyInThread = vi.fn(() => Promise.resolve({ messageId: 'bot-msg-1', threadId: 'thread-1' }));
const mockSendCard = vi.fn(() => Promise.resolve('card-msg-1'));
const mockUpdateCard = vi.fn();
const mockReplyCardInThread = vi.fn(() => Promise.resolve('card-msg-2'));
const mockReplyTextInThread = vi.fn();
const mockSendText = vi.fn();

vi.mock('../client.js', () => ({
  feishuClient: {
    replyText: (...args: unknown[]) => mockReplyText(...args),
    replyInThread: (...args: unknown[]) => mockReplyInThread(...args),
    sendCard: (...args: unknown[]) => mockSendCard(...args),
    updateCard: (...args: unknown[]) => mockUpdateCard(...args),
    replyCardInThread: (...args: unknown[]) => mockReplyCardInThread(...args),
    replyTextInThread: (...args: unknown[]) => mockReplyTextInThread(...args),
    sendText: (...args: unknown[]) => mockSendText(...args),
  },
}));

vi.mock('../message-builder.js', () => ({
  buildProgressCard: vi.fn((prompt: string, status?: string) => ({
    type: 'progress', prompt, status: status || '正在处理...',
  })),
  buildResultCard: vi.fn((_prompt: string, output: string, success: boolean) => ({
    type: 'result', output, success,
  })),
  buildStatusCard: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../utils/security.js', () => ({
  isUserAllowed: vi.fn(() => true),
  containsDangerousCommand: vi.fn(() => false),
}));

vi.mock('../../config.js', () => ({
  config: {
    feishu: { encryptKey: '', verifyToken: '' },
    security: { allowedUserIds: [] },
    claude: { defaultWorkDir: '/tmp/work' },
    workspace: { baseDir: '/tmp/workspaces', branchPrefix: 'feat/test' },
  },
}));

vi.mock('../../workspace/manager.js', () => ({
  setupWorkspace: vi.fn(),
}));

// ============================================================
// 由于 event-handler 中 executeClaudeTask 是私有函数，
// 我们通过模拟完整的消息处理流程来测试 restart 逻辑。
// 但 event-handler 导出的是 createEventDispatcher，不方便直接测试。
// 所以我们提取关键的 restart 逻辑进行单元测试。
//
// 这里测试的核心逻辑:
// 1. 第一次 execute 返回 needsRestart → 触发第二次 execute
// 2. 第二次 execute 使用 newWorkingDir + disableWorkspaceTool
// 3. restart 前清空 conversationId
// 4. restart 前检查 session 是否仍为 busy
// ============================================================

/**
 * 模拟 executeClaudeTask 的核心 restart 逻辑
 * (从 event-handler.ts 提取的逻辑，用于可测试性)
 */
async function simulateExecuteClaudeTask(
  prompt: string,
  chatId: string,
  userId: string,
) {
  const { claudeExecutor } = await import('../../claude/executor.js');
  const { sessionManager } = await import('../../session/manager.js');

  const session = sessionManager.getOrCreate(chatId, userId);
  const sessionKey = `${chatId}:${userId}`;

  sessionManager.setStatus(chatId, userId, 'busy');

  const onWorkspaceChanged = (newDir: string) => {
    sessionManager.setWorkingDir(chatId, userId, newDir);
  };

  const result = await claudeExecutor.execute(
    sessionKey, prompt, session.workingDir,
    session.conversationId, undefined, onWorkspaceChanged,
  );

  if (result.needsRestart && result.newWorkingDir) {
    const currentSession = sessionManager.get(chatId, userId);
    if (!currentSession || currentSession.status !== 'busy') {
      return { restarted: false, reason: 'session_not_busy' };
    }

    sessionManager.setConversationId(chatId, userId, '');

    const restartResult = await claudeExecutor.execute(
      sessionKey, prompt, result.newWorkingDir,
      undefined, undefined, undefined,
      { disableWorkspaceTool: true },
    );

    if (restartResult.sessionId) {
      sessionManager.setConversationId(chatId, userId, restartResult.sessionId);
    }

    return { restarted: true, result: restartResult };
  }

  if (result.sessionId) {
    sessionManager.setConversationId(chatId, userId, result.sessionId);
  }

  return { restarted: false, result };
}

// ============================================================
// Tests
// ============================================================

describe('executeClaudeTask restart logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionGetOrCreate.mockReturnValue({
      chatId: 'chat1',
      userId: 'user1',
      workingDir: '/tmp/work',
      status: 'idle',
      conversationId: 'old-conv-id',
    });
    mockSessionGet.mockReturnValue({
      chatId: 'chat1',
      userId: 'user1',
      workingDir: '/tmp/work',
      status: 'busy',
    });
  });

  it('should not restart when needsRestart is false', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true,
      output: 'done',
      sessionId: 'sess-1',
      durationMs: 100,
    });

    const outcome = await simulateExecuteClaudeTask('fix the bug', 'chat1', 'user1');

    expect(outcome.restarted).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSessionSetConversationId).toHaveBeenCalledWith('chat1', 'user1', 'sess-1');
  });

  it('should restart with new cwd when needsRestart is true', async () => {
    // 第一次 execute: workspace changed
    mockExecute.mockResolvedValueOnce({
      success: true,
      output: 'workspace ready',
      sessionId: 'sess-setup',
      durationMs: 50,
      needsRestart: true,
      newWorkingDir: '/workspaces/my-repo',
    });
    // 第二次 execute: 正常执行
    mockExecute.mockResolvedValueOnce({
      success: true,
      output: 'bug fixed',
      sessionId: 'sess-main',
      durationMs: 200,
    });

    const outcome = await simulateExecuteClaudeTask('fix the bug', 'chat1', 'user1');

    expect(outcome.restarted).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(2);

    // 第二次 execute 的参数检查
    const secondCall = mockExecute.mock.calls[1];
    expect(secondCall[0]).toBe('chat1:user1');       // sessionKey
    expect(secondCall[1]).toBe('fix the bug');        // 原始 prompt
    expect(secondCall[2]).toBe('/workspaces/my-repo'); // 新 cwd
    expect(secondCall[3]).toBeUndefined();            // 不 resume
    expect(secondCall[5]).toBeUndefined();            // 不传 onWorkspaceChanged
    expect(secondCall[6]).toEqual({ disableWorkspaceTool: true }); // 禁用 workspace tool
  });

  it('should clear conversationId before restart', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'ready', durationMs: 50,
      needsRestart: true, newWorkingDir: '/new/dir',
    });
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-new', durationMs: 100,
    });

    await simulateExecuteClaudeTask('test', 'chat1', 'user1');

    // conversationId 应先被清空，再被设置为新的
    const setCalls = mockSessionSetConversationId.mock.calls;
    expect(setCalls[0]).toEqual(['chat1', 'user1', '']);           // 清空
    expect(setCalls[1]).toEqual(['chat1', 'user1', 'sess-new']);   // 设置新值
  });

  it('should cancel restart if session is no longer busy', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'ready', durationMs: 50,
      needsRestart: true, newWorkingDir: '/new/dir',
    });

    // 模拟用户在 restart 前发了 /stop
    mockSessionGet.mockReturnValue({
      chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
    });

    const outcome = await simulateExecuteClaudeTask('test', 'chat1', 'user1');

    expect(outcome.restarted).toBe(false);
    expect(outcome.reason).toBe('session_not_busy');
    expect(mockExecute).toHaveBeenCalledTimes(1); // 没有第二次 execute
  });

  it('should cancel restart if session is not found', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'ready', durationMs: 50,
      needsRestart: true, newWorkingDir: '/new/dir',
    });

    // 模拟 session 被 /reset 删除
    mockSessionGet.mockReturnValue(undefined);

    const outcome = await simulateExecuteClaudeTask('test', 'chat1', 'user1');

    expect(outcome.restarted).toBe(false);
    expect(outcome.reason).toBe('session_not_busy');
  });

  it('should save restart result sessionId for future resume', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'ready', durationMs: 50,
      needsRestart: true, newWorkingDir: '/new/dir',
    });
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-restart', durationMs: 100,
    });

    await simulateExecuteClaudeTask('test', 'chat1', 'user1');

    // 最后设置的 conversationId 应该是 restart query 的
    const lastCall = mockSessionSetConversationId.mock.calls.at(-1);
    expect(lastCall).toEqual(['chat1', 'user1', 'sess-restart']);
  });
});

// ============================================================
// ensureThread 逻辑测试
//
// 提取 ensureThread 的核心逻辑进行测试:
// - 有 rootId → 复用该话题
// - 无 rootId → 新建话题 + 清空旧 conversationId
// ============================================================

/**
 * 模拟 ensureThread 的核心逻辑
 * (从 event-handler.ts 提取，用于可测试性)
 */
async function simulateEnsureThread(
  chatId: string,
  userId: string,
  messageId: string,
  rootId?: string,
): Promise<string | undefined> {
  const { sessionManager } = await import('../../session/manager.js');
  const { feishuClient } = await import('../client.js');

  sessionManager.getOrCreate(chatId, userId);

  // 1. 用户在已有话题内发消息 — 复用
  if (rootId) {
    sessionManager.setThread(chatId, userId, rootId, rootId);
    return rootId;
  }

  // 2. 用户在主聊天区发消息 — 新会话
  sessionManager.setConversationId(chatId, userId, '');

  const { messageId: botMsgId, threadId } = await feishuClient.replyInThread(
    messageId,
    '🤖 新会话已创建',
  );

  if (threadId && botMsgId) {
    sessionManager.setThread(chatId, userId, threadId, messageId);
    return messageId;
  }

  return undefined;
}

describe('ensureThread session routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReplyInThread.mockResolvedValue({ messageId: 'bot-msg-1', threadId: 'thread-new' });
  });

  it('should reuse existing thread when rootId is provided', async () => {
    mockSessionGetOrCreate.mockReturnValue({
      chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
      threadId: 'thread-old', threadRootMessageId: 'old-root-msg',
      conversationId: 'old-conv-id',
    });

    const result = await simulateEnsureThread('chat1', 'user1', 'msg-1', 'root-msg-in-thread');

    expect(result).toBe('root-msg-in-thread');
    expect(mockSessionSetThread).toHaveBeenCalledWith('chat1', 'user1', 'root-msg-in-thread', 'root-msg-in-thread');
    // 不应清空 conversationId
    expect(mockSessionSetConversationId).not.toHaveBeenCalled();
    // 不应创建新话题
    expect(mockReplyInThread).not.toHaveBeenCalled();
  });

  it('should create new thread and clear conversationId when no rootId — even if old thread exists', async () => {
    // 这是修复的 bug 场景：session 有旧话题信息，但用户在主区发消息
    mockSessionGetOrCreate.mockReturnValue({
      chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
      threadId: 'thread-old', threadRootMessageId: 'old-root-msg',
      conversationId: 'old-conv-id',
    });

    const result = await simulateEnsureThread('chat1', 'user1', 'msg-new');

    // 应创建新话题，返回新消息 ID
    expect(result).toBe('msg-new');
    // 旧 conversationId 应被清空
    expect(mockSessionSetConversationId).toHaveBeenCalledWith('chat1', 'user1', '');
    // 应通过 replyInThread 创建新话题
    expect(mockReplyInThread).toHaveBeenCalledWith('msg-new', '🤖 新会话已创建');
    // 新话题信息应保存到 session
    expect(mockSessionSetThread).toHaveBeenCalledWith('chat1', 'user1', 'thread-new', 'msg-new');
  });

  it('should create new thread for first-time user (no old session data)', async () => {
    mockSessionGetOrCreate.mockReturnValue({
      chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
    });

    const result = await simulateEnsureThread('chat1', 'user1', 'msg-first');

    expect(result).toBe('msg-first');
    expect(mockSessionSetConversationId).toHaveBeenCalledWith('chat1', 'user1', '');
    expect(mockReplyInThread).toHaveBeenCalled();
  });

  it('should fall back to undefined when thread creation fails', async () => {
    mockSessionGetOrCreate.mockReturnValue({
      chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
    });
    mockReplyInThread.mockResolvedValue({ messageId: undefined, threadId: undefined });

    const result = await simulateEnsureThread('chat1', 'user1', 'msg-1');

    expect(result).toBeUndefined();
    // conversationId 仍应被清空（在创建话题之前就清了）
    expect(mockSessionSetConversationId).toHaveBeenCalledWith('chat1', 'user1', '');
  });
});
