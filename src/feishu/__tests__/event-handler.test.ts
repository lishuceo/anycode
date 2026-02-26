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
const mockGetThreadSession = vi.fn();
const mockUpsertThreadSession = vi.fn();
const mockSetThreadConversationId = vi.fn();
const mockSetThreadWorkingDir = vi.fn();
const mockSetThreadRoutingState = vi.fn();
const mockGetRecentSummaries = vi.fn(() => []);
const mockSaveSummary = vi.fn();

vi.mock('../../session/manager.js', () => ({
  sessionManager: {
    get: (...args: unknown[]) => mockSessionGet(...args),
    getOrCreate: (...args: unknown[]) => mockSessionGetOrCreate(...args),
    setWorkingDir: (...args: unknown[]) => mockSessionSetWorkingDir(...args),
    setStatus: (...args: unknown[]) => mockSessionSetStatus(...args),
    setConversationId: (...args: unknown[]) => mockSessionSetConversationId(...args),
    setThread: (...args: unknown[]) => mockSessionSetThread(...args),
    getThreadSession: (...args: unknown[]) => mockGetThreadSession(...args),
    upsertThreadSession: (...args: unknown[]) => mockUpsertThreadSession(...args),
    setThreadConversationId: (...args: unknown[]) => mockSetThreadConversationId(...args),
    setThreadWorkingDir: (...args: unknown[]) => mockSetThreadWorkingDir(...args),
    setThreadRoutingState: (...args: unknown[]) => mockSetThreadRoutingState(...args),
    getRecentSummaries: (...args: unknown[]) => mockGetRecentSummaries(...args),
    saveSummary: (...args: unknown[]) => mockSaveSummary(...args),
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
  const { messageId: botMsgId, threadId } = await feishuClient.replyInThread(
    messageId,
    '🤖 新会话已创建',
  );

  if (threadId && botMsgId) {
    // 不清空全局 conversationId——各 thread 通过 thread_sessions 表独立管理
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

  it('should create new thread without clearing conversationId when no rootId', async () => {
    // thread_sessions 表独立管理每个 thread 的 conversationId，
    // 不需要在创建新话题时清空全局 conversationId
    mockSessionGetOrCreate.mockReturnValue({
      chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
      threadId: 'thread-old', threadRootMessageId: 'old-root-msg',
      conversationId: 'old-conv-id',
    });

    const result = await simulateEnsureThread('chat1', 'user1', 'msg-new');

    // 应创建新话题，返回新消息 ID
    expect(result).toBe('msg-new');
    // 不应清空全局 conversationId（thread_sessions 独立管理）
    expect(mockSessionSetConversationId).not.toHaveBeenCalled();
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
    // 不应清空全局 conversationId
    expect(mockSessionSetConversationId).not.toHaveBeenCalled();
    expect(mockReplyInThread).toHaveBeenCalled();
  });

  it('should fall back to undefined when thread creation fails', async () => {
    mockSessionGetOrCreate.mockReturnValue({
      chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
    });
    mockReplyInThread.mockResolvedValue({ messageId: undefined, threadId: undefined });

    const result = await simulateEnsureThread('chat1', 'user1', 'msg-1');

    expect(result).toBeUndefined();
    // 话题创建失败时不应清空 conversationId，保留续接旧对话的能力
    expect(mockSessionSetConversationId).not.toHaveBeenCalled();
  });
});

// ============================================================
// Thread session 集成测试
//
// 验证 executeClaudeTask 中 thread session 的关键行为：
// - 首条消息创建 thread session
// - 使用 thread session 的 workingDir 和 conversationId
// - session ID 双写（thread_sessions + 全局 sessions）
// - summary 使用正确的 workingDir
// ============================================================

/**
 * 简化版 executeClaudeTask thread session 逻辑
 * (提取关键路径用于可测试性)
 */
async function simulateThreadSessionFlow(
  prompt: string,
  chatId: string,
  userId: string,
  session: { workingDir: string; threadId?: string; conversationId?: string; conversationCwd?: string },
  threadSession?: { workingDir: string; conversationId?: string; conversationCwd?: string },
) {
  const { claudeExecutor } = await import('../../claude/executor.js');
  const { sessionManager } = await import('../../session/manager.js');

  const threadId = session.threadId;

  // 确保 thread_sessions 中有该 thread 的记录
  if (threadId && !threadSession) {
    sessionManager.upsertThreadSession(threadId, chatId, userId, session.workingDir);
  }

  // 工作目录：优先 thread session
  const workingDir = threadSession?.workingDir ?? session.workingDir;

  // Resume 判断：有 threadId 时只用该 thread 自己的 conversationId，
  // 避免跨 thread 串台（不再 fallback 到全局 session）
  const activeConversationId = threadId
    ? threadSession?.conversationId
    : session.conversationId;
  const activeConversationCwd = threadId
    ? threadSession?.conversationCwd
    : session.conversationCwd;
  const canResume = activeConversationId
    && (!activeConversationCwd || activeConversationCwd === workingDir);

  const result = await claudeExecutor.execute(
    `${chatId}:${userId}`, prompt, workingDir,
    canResume ? activeConversationId : undefined,
  );

  // 保存 session ID（双写）
  if (result.sessionId) {
    if (threadId) {
      sessionManager.setThreadConversationId(threadId, result.sessionId, workingDir);
    }
    sessionManager.setConversationId(chatId, userId, result.sessionId, workingDir);
  }

  return { workingDir, canResume, result };
}

describe('executeClaudeTask thread session integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create thread session on first message in thread', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-1', durationMs: 100,
    });

    await simulateThreadSessionFlow(
      'hello', 'chat1', 'user1',
      { workingDir: '/projects/repo-a', threadId: 'thread-1' },
      undefined, // no existing thread session
    );

    expect(mockUpsertThreadSession).toHaveBeenCalledWith(
      'thread-1', 'chat1', 'user1', '/projects/repo-a',
    );
  });

  it('should not re-create thread session if it already exists', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-1', durationMs: 100,
    });

    await simulateThreadSessionFlow(
      'hello', 'chat1', 'user1',
      { workingDir: '/projects/repo-a', threadId: 'thread-1' },
      { workingDir: '/projects/repo-a', conversationId: 'old-conv' },
    );

    expect(mockUpsertThreadSession).not.toHaveBeenCalled();
  });

  it('should use thread session workingDir over global session', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-1', durationMs: 100,
    });

    const outcome = await simulateThreadSessionFlow(
      'hello', 'chat1', 'user1',
      { workingDir: '/global/dir', threadId: 'thread-1' },
      { workingDir: '/thread/specific/dir' },
    );

    expect(outcome.workingDir).toBe('/thread/specific/dir');
    // execute should be called with thread's workingDir
    expect(mockExecute.mock.calls[0][2]).toBe('/thread/specific/dir');
  });

  it('should resume using thread session conversationId', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-new', durationMs: 100,
    });

    const outcome = await simulateThreadSessionFlow(
      'hello', 'chat1', 'user1',
      { workingDir: '/projects/repo-a', threadId: 'thread-1', conversationId: 'global-conv' },
      { workingDir: '/projects/repo-a', conversationId: 'thread-conv', conversationCwd: '/projects/repo-a' },
    );

    expect(outcome.canResume).toBe(true);
    // Should resume with thread's conversationId, not global
    expect(mockExecute.mock.calls[0][3]).toBe('thread-conv');
  });

  it('should not resume when thread conversationCwd does not match workingDir', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-new', durationMs: 100,
    });

    const outcome = await simulateThreadSessionFlow(
      'hello', 'chat1', 'user1',
      { workingDir: '/projects/repo-a', threadId: 'thread-1' },
      { workingDir: '/projects/repo-a', conversationId: 'old-conv', conversationCwd: '/projects/repo-DIFFERENT' },
    );

    expect(outcome.canResume).toBe(false);
    expect(mockExecute.mock.calls[0][3]).toBeUndefined();
  });

  it('should double-write sessionId to both thread and global sessions', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-1', durationMs: 100,
    });

    await simulateThreadSessionFlow(
      'hello', 'chat1', 'user1',
      { workingDir: '/projects/repo-a', threadId: 'thread-1' },
      { workingDir: '/projects/repo-a' },
    );

    expect(mockSetThreadConversationId).toHaveBeenCalledWith('thread-1', 'sess-1', '/projects/repo-a');
    expect(mockSessionSetConversationId).toHaveBeenCalledWith('chat1', 'user1', 'sess-1', '/projects/repo-a');
  });

  it('should NOT fallback to global session conversationId when thread has none (cross-thread isolation)', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-new', durationMs: 100,
    });

    // Thread exists but has no conversationId; global session has one from another thread
    const outcome = await simulateThreadSessionFlow(
      'hello', 'chat1', 'user1',
      { workingDir: '/projects/repo-a', threadId: 'thread-2', conversationId: 'conv-from-other-thread' },
      { workingDir: '/projects/repo-a' }, // threadSession with no conversationId
    );

    // Must NOT resume — thread has no own conversationId
    expect(outcome.canResume).toBeFalsy();
    expect(mockExecute.mock.calls[0][3]).toBeUndefined();
  });

  it('should use global session conversationId when there is no threadId (main chat)', async () => {
    mockExecute.mockResolvedValueOnce({
      success: true, output: 'done', sessionId: 'sess-1', durationMs: 100,
    });

    // No threadId → main chat, should use global session conversationId
    const outcome = await simulateThreadSessionFlow(
      'hello', 'chat1', 'user1',
      { workingDir: '/projects/repo-a', conversationId: 'global-conv', conversationCwd: '/projects/repo-a' },
      undefined,
    );

    expect(outcome.canResume).toBe(true);
    expect(mockExecute.mock.calls[0][3]).toBe('global-conv');
  });
});

