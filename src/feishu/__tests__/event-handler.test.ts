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
    getRecentSummaries: (...args: unknown[]) => mockGetRecentSummaries(...args),
    saveSummary: (...args: unknown[]) => mockSaveSummary(...args),
    reset: vi.fn(),
  },
}));

vi.mock('../../session/queue.js', () => {
  // 简化版 TaskQueue 用于测试
  const _queues = new Map<string, Array<{ resolve: (v: string) => void; reject: (e: Error) => void }>>();
  return {
    taskQueue: {
      enqueue: vi.fn((_chatId: string, _userId: string, _msg: string, _msgId: string) => {
        return new Promise<string>((_resolve, _reject) => {
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
    db: { pipelineDbPath: ':memory:' },
    agent: { bindings: [], groupConfigs: {} },
    chat: { historyMaxCount: 10, historyMaxChars: 8000 },
    memory: { enabled: false },
  },
  isMultiBotMode: vi.fn(() => false),
}));

// event-handler.ts 的依赖链需要以下 mock（供 makeQueueKey 导入使用）
vi.mock('../../pipeline/store.js', () => ({
  pipelineStore: { get: vi.fn(), findPendingByChat: vi.fn(), tryStart: vi.fn() },
}));
vi.mock('../../pipeline/runner.js', () => ({
  createPendingPipeline: vi.fn(), startPipeline: vi.fn(),
  abortPipeline: vi.fn(), cancelPipeline: vi.fn(), retryPipeline: vi.fn(),
}));
vi.mock('../../agent/router.js', () => ({
  resolveAgent: vi.fn(() => 'dev'), shouldRespond: vi.fn(() => true),
}));
vi.mock('../../agent/registry.js', () => ({
  agentRegistry: { get: vi.fn(), getOrThrow: vi.fn(), allIds: vi.fn(() => []) },
}));
vi.mock('../multi-account.js', () => ({
  accountManager: { getAllBotOpenIds: vi.fn(() => new Set()), getBotOpenId: vi.fn() },
}));
vi.mock('../bot-registry.js', () => ({
  chatBotRegistry: { getBots: vi.fn(() => []), addBot: vi.fn(), removeBot: vi.fn(), clearChat: vi.fn() },
}));
vi.mock('../approval.js', () => ({
  checkAndRequestApproval: vi.fn(() => true),
  handleApprovalTextCommand: vi.fn(() => false),
  handleApprovalCardAction: vi.fn(),
  setOnApproved: vi.fn(),
}));
vi.mock('../thread-context.js', () => ({
  resolveThreadContext: vi.fn(),
}));
vi.mock('../../agent/config-loader.js', () => ({
  readPersonaFile: vi.fn(), loadKnowledgeContent: vi.fn(),
}));
vi.mock('../../agent/tools/discussion.js', () => ({
  createDiscussionMcpServer: vi.fn(),
}));
vi.mock('../oauth.js', () => ({
  generateAuthUrl: vi.fn(), hasCallbackUrl: vi.fn(), handleManualCode: vi.fn(),
}));
vi.mock('../../memory/injector.js', () => ({ injectMemories: vi.fn(() => '') }));
vi.mock('../../memory/extractor.js', () => ({ extractMemories: vi.fn() }));
vi.mock('../../memory/commands.js', () => ({
  handleMemoryCommand: vi.fn(), handleMemoryCardAction: vi.fn(),
}));
vi.mock('../../workspace/identity.js', () => ({ getRepoIdentity: vi.fn((p: string) => p) }));
vi.mock('../../utils/quick-ack.js', () => ({ generateQuickAck: vi.fn() }));
vi.mock('../../utils/thread-relevance.js', () => ({ checkThreadRelevance: vi.fn() }));

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
// formatConversationTrace 测试
// ============================================================

// Import the real exported function
const { formatConversationTrace } = await import('../event-handler.js');

describe('formatConversationTrace', () => {
  it('should format conversation trace with text and tool calls', () => {
    const trace = [
      {
        text: '用户想在 repo-X 工作',
        toolCalls: [
          { id: 'tc1', name: 'Bash', input: { command: 'ls /projects' }, result: 'repo-X/\nrepo-Y/' },
          { id: 'tc2', name: 'Read', input: { file_path: '/projects/repo-X/package.json' }, result: '{"name": "repo-x"}' },
        ],
      },
      {
        text: '确认是 repo-X',
        toolCalls: [],
      },
    ];

    const result = formatConversationTrace(trace);

    expect(result).toContain('用户想在 repo-X 工作');
    expect(result).toContain('[Bash] ls /projects');
    expect(result).toContain('repo-X/');
    expect(result).toContain('[Read] /projects/repo-X/package.json');
    expect(result).toContain('"name": "repo-x"');
    expect(result).toContain('确认是 repo-X');
  });

  it('should return empty string for empty trace', () => {
    expect(formatConversationTrace([])).toBe('');
    expect(formatConversationTrace(undefined)).toBe('');
  });

  it('should truncate total output to 15KB', () => {
    const longResult = 'x'.repeat(20000);
    const trace = [
      { text: '', toolCalls: [{ id: 'tc1', name: 'Bash', input: { command: 'cat big' }, result: longResult }] },
    ];
    const result = formatConversationTrace(trace);
    expect(result.length).toBeLessThanOrEqual(15000);
  });

  it('should handle Grep tool input format', () => {
    const trace = [
      { text: '', toolCalls: [{ id: 'tc1', name: 'Grep', input: { pattern: 'TODO', path: '/src' }, result: 'match1' }] },
    ];
    const result = formatConversationTrace(trace);
    expect(result).toContain('[Grep] TODO in /src');
  });
});

// ============================================================
// parseMessage empty @mention 测试
//
// 验证：纯 @bot 消息（无附带文字）不应被丢弃。
// parseMessage 是私有函数，这里提取其空消息判断逻辑进行测试。
// ============================================================

describe('parseMessage empty @mention handling', () => {
  /**
   * 模拟 parseMessage 中清理 mention 后的空消息判断逻辑
   * (从 event-handler.ts 提取)
   */
  function shouldDropMessage(text: string, images: unknown[] | undefined, mentionedBot: boolean): boolean {
    // 对应 event-handler.ts 中的:
    // if (!text.trim() && !images?.length && !mentionedBot) return null;
    return !text.trim() && !images?.length && !mentionedBot;
  }

  it('should drop message with no text, no images, no bot mention', () => {
    expect(shouldDropMessage('', undefined, false)).toBe(true);
  });

  it('should NOT drop message when bot is mentioned even if text is empty', () => {
    expect(shouldDropMessage('', undefined, true)).toBe(false);
  });

  it('should NOT drop message with text content', () => {
    expect(shouldDropMessage('hello', undefined, false)).toBe(false);
  });

  it('should NOT drop message with images', () => {
    expect(shouldDropMessage('', [{ data: 'base64...', mediaType: 'image/png' }], false)).toBe(false);
  });

  it('should NOT drop whitespace-only message when bot is mentioned', () => {
    expect(shouldDropMessage('   ', undefined, true)).toBe(false);
  });
});

// ============================================================
// 单 bot 模式群聊图片/文档消息 @mention 过滤回归测试
//
// 回归 PR #220 的 BUG：群聊中纯图片/文档消息不应绕过 @mention 检查
// 正确行为：
//   - 主聊天区：没 @bot 的图片消息 → 不响应（无论有没有图片）
//   - 话题内 session 创建者：图片消息 → 放行（无需语义判断）
//   - 话题内非 session 创建者：图片消息 → 不响应
// ============================================================

describe('single-bot group image/doc @mention filtering (regression PR #220)', () => {
  /**
   * 模拟 event-handler.ts 第 778-796 行的单 bot 群聊过滤逻辑。
   *
   * @returns 'allow' 放行 | 'block' 拦截 | 'semantic_check' 需语义判断
   */
  function singleBotGroupFilter(params: {
    chatType: string;
    mentionedBot: boolean;
    threadId?: string;
    hasThreadSession: boolean;
    isSessionCreatorOrOwner: boolean;
    hasImages: boolean;
    hasDocuments: boolean;
  }): 'allow' | 'block' | 'semantic_check' {
    const { chatType, mentionedBot, threadId, hasThreadSession, isSessionCreatorOrOwner, hasImages, hasDocuments } = params;

    // 非群聊 或 已 @bot → 直接放行
    if (chatType !== 'group' || mentionedBot) return 'allow';

    // 群聊且没 @bot — 检查话题
    const ts = threadId && hasThreadSession;
    if (!ts || !isSessionCreatorOrOwner) return 'block';

    // 话题内 session 创建者
    if (hasImages || hasDocuments) return 'allow';  // 图片/文档直接放行
    return 'semantic_check';  // 文本消息需语义判断
  }

  // --- 主聊天区（无话题）---

  it('should BLOCK image in main chat without @mention', () => {
    expect(singleBotGroupFilter({
      chatType: 'group', mentionedBot: false,
      hasThreadSession: false, isSessionCreatorOrOwner: false,
      hasImages: true, hasDocuments: false,
    })).toBe('block');
  });

  it('should BLOCK document in main chat without @mention', () => {
    expect(singleBotGroupFilter({
      chatType: 'group', mentionedBot: false,
      hasThreadSession: false, isSessionCreatorOrOwner: false,
      hasImages: false, hasDocuments: true,
    })).toBe('block');
  });

  it('should ALLOW image in main chat WITH @mention', () => {
    expect(singleBotGroupFilter({
      chatType: 'group', mentionedBot: true,
      hasThreadSession: false, isSessionCreatorOrOwner: false,
      hasImages: true, hasDocuments: false,
    })).toBe('allow');
  });

  // --- 话题内 session 创建者 ---

  it('should ALLOW image in thread from session creator (skip semantic check)', () => {
    expect(singleBotGroupFilter({
      chatType: 'group', mentionedBot: false,
      threadId: 'thread-1', hasThreadSession: true, isSessionCreatorOrOwner: true,
      hasImages: true, hasDocuments: false,
    })).toBe('allow');
  });

  it('should ALLOW document in thread from session creator', () => {
    expect(singleBotGroupFilter({
      chatType: 'group', mentionedBot: false,
      threadId: 'thread-1', hasThreadSession: true, isSessionCreatorOrOwner: true,
      hasImages: false, hasDocuments: true,
    })).toBe('allow');
  });

  it('should require SEMANTIC_CHECK for text in thread from session creator', () => {
    expect(singleBotGroupFilter({
      chatType: 'group', mentionedBot: false,
      threadId: 'thread-1', hasThreadSession: true, isSessionCreatorOrOwner: true,
      hasImages: false, hasDocuments: false,
    })).toBe('semantic_check');
  });

  // --- 话题内非 session 创建者 ---

  it('should BLOCK image in thread from non-session-creator', () => {
    expect(singleBotGroupFilter({
      chatType: 'group', mentionedBot: false,
      threadId: 'thread-1', hasThreadSession: true, isSessionCreatorOrOwner: false,
      hasImages: true, hasDocuments: false,
    })).toBe('block');
  });

  // --- 非群聊（私聊）---

  it('should ALLOW image in p2p chat without @mention', () => {
    expect(singleBotGroupFilter({
      chatType: 'p2p', mentionedBot: false,
      hasThreadSession: false, isSessionCreatorOrOwner: false,
      hasImages: true, hasDocuments: false,
    })).toBe('allow');
  });
});

// ============================================================
// makeQueueKey + 并行执行策略测试
//
// 使用生产代码导出的 makeQueueKey，测试 handleMessageEvent 中
// 的 perMessageParallel 分支逻辑：
// - thread 模式无 threadId：用 messageId 区分（per-message 并行）
// - thread 模式有 threadId：同 thread 串行
// - direct 模式无 threadId：用 userId 区分（per-user 并行）
// ============================================================

// 导入生产代码的 makeQueueKey
const { makeQueueKey } = (await import('../event-handler.js'))._testing;

describe('queue key construction for parallel execution', () => {
  /**
   * 模拟 handleMessageEvent 中 queueKey 的构建分支逻辑，
   * 内部调用生产代码的 makeQueueKey。
   */
  function buildQueueKey(params: {
    chatId: string;
    threadId?: string;
    agentId?: string;
    userId?: string;
    messageId: string;
    replyMode: 'direct' | 'thread';
  }): string {
    const { chatId, threadId, agentId = 'dev', userId, messageId, replyMode } = params;
    const isDirectMode = replyMode === 'direct';
    const perMessageParallel = !threadId && !isDirectMode;

    return perMessageParallel
      ? makeQueueKey(chatId, undefined, agentId, messageId)
      : makeQueueKey(chatId, threadId, agentId, isDirectMode ? userId : undefined);
  }

  it('p2p messages without threadId should get unique queue keys (parallel)', () => {
    const key1 = buildQueueKey({ chatId: 'chat1', messageId: 'msg1', replyMode: 'thread' });
    const key2 = buildQueueKey({ chatId: 'chat1', messageId: 'msg2', replyMode: 'thread' });
    const key3 = buildQueueKey({ chatId: 'chat1', messageId: 'msg3', replyMode: 'thread' });

    expect(key1).not.toBe(key2);
    expect(key2).not.toBe(key3);
    expect(key1).not.toBe(key3);
  });

  it('group messages without threadId should also get unique keys (parallel)', () => {
    const key1 = buildQueueKey({ chatId: 'group1', messageId: 'msg1', userId: 'u1', replyMode: 'thread' });
    const key2 = buildQueueKey({ chatId: 'group1', messageId: 'msg2', userId: 'u2', replyMode: 'thread' });

    expect(key1).not.toBe(key2);
  });

  it('messages with threadId should share queue key (serial within thread)', () => {
    const key1 = buildQueueKey({ chatId: 'chat1', threadId: 'th1', messageId: 'msg1', replyMode: 'thread' });
    const key2 = buildQueueKey({ chatId: 'chat1', threadId: 'th1', messageId: 'msg2', replyMode: 'thread' });

    expect(key1).toBe(key2);
  });

  it('different threads should have different queue keys (parallel across threads)', () => {
    const key1 = buildQueueKey({ chatId: 'chat1', threadId: 'th1', messageId: 'msg1', replyMode: 'thread' });
    const key2 = buildQueueKey({ chatId: 'chat1', threadId: 'th2', messageId: 'msg2', replyMode: 'thread' });

    expect(key1).not.toBe(key2);
  });

  it('direct mode without threadId should use userId (per-user serial)', () => {
    const key1 = buildQueueKey({ chatId: 'chat1', messageId: 'msg1', userId: 'u1', replyMode: 'direct' });
    const key2 = buildQueueKey({ chatId: 'chat1', messageId: 'msg2', userId: 'u1', replyMode: 'direct' });
    const key3 = buildQueueKey({ chatId: 'chat1', messageId: 'msg3', userId: 'u2', replyMode: 'direct' });

    // Same user → same key (serial)
    expect(key1).toBe(key2);
    // Different user → different key (parallel)
    expect(key1).not.toBe(key3);
  });

  it('direct mode with threadId should use threadId', () => {
    const key1 = buildQueueKey({ chatId: 'chat1', threadId: 'th1', messageId: 'msg1', userId: 'u1', replyMode: 'direct' });
    const key2 = buildQueueKey({ chatId: 'chat1', threadId: 'th1', messageId: 'msg2', userId: 'u1', replyMode: 'direct' });

    expect(key1).toBe(key2);
  });
});
