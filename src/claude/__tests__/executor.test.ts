// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: {
    claude: { defaultWorkDir: '/tmp/work', timeoutSeconds: 300, model: 'claude-opus-4-6', thinking: 'adaptive', effort: 'max', maxTurns: 500, maxBudgetUsd: 50 },
    repoCache: { dir: '/repos/cache' },
    workspace: { baseDir: '/tmp/workspaces' },
    feishu: { tools: { enabled: false, doc: true, wiki: true, drive: true, bitable: true } },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the workspace tool module
const mockCreateWorkspaceMcpServer = vi.fn(() => ({ type: 'mock-mcp-server' }));
vi.mock('../../workspace/tool.js', () => ({
  createWorkspaceMcpServer: (...args: unknown[]) => mockCreateWorkspaceMcpServer(...args),
}));

// Mock the feishu tools module
const mockCreateFeishuToolsMcpServer = vi.fn(() => undefined);
vi.mock('../../feishu/tools/index.js', () => ({
  createFeishuToolsMcpServer: (...args: unknown[]) => mockCreateFeishuToolsMcpServer(...args),
}));

// Mock workspace isolation utility
const mockIsAutoWorkspacePath = vi.fn(() => false);
vi.mock('../../workspace/isolation.js', () => ({
  isAutoWorkspacePath: (...args: unknown[]) => mockIsAutoWorkspacePath(...args),
  isServiceOwnRepo: () => false,
}));

// Mock the SDK query function — returns an async iterable of messages
const mockQueryInstance = {
  close: vi.fn(),
  [Symbol.asyncIterator]: vi.fn(),
};
const mockQuery = vi.fn(() => mockQueryInstance);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { ClaudeExecutor } from '../executor.js';

// ============================================================
// Helpers
// ============================================================

/** Create a mock async iterator that yields given messages */
function setupMessages(messages: Array<Record<string, unknown>>) {
  const iter = messages[Symbol.iterator]();
  mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
    next: () => {
      const { value, done } = iter.next();
      return Promise.resolve({ value, done: done ?? false });
    },
  });
}

/** Shorthand for building an ExecuteInput with defaults */
function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: 'chat1:user1',
    prompt: 'test prompt',
    workingDir: '/tmp/work',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: yield a simple success result
  setupMessages([
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude', tools: [] },
    { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'hello', duration_ms: 100 },
  ]);
});

// ============================================================
// Tests
// ============================================================