// ============================================================
// Per-thread workspace isolation tests
//
// 直接测试 src/workspace/isolation.ts 导出的生产函数，
// 而非重新实现逻辑。
// ============================================================

// Mock node:fs for isolation tests (已在上方 mock 过 workspace/manager)
const mockExistsSync = vi.fn(() => true);
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  realpathSync: vi.fn((p: string) => p), // 测试环境无真实文件，直接返回原路径
}));

// 获取 setupWorkspace mock 引用
const { setupWorkspace: setupWorkspaceMock } = await import('../../workspace/manager.js');

// 导入生产函数
const { isAutoWorkspacePath, ensureIsolatedWorkspace } = await import('../../workspace/isolation.js');

describe('isAutoWorkspacePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('should return true for paths under workspace baseDir', () => {
    expect(isAutoWorkspacePath('/tmp/workspaces/repo-abc123')).toBe(true);
  });

  it('should return false for paths outside workspace baseDir', () => {
    expect(isAutoWorkspacePath('/tmp/work/my-repo')).toBe(false);
  });

  it('should return false for the base dir itself (not a subdirectory)', () => {
    expect(isAutoWorkspacePath('/tmp/workspaces')).toBe(false);
  });

  it('should return false for similar prefix but different dir', () => {
    expect(isAutoWorkspacePath('/tmp/workspaces-backup/repo')).toBe(false);
  });
});

