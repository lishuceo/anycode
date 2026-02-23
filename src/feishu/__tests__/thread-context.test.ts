// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockSessionGet = vi.fn();
const mockSessionGetOrCreate = vi.fn();
const mockSessionSetWorkingDir = vi.fn();
const mockSessionSetStatus = vi.fn();
const mockSessionSetThread = vi.fn();
const mockGetThreadSession = vi.fn();
const mockUpsertThreadSession = vi.fn();
const mockSetThreadWorkingDir = vi.fn();
const mockSetThreadRoutingState = vi.fn();
const mockClearThreadRoutingState = vi.fn();
const mockMarkThreadRoutingCompleted = vi.fn();
const mockTouchThreadSession = vi.fn();
const mockSetThreadApproved = vi.fn();

vi.mock('../../session/manager.js', () => ({
  sessionManager: {
    get: (...args: unknown[]) => mockSessionGet(...args),
    getOrCreate: (...args: unknown[]) => mockSessionGetOrCreate(...args),
    setWorkingDir: (...args: unknown[]) => mockSessionSetWorkingDir(...args),
    setStatus: (...args: unknown[]) => mockSessionSetStatus(...args),
    setThread: (...args: unknown[]) => mockSessionSetThread(...args),
    getThreadSession: (...args: unknown[]) => mockGetThreadSession(...args),
    upsertThreadSession: (...args: unknown[]) => mockUpsertThreadSession(...args),
    setThreadWorkingDir: (...args: unknown[]) => mockSetThreadWorkingDir(...args),
    setThreadRoutingState: (...args: unknown[]) => mockSetThreadRoutingState(...args),
    clearThreadRoutingState: (...args: unknown[]) => mockClearThreadRoutingState(...args),
    markThreadRoutingCompleted: (...args: unknown[]) => mockMarkThreadRoutingCompleted(...args),
    touchThreadSession: (...args: unknown[]) => mockTouchThreadSession(...args),
    setThreadApproved: (...args: unknown[]) => mockSetThreadApproved(...args),
  },
}));

const mockEnsureThread = vi.fn(() => Promise.resolve({
  threadRootMsgId: 'root-msg-1',
  greetingMsgId: 'greeting-1',
}));
vi.mock('../thread-utils.js', () => ({
  ensureThread: (...args: unknown[]) => mockEnsureThread(...args),
}));

const mockRouteWorkspace = vi.fn();
vi.mock('../../claude/router.js', () => ({
  routeWorkspace: (...args: unknown[]) => mockRouteWorkspace(...args),
}));

const mockEnsureIsolatedWorkspace = vi.fn((dir: string) => dir);
vi.mock('../../workspace/isolation.js', () => ({
  isAutoWorkspacePath: vi.fn(() => false),
  ensureIsolatedWorkspace: (...args: unknown[]) => mockEnsureIsolatedWorkspace(...args),
}));

vi.mock('../approval.js', () => ({
  consumePreApproved: vi.fn(() => false),
}));

const mockReplyText = vi.fn();
const mockReplyTextInThread = vi.fn();
const mockUpdateCard = vi.fn(() => Promise.resolve(true));

vi.mock('../client.js', () => ({
  feishuClient: {
    replyText: (...args: unknown[]) => mockReplyText(...args),
    replyTextInThread: (...args: unknown[]) => mockReplyTextInThread(...args),
    updateCard: (...args: unknown[]) => mockUpdateCard(...args),
  },
}));

vi.mock('../message-builder.js', () => ({
  buildGreetingCardReady: vi.fn(() => ({ type: 'greeting_ready' })),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: {
    claude: { defaultWorkDir: '/tmp/work' },
    workspace: { baseDir: '/tmp/workspaces', branchPrefix: 'feat/test' },
  },
}));

// Import after mocks
const { resolveThreadContext } = await import('../thread-context.js');

// ============================================================
// Tests
// ============================================================

