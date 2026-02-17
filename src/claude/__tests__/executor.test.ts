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
    claude: { defaultWorkDir: '/tmp/work' },
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
      expect(opts.maxTurns).toBe(50);
      expect(opts.maxBudgetUsd).toBe(5);
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
});