describe('ensureIsolatedWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('should return as-is when path is already under workspace baseDir', () => {
    const result = ensureIsolatedWorkspace('/tmp/workspaces/repo-abc123');
    expect(result).toEqual({ workingDir: '/tmp/workspaces/repo-abc123' });
    expect(setupWorkspaceMock).not.toHaveBeenCalled();
  });

  it('should clone to workspace when path is a git repo outside workspace baseDir', () => {
    mockExistsSync.mockReturnValue(true); // .git exists
    (setupWorkspaceMock as ReturnType<typeof vi.fn>).mockReturnValue({
      workspacePath: '/tmp/workspaces/my-repo-writable-abc123',
      branch: 'feat/claude-session-abc123',
      repoName: 'my-repo',
    });

    const result = ensureIsolatedWorkspace('/tmp/work/my-repo', 'writable');

    expect(result).toEqual({ workingDir: '/tmp/workspaces/my-repo-writable-abc123' });
    expect(setupWorkspaceMock).toHaveBeenCalledWith({
      localPath: '/tmp/work/my-repo',
      mode: 'writable',
    });
  });

  it('should pass readonly mode to setupWorkspace', () => {
    mockExistsSync.mockReturnValue(true);
    (setupWorkspaceMock as ReturnType<typeof vi.fn>).mockReturnValue({
      workspacePath: '/tmp/workspaces/my-repo-readonly-abc123',
      branch: 'main',
      repoName: 'my-repo',
    });

    const result = ensureIsolatedWorkspace('/tmp/work/my-repo', 'readonly');

    expect(result).toEqual({ workingDir: '/tmp/workspaces/my-repo-readonly-abc123' });
    expect(setupWorkspaceMock).toHaveBeenCalledWith({
      localPath: '/tmp/work/my-repo',
      mode: 'readonly',
    });
  });

  it('should return as-is when path is not a git repo', () => {
    mockExistsSync.mockReturnValue(false); // no .git

    const result = ensureIsolatedWorkspace('/tmp/work');

    expect(result).toEqual({ workingDir: '/tmp/work' });
    expect(setupWorkspaceMock).not.toHaveBeenCalled();
  });

  it('should throw in writable mode when setupWorkspace fails', () => {
    mockExistsSync.mockReturnValue(true); // .git exists
    (setupWorkspaceMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('clone failed');
    });

    expect(() => ensureIsolatedWorkspace('/tmp/work/my-repo', 'writable'))
      .toThrow('无法创建隔离工作区');
  });

  it('should fallback to original path in readonly mode when setupWorkspace fails', () => {
    mockExistsSync.mockReturnValue(true); // .git exists
    (setupWorkspaceMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('clone failed');
    });

    const result = ensureIsolatedWorkspace('/tmp/work/my-repo', 'readonly');

    expect(result).toEqual({ workingDir: '/tmp/work/my-repo' });
  });
});

