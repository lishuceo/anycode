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
    claude: { defaultWorkDir: '/tmp/work', timeoutSeconds: 300, toolTimeoutSeconds: 900, model: 'claude-opus-4-6', thinking: 'adaptive', effort: 'max', maxTurns: 500, maxBudgetUsd: 50, apiBaseUrl: '' },
    repoCache: { dir: '/repos/cache' },
    workspace: { baseDir: '/tmp/workspaces' },
    feishu: { tools: { enabled: false, doc: true, wiki: true, drive: true, bitable: true } },
    cron: { enabled: false },
    websearch: { enabled: false, apiKey: '', baseUrl: 'https://api.tavily.com', maxResults: 5, searchDepth: 'basic', timeoutMs: 15000 },
    // self-config 工具仅 owner 可用；默认 sessionKey(user1) 非 owner，故默认不创建，
    // 现有断言(mcpServers 仅 workspace-manager / undefined)不受影响。
    security: { ownerUserId: 'owner-xyz' },
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
const mockIsInsideSourceRepo = vi.fn(() => false);
vi.mock('../../workspace/isolation.js', () => ({
  isAutoWorkspacePath: (...args: unknown[]) => mockIsAutoWorkspacePath(...args),
  isServiceOwnRepo: () => false,
  isInsideSourceRepo: (...args: unknown[]) => mockIsInsideSourceRepo(...args),
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

// Mock cron modules (imported by executor.ts)
vi.mock('../../cron/tool.js', () => ({
  createCronMcpServer: vi.fn(() => ({ type: 'mock-cron-mcp' })),
}));
vi.mock('../../cron/init.js', () => ({
  getCronScheduler: vi.fn(() => null),
}));

// Mock self-config tool module（自改自配置，owner-gated）
const mockCreateConfigAdminMcpServer = vi.fn(() => ({ type: 'mock-self-config-mcp' }));
vi.mock('../../config-admin/tool.js', () => ({
  createConfigAdminMcpServer: (...args: unknown[]) => mockCreateConfigAdminMcpServer(...args),
}));

import { ClaudeExecutor, buildWorkspaceSystemPrompt, classifyCompactOutcome, shouldExtendIdleTimer } from '../executor.js';

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

  describe('self-config MCP tool — owner gating', () => {
    it('creates self-config server when session user is owner', async () => {
      await executor.execute(makeInput({ sessionKey: 'agent:pm:chat1:owner-xyz' }));
      expect(mockCreateConfigAdminMcpServer).toHaveBeenCalledWith({ userId: 'owner-xyz' });
      const opts = mockQuery.mock.calls[0][0].options;
      expect(opts.mcpServers).toHaveProperty('self-config');
    });

    it('does NOT create self-config server for non-owner users', async () => {
      await executor.execute(makeInput({ sessionKey: 'agent:pm:chat1:user1' }));
      expect(mockCreateConfigAdminMcpServer).not.toHaveBeenCalled();
      const opts = mockQuery.mock.calls[0][0].options;
      if (opts.mcpServers) expect(opts.mcpServers).not.toHaveProperty('self-config');
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
      const _mockClose = vi.fn();
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

  describe('canUseTool — toolAllow overrides readOnly', () => {
    function getCanUseTool() {
      const opts = mockQuery.mock.calls[0][0].options;
      return opts.canUseTool as (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; updatedInput?: unknown; message?: string }>;
    }

    it('should allow Skill in readOnly mode when toolAllow includes Skill', async () => {
      await executor.execute(makeInput({ readOnly: true, toolAllow: ['Skill'] }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('Skill', { skill: 'restore-project' });
      expect(result.behavior).toBe('allow');
    });

    it('should deny Bash in readOnly mode when toolAllow does not include Bash', async () => {
      await executor.execute(makeInput({ readOnly: true, toolAllow: ['Skill'] }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('Bash', { command: 'ls' });
      expect(result.behavior).toBe('deny');
    });

    it('should deny Edit in readOnly mode even without toolAllow', async () => {
      await executor.execute(makeInput({ readOnly: true }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('Edit', { file: 'test.ts' });
      expect(result.behavior).toBe('deny');
    });

    it('should respect toolDeny over toolAllow', async () => {
      await executor.execute(makeInput({ readOnly: true, toolAllow: ['Bash'], toolDeny: ['Bash'] }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('Bash', { command: 'ls' });
      expect(result.behavior).toBe('deny');
    });
  });

  describe('canUseTool — bashAllowPatterns', () => {
    function getCanUseTool() {
      const opts = mockQuery.mock.calls[0][0].options;
      return opts.canUseTool as (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; updatedInput?: unknown; message?: string }>;
    }

    it('should allow Bash command matching bashAllowPatterns', async () => {
      await executor.execute(makeInput({
        readOnly: true,
        toolAllow: ['Bash'],
        bashAllowPatterns: ['^python .*/skills/', '^ls'],
      }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('Bash', { command: 'python /root/.claude/skills/restore-project/scripts/run.py' });
      expect(result.behavior).toBe('allow');
    });

    it('should allow Bash command matching second pattern', async () => {
      await executor.execute(makeInput({
        readOnly: true,
        toolAllow: ['Bash'],
        bashAllowPatterns: ['^python .*/skills/', '^ls'],
      }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('Bash', { command: 'ls -la /tmp' });
      expect(result.behavior).toBe('allow');
    });

    it('should deny Bash command not matching any bashAllowPatterns', async () => {
      await executor.execute(makeInput({
        readOnly: true,
        toolAllow: ['Bash'],
        bashAllowPatterns: ['^python .*/skills/', '^ls'],
      }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('Bash', { command: 'rm -rf /tmp/repo' });
      expect(result.behavior).toBe('deny');
    });

    it('should deny sed/echo/write commands not in patterns', async () => {
      await executor.execute(makeInput({
        readOnly: true,
        toolAllow: ['Bash'],
        bashAllowPatterns: ['^(ls|cat|git log)'],
      }));
      const canUseTool = getCanUseTool();

      const r1 = await canUseTool('Bash', { command: 'sed -i "s/a/b/" file.ts' });
      expect(r1.behavior).toBe('deny');
      const r2 = await canUseTool('Bash', { command: 'echo "hack" > file.ts' });
      expect(r2.behavior).toBe('deny');
    });

    it('should deny commands with shell meta-characters even if pattern matches', async () => {
      await executor.execute(makeInput({
        readOnly: true,
        toolAllow: ['Bash'],
        bashAllowPatterns: ['^ls', '^python .*/skills/', '^git log'],
      }));
      const canUseTool = getCanUseTool();

      // Command chaining via &&
      const r1 = await canUseTool('Bash', { command: 'ls && rm -rf /' });
      expect(r1.behavior).toBe('deny');
      // Pipe
      const r2 = await canUseTool('Bash', { command: 'git log | tee /etc/passwd' });
      expect(r2.behavior).toBe('deny');
      // Semicolon
      const r3 = await canUseTool('Bash', { command: 'ls; curl evil.com' });
      expect(r3.behavior).toBe('deny');
      // Backtick
      const r4 = await canUseTool('Bash', { command: 'python `malicious`' });
      expect(r4.behavior).toBe('deny');
      // $() subshell
      const r5 = await canUseTool('Bash', { command: 'python $(whoami)/skills/x.py' });
      expect(r5.behavior).toBe('deny');
    });

    it('should allow all Bash when toolAllow has Bash but no bashAllowPatterns', async () => {
      await executor.execute(makeInput({
        readOnly: true,
        toolAllow: ['Bash'],
        // no bashAllowPatterns — no command-level restriction
      }));
      const canUseTool = getCanUseTool();

      const result = await canUseTool('Bash', { command: 'rm -rf /' });
      expect(result.behavior).toBe('allow');
    });

    it('should not apply bashAllowPatterns when not in readOnly mode', async () => {
      await executor.execute(makeInput({
        readOnly: false,
        toolAllow: ['Bash'],
        bashAllowPatterns: ['^ls'],
      }));
      const canUseTool = getCanUseTool();

      // Non-readOnly mode: Bash is allowed without pattern check
      const result = await canUseTool('Bash', { command: 'rm -rf /tmp' });
      expect(result.behavior).toBe('allow');
    });
  });

  describe('environment forwarding (proxy BaseUrl)', () => {
    // 回归 (bug)：SDK 0.3.x 的 `env` 选项会**完全替换**子进程环境（不与 process.env 合并）。
    // 若只传 { ANTHROPIC_BASE_URL }，子进程会丢失 ANTHROPIC_API_KEY，
    // 导致 Claude Code 返回 "Not logged in · Please run /login"。必须展开 process.env。
    it('spreads process.env so the subprocess keeps ANTHROPIC_API_KEY when apiBaseUrl is set', async () => {
      const { config } = await import('../../config.js');
      const prevBase = config.claude.apiBaseUrl;
      const prevKey = process.env.ANTHROPIC_API_KEY;
      config.claude.apiBaseUrl = 'https://proxy.example.com';
      process.env.ANTHROPIC_API_KEY = 'sk-regression-test';
      try {
        await executor.execute(makeInput());
        const opts = mockQuery.mock.calls[0][0].options;
        expect(opts.env).toBeDefined();
        // 关键回归点：API key 必须随 process.env 一起带给子进程
        expect(opts.env.ANTHROPIC_API_KEY).toBe('sk-regression-test');
        // 代理 BaseUrl 仍被正确覆盖
        expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');
      } finally {
        config.claude.apiBaseUrl = prevBase;
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
      }
    });

    it('omits env entirely when no apiBaseUrl (subprocess inherits process.env)', async () => {
      // 默认 mock 的 apiBaseUrl === ''：不传 env，让子进程自然继承父进程环境
      await executor.execute(makeInput());
      const opts = mockQuery.mock.calls[0][0].options;
      expect(opts.env).toBeUndefined();
    });
  });

  describe('buildWorkspaceSystemPrompt — platform constraints', () => {
    it('includes platform execution constraints section', () => {
      const prompt = buildWorkspaceSystemPrompt('/tmp/work');
      expect(prompt).toContain('平台执行约束');
      expect(prompt).toContain('子进程生命周期');
      expect(prompt).toContain('不要用 Monitor 等待超过 5 分钟的后台任务结果');
      expect(prompt).toContain('权限交互');
    });

    it('omits cron guidance when cron is disabled', () => {
      // config mock has cron.enabled = false
      const prompt = buildWorkspaceSystemPrompt('/tmp/work');
      expect(prompt).not.toContain('manage_cron');
      expect(prompt).toContain('建议用户稍后手动追问检查结果');
    });
  });

  describe('compact()', () => {
    it('sends a BARE "/compact" prompt with resume (no prefixes)', async () => {
      setupMessages([
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 40445, post_tokens: 1351 } },
        { type: 'system', subtype: 'status', status: null, compact_result: 'success' },
        { type: 'system', subtype: 'init', session_id: 'sess-c' },
        { type: 'result', subtype: 'success', session_id: 'sess-c' },
      ]);

      await executor.compact({ sessionKey: 'k', workingDir: '/tmp/w', resumeSessionId: 'sess-c' });

      const arg = mockQuery.mock.calls[0]![0] as { prompt: string; options: Record<string, unknown> };
      // 关键：prompt 必须是裸 /compact，否则 CLI 不识别为 local slash command
      expect(arg.prompt).toBe('/compact');
      expect(arg.options.resume).toBe('sess-c');
    });

    it('returns success with pre/post tokens on a real compaction', async () => {
      setupMessages([
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 40445, post_tokens: 1351 } },
        { type: 'system', subtype: 'status', status: null, compact_result: 'success' },
        { type: 'system', subtype: 'init', session_id: 'sess-c' },
        { type: 'result', subtype: 'success', session_id: 'sess-c' },
      ]);

      const r = await executor.compact({ sessionKey: 'k', workingDir: '/tmp/w', resumeSessionId: 'sess-c' });

      expect(r.success).toBe(true);
      expect(r.noop).toBe(false);
      expect(r.preTokens).toBe(40445);
      expect(r.postTokens).toBe(1351);
      expect(r.sessionId).toBe('sess-c');
      expect(r.error).toBeUndefined();
    });

    it('flags noop when context is too short to compact', async () => {
      setupMessages([
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' },
        { type: 'system', subtype: 'init', session_id: 'sess-c' },
        { type: 'result', subtype: 'success', session_id: 'sess-c' },
      ]);

      const r = await executor.compact({ sessionKey: 'k', workingDir: '/tmp/w', resumeSessionId: 'sess-c' });

      expect(r.success).toBe(false);
      expect(r.noop).toBe(true);
      expect(r.error).toBeUndefined();
    });

    it('returns failure with error on a real compaction error', async () => {
      setupMessages([
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'API overloaded' },
        { type: 'result', subtype: 'success', session_id: 'sess-c' },
      ]);

      const r = await executor.compact({ sessionKey: 'k', workingDir: '/tmp/w', resumeSessionId: 'sess-c' });

      expect(r.success).toBe(false);
      expect(r.noop).toBe(false);
      expect(r.error).toBe('API overloaded');
    });

    it('treats a missing compact signal as failure (not silent success)', async () => {
      // 没有任何 compact_boundary / compact_result —— 说明 /compact 未被识别为命令
      setupMessages([
        { type: 'system', subtype: 'init', session_id: 'sess-c' },
        { type: 'result', subtype: 'success', session_id: 'sess-c', result: '/compact' },
      ]);

      const r = await executor.compact({ sessionKey: 'k', workingDir: '/tmp/w', resumeSessionId: 'sess-c' });

      expect(r.success).toBe(false);
      expect(r.noop).toBe(false);
      expect(r.error).toBeTruthy();
    });
  });

  describe('classifyCompactOutcome()', () => {
    it('success when compact_result is success', () => {
      expect(classifyCompactOutcome({ compactResult: 'success' })).toEqual({ success: true, noop: false });
    });

    it('noop when failed with "not enough messages"', () => {
      expect(classifyCompactOutcome({ compactResult: 'failed', compactError: 'Not enough messages to compact.' }))
        .toEqual({ success: false, noop: true });
    });

    it('failure with error for other failed reasons', () => {
      const r = classifyCompactOutcome({ compactResult: 'failed', compactError: 'boom' });
      expect(r.success).toBe(false);
      expect(r.noop).toBe(false);
      expect(r.error).toBe('boom');
    });

    it('failure when no signal at all', () => {
      const r = classifyCompactOutcome({});
      expect(r.success).toBe(false);
      expect(r.noop).toBe(false);
      expect(r.error).toBeTruthy();
    });
  });

  // ============================================================
  // idle 超时 + 工具执行中延展（回归：idle timeout 误杀长工具）
  // ============================================================
  describe('idle timeout & in-flight tool extension', () => {
    /**
     * Mock 一个迭代器：先吐 `pre` 里的消息，之后在下一次拉取时挂起，
     * 直到 query 的 abortController 触发才 reject（模拟「长工具执行期间无 SDK 消息，
     * 最终被 abort 终止」的真实 SDK 行为）。
     */
    function setupHangingAfter(pre: Array<Record<string, unknown>>) {
      let idx = 0;
      mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
        next: () => {
          if (idx < pre.length) {
            return Promise.resolve({ value: pre[idx++], done: false });
          }
          return new Promise((_resolve, reject) => {
            const ac = mockQuery.mock.calls[0]?.[0]?.options?.abortController as AbortController | undefined;
            if (ac?.signal?.aborted) { reject(new Error('Operation aborted')); return; }
            ac?.signal?.addEventListener('abort', () => reject(new Error('Operation aborted')));
          });
        },
      });
    }

    const INIT_MSG = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude', tools: [] };
    const ASSISTANT_TOOL_USE = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tool-1', input: { command: 'sleep 9999' } }] },
    };

    it('extends idle timer while a tool is in-flight, aborting only after the tool hard cap', async () => {
      vi.useFakeTimers();
      try {
        // idle 窗口 1s，工具硬顶 3s
        setupHangingAfter([INIT_MSG, ASSISTANT_TOOL_USE]);
        const p = executor.execute(makeInput({ timeoutSeconds: 1, toolTimeoutSeconds: 3 }));

        // 越过第一个 idle 窗口(1s)：工具仍在执行 → 应延展，不应 abort
        await vi.advanceTimersByTimeAsync(1500);
        const ac = mockQuery.mock.calls[0][0].options.abortController as AbortController;
        expect(ac.signal.aborted).toBe(false);

        // 越过工具硬顶(3s)：判定挂死并 abort
        await vi.advanceTimersByTimeAsync(2000);
        const result = await p;

        expect(result.success).toBe(false);
        expect(ac.signal.aborted).toBe(true);
        expect(result.error).toMatch(/tool execution timeout/i);
        expect(result.error).toMatch(/longer than 3s/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts at the idle window when no tool is in-flight (model idle)', async () => {
      vi.useFakeTimers();
      try {
        // 只有 init，之后挂起且没有任何工具在执行 → 纯模型空闲
        setupHangingAfter([INIT_MSG]);
        const p = executor.execute(makeInput({ timeoutSeconds: 1, toolTimeoutSeconds: 30 }));

        await vi.advanceTimersByTimeAsync(1200);
        const result = await p;

        const ac = mockQuery.mock.calls[0][0].options.abortController as AbortController;
        expect(ac.signal.aborted).toBe(true);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/idle timeout/i);
        expect(result.error).not.toMatch(/tool execution timeout/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ============================================================
// shouldExtendIdleTimer — 纯函数判定逻辑
// ============================================================
describe('shouldExtendIdleTimer', () => {
  it('extends when a tool is in-flight and under the hard cap', () => {
    expect(shouldExtendIdleTimer({ inFlightToolCount: 1, toolWaitElapsedMs: 1000, toolTimeoutMs: 900_000 })).toBe(true);
  });

  it('does not extend when no tool is in-flight (model idle)', () => {
    expect(shouldExtendIdleTimer({ inFlightToolCount: 0, toolWaitElapsedMs: 1000, toolTimeoutMs: 900_000 })).toBe(false);
  });

  it('does not extend once the tool exceeds the hard cap (stuck tool)', () => {
    expect(shouldExtendIdleTimer({ inFlightToolCount: 1, toolWaitElapsedMs: 900_000, toolTimeoutMs: 900_000 })).toBe(false);
    expect(shouldExtendIdleTimer({ inFlightToolCount: 2, toolWaitElapsedMs: 900_001, toolTimeoutMs: 900_000 })).toBe(false);
  });

  it('extends for multiple concurrent in-flight tools under the cap', () => {
    expect(shouldExtendIdleTimer({ inFlightToolCount: 3, toolWaitElapsedMs: 0, toolTimeoutMs: 1000 })).toBe(true);
  });
});