describe('ClaudeExecutor', () => {
  let executor: ClaudeExecutor;

  beforeEach(() => {
    executor = new ClaudeExecutor();
  });

  describe('restart signal', () => {
    it('should set needsRestart when onWorkspaceChanged is called', async () => {
      // 模拟 workspace tool 在 query 执行中触发 onWorkspaceChanged
      let capturedOnWorkspaceChanged: ((dir: string) => void) | undefined;
      mockCreateWorkspaceMcpServer.mockImplementation((cb: (dir: string) => void) => {
        capturedOnWorkspaceChanged = cb;
        return { type: 'mock-mcp-server' };
      });

      setupMessages([
        { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude', tools: [] },
        { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'workspace ready', duration_ms: 50 },
      ]);

      const externalCallback = vi.fn();
      const resultPromise = executor.execute(makeInput({
        onWorkspaceChanged: externalCallback,
      }));

      // 手动触发 workspace 变更
      if (capturedOnWorkspaceChanged) {
        capturedOnWorkspaceChanged('/new/workspace');
      }

      const result = await resultPromise;

      expect(result.needsRestart).toBe(true);
      expect(result.newWorkingDir).toBe('/new/workspace');
      // 外部回调也应被调用
      expect(externalCallback).toHaveBeenCalledWith('/new/workspace');
    });

    it('should not set needsRestart when workspace does not change', async () => {
      const result = await executor.execute(makeInput({
        onWorkspaceChanged: vi.fn(),
      }));

      expect(result.needsRestart).toBeFalsy();
      expect(result.newWorkingDir).toBeUndefined();
    });

    it('should include needsRestart in error results', async () => {
      let capturedCb: ((dir: string) => void) | undefined;
      mockCreateWorkspaceMcpServer.mockImplementation((cb: (dir: string) => void) => {
        capturedCb = cb;
        return { type: 'mock-mcp-server' };
      });

      setupMessages([
        { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude', tools: [] },
        { type: 'result', subtype: 'error', session_id: 'sess-1', errors: ['something failed'], duration_ms: 50 },
      ]);

      const promise = executor.execute(makeInput({
        onWorkspaceChanged: vi.fn(),
      }));
      capturedCb?.('/new/dir');
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.needsRestart).toBe(true);
      expect(result.newWorkingDir).toBe('/new/dir');
    });
  });

  describe('disableWorkspaceTool', () => {
    it('should not create MCP server when disableWorkspaceTool is true', async () => {
      await executor.execute(makeInput({
        disableWorkspaceTool: true,
      }));

      // createWorkspaceMcpServer should NOT be called
      expect(mockCreateWorkspaceMcpServer).not.toHaveBeenCalled();

      // query should be called with mcpServers: undefined
      const queryCallOptions = mockQuery.mock.calls[0][0].options;
      expect(queryCallOptions.mcpServers).toBeUndefined();
    });

    it('should create MCP server when disableWorkspaceTool is not set', async () => {
      await executor.execute(makeInput({
        onWorkspaceChanged: vi.fn(),
      }));

      expect(mockCreateWorkspaceMcpServer).toHaveBeenCalledTimes(1);
      const queryCallOptions = mockQuery.mock.calls[0][0].options;
      expect(queryCallOptions.mcpServers).toHaveProperty('workspace-manager');
    });
  });

  describe('options overrides', () => {
    it('should use default maxTurns and maxBudgetUsd', async () => {
      await executor.execute(makeInput());

      const opts = mockQuery.mock.calls[0][0].options;
      expect(opts.maxTurns).toBe(500);
      expect(opts.maxBudgetUsd).toBe(50);
    });

    it('should override maxTurns and maxBudgetUsd from options', async () => {
      await executor.execute(makeInput({
        maxTurns: 5,
        maxBudgetUsd: 0.5,
      }));

      const opts = mockQuery.mock.calls[0][0].options;
      expect(opts.maxTurns).toBe(5);
      expect(opts.maxBudgetUsd).toBe(0.5);
    });
  });

  describe('killSessionsForChat', () => {
    it('should kill all session key patterns for a chat', async () => {
      // 直接往 runningQueries 注入 mock entries 来测试 killSessionsForChat
      const mockClose = vi.fn();
      const mockQuery1 = { close: vi.fn() };
      const mockQuery2 = { close: vi.fn() };
      const mockQuery3 = { close: vi.fn() };
      const mockQuery4 = { close: vi.fn() };
      const mockQueryOther = { close: vi.fn() };

      // 使用 (executor as any) 访问 private runningQueries
      const rq = (executor as any).runningQueries as Map<string, { close: () => void }>;
      rq.set('chat1:user1', mockQuery1);                    // 主聊天框 query
      rq.set('chat1:user1:rootA', mockQuery2);              // thread A query
      rq.set('routing:chat1:user1', mockQuery3);            // 主聊天框 routing
      rq.set('routing:chat1:user1:rootB', mockQuery4);      // thread B routing
      rq.set('chat2:user2', mockQueryOther);                 // 其他 chat

      executor.killSessionsForChat('chat1', 'user1');

      // 应该 kill 所有 chat1:user1 的 query
      expect(mockQuery1.close).toHaveBeenCalled();
      expect(mockQuery2.close).toHaveBeenCalled();
      expect(mockQuery3.close).toHaveBeenCalled();
      expect(mockQuery4.close).toHaveBeenCalled();

      // 不应该 kill 其他 chat
      expect(mockQueryOther.close).not.toHaveBeenCalled();

      // runningQueries 中只剩 chat2
      expect(rq.size).toBe(1);
      expect(rq.has('chat2:user2')).toBe(true);
    });

    it('should not kill queries from other users in the same chat', async () => {
      const rq = (executor as any).runningQueries as Map<string, { close: () => void }>;
      const q1 = { close: vi.fn() };
      const q2 = { close: vi.fn() };

      rq.set('chat1:userA:root1', q1);
      rq.set('chat1:userB:root1', q2);

      executor.killSessionsForChat('chat1', 'userA');

      expect(q1.close).toHaveBeenCalled();
      expect(q2.close).not.toHaveBeenCalled();
    });
  });

  describe('workspace dir auto-create guard', () => {
    it('should throw when isAutoWorkspacePath returns true and dir does not exist', async () => {
      const { existsSync } = await import('node:fs');
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      mockIsAutoWorkspacePath.mockReturnValue(true);

      await expect(
        executor.execute(makeInput({ workingDir: '/tmp/workspaces/repo-abc123' })),
      ).rejects.toThrow('工作区目录不存在');

      mockIsAutoWorkspacePath.mockReturnValue(false);
    });

    it('should auto-create when isAutoWorkspacePath returns false', async () => {
      const { existsSync, mkdirSync } = await import('node:fs');
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      mockIsAutoWorkspacePath.mockReturnValue(false);

      await executor.execute(makeInput({ workingDir: '/tmp/other-dir' }));

      expect(mkdirSync).toHaveBeenCalledWith('/tmp/other-dir', { recursive: true });
    });

    it('should not auto-create when workingDir already exists', async () => {
      const { existsSync, mkdirSync } = await import('node:fs');
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await executor.execute(makeInput({ workingDir: '/tmp/workspaces/repo-abc123' }));

      expect(mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('workspace changed callback wrapping', () => {
    it('should not wrap when onWorkspaceChanged is undefined', async () => {
      await executor.execute(makeInput());

      // createWorkspaceMcpServer should be called with undefined (no wrapping)
      expect(mockCreateWorkspaceMcpServer).toHaveBeenCalledWith(undefined);
    });

    it('should wrap when onWorkspaceChanged is provided', async () => {
      const cb = vi.fn();
      await executor.execute(makeInput({
        onWorkspaceChanged: cb,
      }));

      // createWorkspaceMcpServer should be called with a wrapper function (not the original cb)
      const passedCb = mockCreateWorkspaceMcpServer.mock.calls[0][0];
      expect(passedCb).toBeDefined();
      expect(passedCb).not.toBe(cb); // It's a wrapper
    });
  });

  describe('canUseTool — read-only MCP feishu-tools allow-list', () => {
    /** Extract the canUseTool callback from the last mockQuery call */
    function getCanUseTool() {
      const opts = mockQuery.mock.calls[0][0].options;
      return opts.canUseTool as (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; updatedInput?: unknown; message?: string }>;
    }

    it('should allow read-only feishu action in read-only mode', async () => {
      await executor.execute(makeInput({ readOnly: true }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('mcp__feishu-tools__feishu_doc', { action: 'read', doc_token: 'ABC' });
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual({ action: 'read', doc_token: 'ABC' });
    });

    it('should allow list_blocks feishu action in read-only mode', async () => {
      await executor.execute(makeInput({ readOnly: true }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('mcp__feishu-tools__feishu_doc', { action: 'list_blocks', doc_token: 'ABC' });
      expect(result.behavior).toBe('allow');
    });

    it('should allow bitable list_records in read-only mode', async () => {
      await executor.execute(makeInput({ readOnly: true }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('mcp__feishu-tools__feishu_bitable', { action: 'list_records', app_token: 'APP1' });
      expect(result.behavior).toBe('allow');
    });

    it('should allow write feishu action in read-only mode (feishu data, not repo)', async () => {
      await executor.execute(makeInput({ readOnly: true }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('mcp__feishu-tools__feishu_doc', { action: 'write', doc_token: 'ABC' });
      expect(result.behavior).toBe('allow');
    });

    it('should allow create feishu action in read-only mode (feishu data, not repo)', async () => {
      await executor.execute(makeInput({ readOnly: true }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('mcp__feishu-tools__feishu_bitable', { action: 'create_record', app_token: 'APP1' });
      expect(result.behavior).toBe('allow');
    });

    it('should allow delete feishu action in read-only mode (feishu data, not repo)', async () => {
      await executor.execute(makeInput({ readOnly: true }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('mcp__feishu-tools__feishu_bitable', { action: 'delete_record', app_token: 'APP1' });
      expect(result.behavior).toBe('allow');
    });

    it('should deny non-feishu MCP tools in read-only mode', async () => {
      await executor.execute(makeInput({ readOnly: true }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('mcp__workspace-manager__setup_workspace', { mode: 'writable' });
      expect(result.behavior).toBe('deny');
    });

    it('should allow all feishu actions when not in read-only mode', async () => {
      await executor.execute(makeInput({ readOnly: false }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('mcp__feishu-tools__feishu_doc', { action: 'write', doc_token: 'ABC' });
      expect(result.behavior).toBe('allow');
    });
  });
});