// ============================================================
// executePipelineTask routing + isolation 测试
//
// 验证 /dev 管道命令的路由+隔离流程：
// - 创建话题 → 发路由反馈 → 路由决策 → 隔离工作区 → 创建管道
// ============================================================

/**
 * 模拟 executePipelineTask 的核心逻辑
 * (从 event-handler.ts 提取的路由+隔离逻辑，用于可测试性)
 */
async function simulateExecutePipelineTask(
  prompt: string,
  chatId: string,
  userId: string,
  messageId: string,
  rootId: string | undefined,
  deps: {
    ensureThread: (chatId: string, userId: string, messageId: string, rootId?: string) => Promise<{ threadReplyMsgId?: string; greetingMsgId?: string }>;
    routeWorkspace: (prompt: string, chatId: string, userId: string, rootId?: string) => Promise<{ decision: string; workdir?: string; mode?: string; question?: string }>;
  },
) {
  const { sessionManager } = await import('../../session/manager.js');
  const { feishuClient } = await import('../client.js');

  let threadReplyMsgId: string | undefined;

  try {
    // 1. ensureThread
    const threadResult = await deps.ensureThread(chatId, userId, messageId, rootId);
    threadReplyMsgId = threadResult.threadReplyMsgId;

    // 2. Routing feedback
    if (threadReplyMsgId) {
      await feishuClient.replyTextInThread(threadReplyMsgId, '🔍 正在分析工作目录...');
    }

    // 3. Route workspace
    const decision = await deps.routeWorkspace(prompt, chatId, userId, rootId);

    // 4. Handle need_clarification — save routing state for follow-up
    if (decision.decision === 'need_clarification') {
      const question = decision.question || '请提供更多信息，我需要知道你想要操作哪个仓库或项目。';
      if (threadReplyMsgId) {
        if (!sessionManager.getThreadSession(threadReplyMsgId)) {
          sessionManager.upsertThreadSession(threadReplyMsgId, chatId, userId, '/tmp/work');
        }
        sessionManager.setThreadRoutingState(threadReplyMsgId, {
          status: 'pending_clarification',
          originalPrompt: prompt,
          question,
          retryCount: 0,
        });
        await feishuClient.replyTextInThread(threadReplyMsgId, question);
      } else {
        await feishuClient.replyText(messageId, question);
      }
      return { aborted: true, reason: 'need_clarification' as const };
    }

    let workingDir = decision.workdir || '/tmp/work';

    // 5. Ensure isolated workspace
    try {
      const isolated = ensureIsolatedWorkspace(workingDir, (decision.mode as 'readonly' | 'writable') || 'writable');
      workingDir = isolated.workingDir;
    } catch (err) {
      const errorMsg = `❌ 无法创建隔离工作区: ${(err as Error).message}`;
      if (threadReplyMsgId) {
        await feishuClient.replyTextInThread(threadReplyMsgId, errorMsg);
      } else {
        await feishuClient.replyText(messageId, errorMsg);
      }
      return { aborted: true, reason: 'isolation_failed' as const };
    }

    // 6. Return pipeline params (would be passed to createPendingPipeline)
    return {
      aborted: false as const,
      pipelineParams: {
        chatId, userId, messageId, rootId, prompt, workingDir, threadReplyMsgId,
      },
    };
  } catch (err) {
    return { aborted: true, reason: 'error' as const, error: (err as Error).message };
  }
}