describe('resolveThreadContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionGetOrCreate.mockReturnValue({
      chatId: 'chat1', userId: 'user1', workingDir: '/tmp/work', status: 'idle',
      threadId: 'omt_thread_1',
    });
    mockGetThreadSession.mockReturnValue(undefined);
  });

  describe('thread_id propagation to ensureThread', () => {
    it('should pass threadId to ensureThread', async () => {
      mockGetThreadSession.mockReturnValue({
        threadId: 'omt_thread_1', workingDir: '/tmp/work',
        routingCompleted: true,
      });
      mockRouteWorkspace.mockResolvedValue({ decision: 'use_default', workdir: '/tmp/work' });

      await resolveThreadContext({
        prompt: 'hello',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg-1',
        rootId: 'om_root_id',
        threadId: 'omt_real_thread',
      });

      expect(mockEnsureThread).toHaveBeenCalledWith(
        'chat1', 'user1', 'msg-1',
        'om_root_id',        // rootId for reply target
        'omt_real_thread',   // threadId for identification
      );
    });

    it('should work without threadId (fallback to rootId)', async () => {
      mockGetThreadSession.mockReturnValue({
        threadId: 'omt_thread_1', workingDir: '/tmp/work',
        routingCompleted: true,
      });

      await resolveThreadContext({
        prompt: 'hello',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg-1',
        rootId: 'om_root_id',
      });

      expect(mockEnsureThread).toHaveBeenCalledWith(
        'chat1', 'user1', 'msg-1',
        'om_root_id',
        undefined,
      );
    });

    it('should propagate ensureThread error when rootId present but threadId missing', async () => {
      // ensureThread throws when rootId exists without threadId (Feishu event malformed)
      mockEnsureThread.mockRejectedValueOnce(
        new Error('ensureThread: rootId present but threadId missing'),
      );

      await expect(
        resolveThreadContext({
          prompt: 'hello',
          chatId: 'chat1',
          userId: 'user1',
          messageId: 'msg-1',
          rootId: 'om_root_id',
          // threadId intentionally omitted
        }),
      ).rejects.toThrow('threadId missing');
    });
  });

  describe('routing state machine', () => {
    it('should return resolved context for subsequent messages (routing completed)', async () => {
      mockGetThreadSession.mockReturnValue({
        threadId: 'omt_thread_1', workingDir: '/projects/repo-a',
        routingCompleted: true,
      });

      const result = await resolveThreadContext({
        prompt: 'fix the bug',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg-2',
        rootId: 'om_root',
        threadId: 'omt_thread_1',
      });

      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.ctx.workingDir).toBe('/projects/repo-a');
        expect(result.ctx.prompt).toBe('fix the bug');
        expect(result.ctx.threadId).toBe('omt_thread_1');
      }
      // Should NOT call routeWorkspace for subsequent messages
      expect(mockRouteWorkspace).not.toHaveBeenCalled();
    });

    it('should run routing for first message in thread', async () => {
      // Thread session with no routingCompleted and no conversationId
      mockGetThreadSession
        .mockReturnValueOnce(undefined) // first call (before upsert)
        .mockReturnValueOnce({          // after upsert
          threadId: 'omt_thread_1', workingDir: '/tmp/work',
        })
        .mockReturnValueOnce({          // after routing completed
          threadId: 'omt_thread_1', workingDir: '/projects/repo-a',
          routingCompleted: true,
        });

      mockRouteWorkspace.mockResolvedValue({
        decision: 'use_existing',
        workdir: '/projects/repo-a',
        mode: 'writable',
      });
      mockEnsureIsolatedWorkspace.mockReturnValue('/workspaces/repo-a-isolated');

      const result = await resolveThreadContext({
        prompt: 'work on repo-a',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg-1',
      });

      expect(result.status).toBe('resolved');
      expect(mockRouteWorkspace).toHaveBeenCalled();
      expect(mockEnsureIsolatedWorkspace).toHaveBeenCalledWith('/projects/repo-a', 'writable');
      expect(mockMarkThreadRoutingCompleted).toHaveBeenCalledWith('omt_thread_1');
    });

    it('should return pending when routing needs clarification', async () => {
      mockGetThreadSession
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          threadId: 'omt_thread_1', workingDir: '/tmp/work',
        });

      mockRouteWorkspace.mockResolvedValue({
        decision: 'need_clarification',
        question: '你想操作哪个仓库？',
      });

      const result = await resolveThreadContext({
        prompt: 'fix something',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg-1',
      });

      expect(result.status).toBe('pending');
      expect(mockSetThreadRoutingState).toHaveBeenCalledWith('omt_thread_1', {
        status: 'pending_clarification',
        originalPrompt: 'fix something',
        question: '你想操作哪个仓库？',
        retryCount: 0,
      });
      expect(mockReplyTextInThread).toHaveBeenCalledWith('root-msg-1', '你想操作哪个仓库？');
    });

    it('should handle routing clarification retry and restore original prompt', async () => {
      mockGetThreadSession
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          threadId: 'omt_thread_1', workingDir: '/tmp/work',
          routingState: {
            status: 'pending_clarification',
            originalPrompt: 'fix bug in repo-a',
            question: '哪个仓库？',
            retryCount: 0,
          },
        });

      mockRouteWorkspace.mockResolvedValue({
        decision: 'use_existing',
        workdir: '/projects/repo-a',
        mode: 'writable',
      });
      mockEnsureIsolatedWorkspace.mockReturnValue('/workspaces/repo-a-isolated');
      mockGetThreadSession.mockReturnValue({
        threadId: 'omt_thread_1', workingDir: '/workspaces/repo-a-isolated',
        routingCompleted: true,
      });

      const result = await resolveThreadContext({
        prompt: 'repo-a',  // user's clarification reply
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg-2',
        rootId: 'om_root',
        threadId: 'omt_thread_1',
      });

      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        // prompt should be restored to original, not the clarification reply
        expect(result.ctx.prompt).toBe('fix bug in repo-a');
      }
      expect(mockClearThreadRoutingState).toHaveBeenCalledWith('omt_thread_1');
    });
  });

  describe('workspace isolation error', () => {
    it('should return error when workspace isolation fails', async () => {
      mockGetThreadSession
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          threadId: 'omt_thread_1', workingDir: '/tmp/work',
        });

      mockRouteWorkspace.mockResolvedValue({
        decision: 'use_existing',
        workdir: '/projects/repo-a',
        mode: 'writable',
      });
      mockEnsureIsolatedWorkspace.mockImplementation(() => {
        throw new Error('disk full');
      });

      const result = await resolveThreadContext({
        prompt: 'work on repo-a',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg-1',
      });

      expect(result.status).toBe('error');
      expect(mockReplyTextInThread).toHaveBeenCalledWith(
        'root-msg-1',
        expect.stringContaining('无法创建隔离工作区'),
      );
    });
  });

  describe('greeting card update', () => {
    it('should update greeting card with threadId and workingDir', async () => {
      mockGetThreadSession.mockReturnValue({
        threadId: 'omt_thread_1', workingDir: '/projects/repo-a',
        routingCompleted: true,
      });

      const result = await resolveThreadContext({
        prompt: 'hello',
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg-1',
      });

      expect(result.status).toBe('resolved');
      expect(mockUpdateCard).toHaveBeenCalledWith(
        'greeting-1',
        { type: 'greeting_ready' },
      );
    });
  });
});