describe('executePipelineTask routing + isolation', () => {
  const mockEnsureThread = vi.fn();
  const mockRouteWs = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockSessionGetOrCreate.mockReturnValue({
      chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
      threadId: 'thread-1',
    });
    mockEnsureThread.mockResolvedValue({ threadReplyMsgId: 'root-msg-1', greetingMsgId: 'greeting-1' });
  });

  it('should send routing feedback before routing', async () => {
    mockRouteWs.mockResolvedValue({ decision: 'use_default', workdir: '/tmp/work' });
    mockExistsSync.mockReturnValue(false); // no .git → skip isolation clone

    await simulateExecutePipelineTask(
      'build feature', 'chat1', 'user1', 'msg1', undefined,
      { ensureThread: mockEnsureThread, routeWorkspace: mockRouteWs },
    );

    // Routing feedback should be sent
    expect(mockReplyTextInThread).toHaveBeenCalledWith('root-msg-1', '🔍 正在分析工作目录...');
    // And routing should have been called
    expect(mockRouteWs).toHaveBeenCalledWith('build feature', 'chat1', 'user1', undefined);
  });

  it('should handle need_clarification by saving routing state and replying', async () => {
    mockRouteWs.mockResolvedValue({
      decision: 'need_clarification',
      question: '你想操作哪个仓库？',
    });

    const result = await simulateExecutePipelineTask(
      'build something', 'chat1', 'user1', 'msg1', undefined,
      { ensureThread: mockEnsureThread, routeWorkspace: mockRouteWs },
    );

    expect(result.aborted).toBe(true);
    expect(result.reason).toBe('need_clarification');
    expect(mockReplyTextInThread).toHaveBeenCalledWith('root-msg-1', '你想操作哪个仓库？');
    // Should save routing state for follow-up messages
    expect(mockUpsertThreadSession).toHaveBeenCalledWith('root-msg-1', 'chat1', 'user1', '/tmp/work');
    expect(mockSetThreadRoutingState).toHaveBeenCalledWith('root-msg-1', {
      status: 'pending_clarification',
      originalPrompt: 'build something',
      question: '你想操作哪个仓库？',
      retryCount: 0,
    });
  });

  it('should use default question when need_clarification has no question', async () => {
    mockRouteWs.mockResolvedValue({ decision: 'need_clarification' });

    const result = await simulateExecutePipelineTask(
      'do something', 'chat1', 'user1', 'msg1', undefined,
      { ensureThread: mockEnsureThread, routeWorkspace: mockRouteWs },
    );

    expect(result.aborted).toBe(true);
    expect(mockReplyTextInThread).toHaveBeenCalledWith(
      'root-msg-1',
      '请提供更多信息，我需要知道你想要操作哪个仓库或项目。',
    );
  });

  it('should use routing result workdir and ensure isolation', async () => {
    mockRouteWs.mockResolvedValue({
      decision: 'use_existing',
      workdir: '/tmp/work/my-repo',
      mode: 'writable',
    });
    (setupWorkspaceMock as ReturnType<typeof vi.fn>).mockReturnValue({
      workspacePath: '/tmp/workspaces/my-repo-abc',
      branch: 'feat/abc',
      repoName: 'my-repo',
    });

    const result = await simulateExecutePipelineTask(
      'fix bug in my-repo', 'chat1', 'user1', 'msg1', undefined,
      { ensureThread: mockEnsureThread, routeWorkspace: mockRouteWs },
    );

    expect(result.aborted).toBe(false);
    expect(result.pipelineParams.workingDir).toBe('/tmp/workspaces/my-repo-abc');
    expect(result.pipelineParams.threadReplyMsgId).toBe('root-msg-1');
  });

  it('should handle isolation failure gracefully', async () => {
    mockRouteWs.mockResolvedValue({
      decision: 'use_existing',
      workdir: '/tmp/work/my-repo',
      mode: 'writable',
    });
    (setupWorkspaceMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = await simulateExecutePipelineTask(
      'fix bug', 'chat1', 'user1', 'msg1', undefined,
      { ensureThread: mockEnsureThread, routeWorkspace: mockRouteWs },
    );

    expect(result.aborted).toBe(true);
    expect(result.reason).toBe('isolation_failed');
    expect(mockReplyTextInThread).toHaveBeenCalledWith(
      'root-msg-1',
      expect.stringContaining('无法创建隔离工作区'),
    );
  });

  it('should pass threadReplyMsgId through to pipeline params', async () => {
    mockRouteWs.mockResolvedValue({ decision: 'use_default', workdir: '/tmp/work' });
    mockExistsSync.mockReturnValue(false);

    const result = await simulateExecutePipelineTask(
      'task', 'chat1', 'user1', 'msg1', 'existing-root',
      { ensureThread: mockEnsureThread, routeWorkspace: mockRouteWs },
    );

    expect(result.aborted).toBe(false);
    expect(result.pipelineParams.threadReplyMsgId).toBe('root-msg-1');
  });

  it('should use default workdir when routing returns no workdir', async () => {
    mockRouteWs.mockResolvedValue({ decision: 'use_default' });
    mockExistsSync.mockReturnValue(false);

    const result = await simulateExecutePipelineTask(
      'general task', 'chat1', 'user1', 'msg1', undefined,
      { ensureThread: mockEnsureThread, routeWorkspace: mockRouteWs },
    );

    expect(result.aborted).toBe(false);
    expect(result.pipelineParams.workingDir).toBe('/tmp/work');
  });

  it('should reply via replyText when no threadReplyMsgId on need_clarification', async () => {
    mockEnsureThread.mockResolvedValue({ threadReplyMsgId: undefined });
    mockRouteWs.mockResolvedValue({
      decision: 'need_clarification',
      question: '哪个仓库？',
    });

    await simulateExecutePipelineTask(
      'task', 'chat1', 'user1', 'msg1', undefined,
      { ensureThread: mockEnsureThread, routeWorkspace: mockRouteWs },
    );

    expect(mockReplyTextInThread).not.toHaveBeenCalledWith(expect.anything(), '哪个仓库？');
    expect(mockReplyText).toHaveBeenCalledWith('msg1', '哪个仓库？');
    // Should NOT save routing state when no thread
    expect(mockSetThreadRoutingState).not.toHaveBeenCalled();
  });

  it('should catch and report errors from createPendingPipeline failures', async () => {
    mockRouteWs.mockRejectedValue(new Error('routing crashed'));

    const result = await simulateExecutePipelineTask(
      'task', 'chat1', 'user1', 'msg1', undefined,
      { ensureThread: mockEnsureThread, routeWorkspace: mockRouteWs },
    );

    expect(result.aborted).toBe(true);
    expect(result.reason).toBe('error');
  });
});
