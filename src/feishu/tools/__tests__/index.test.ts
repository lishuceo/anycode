// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock factories — safe to reference in factory
const { mockConfig, mockDocTool, mockWikiTool, mockDriveTool, mockBitableTool, mockChatTool, mockTaskTool, mockCreateSdkMcpServer } = vi.hoisted(() => {
  const mockConfig = {
    feishu: {
      tools: {
        enabled: true,
        doc: true,
        wiki: true,
        drive: true,
        bitable: true,
        chat: true,
        task: true,
      },
    },
  };
  return {
    mockConfig,
    mockDocTool: vi.fn(() => ({ name: 'feishu_doc' })),
    mockWikiTool: vi.fn(() => ({ name: 'feishu_wiki' })),
    mockDriveTool: vi.fn(() => ({ name: 'feishu_drive' })),
    mockBitableTool: vi.fn(() => ({ name: 'feishu_bitable' })),
    mockChatTool: vi.fn(() => ({ name: 'feishu_chat_members' })),
    mockTaskTool: vi.fn(() => ({ name: 'feishu_task' })),
    mockCreateSdkMcpServer: vi.fn((opts: unknown) => ({ ...(opts as object), type: 'mcp-server' })),
  };
});

vi.mock('../../../config.js', () => ({ config: mockConfig }));
vi.mock('../../oauth.js', () => ({ getValidUserToken: vi.fn() }));
vi.mock('../doc.js', () => ({ feishuDocTool: () => mockDocTool() }));
vi.mock('../wiki.js', () => ({ feishuWikiTool: () => mockWikiTool() }));
vi.mock('../drive.js', () => ({ feishuDriveTool: () => mockDriveTool() }));
vi.mock('../bitable.js', () => ({ feishuBitableTool: () => mockBitableTool() }));
vi.mock('../chat.js', () => ({ feishuChatTool: () => mockChatTool() }));
vi.mock('../task.js', () => ({ feishuTaskTool: () => mockTaskTool() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: unknown) => mockCreateSdkMcpServer(opts),
}));

import { createFeishuToolsMcpServer } from '../index.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to all enabled
  mockConfig.feishu.tools.doc = true;
  mockConfig.feishu.tools.wiki = true;
  mockConfig.feishu.tools.drive = true;
  mockConfig.feishu.tools.bitable = true;
  mockConfig.feishu.tools.chat = true;
  mockConfig.feishu.tools.task = true;
});

describe('createFeishuToolsMcpServer', () => {
  it('should return MCP server with all tools when all sub-switches enabled', () => {
    const result = createFeishuToolsMcpServer();
    expect(result).toBeDefined();
    expect(mockCreateSdkMcpServer).toHaveBeenCalledTimes(1);
    const call = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(call.name).toBe('feishu-tools');
    expect(call.tools).toHaveLength(6);
  });

  it('should include only enabled tools', () => {
    mockConfig.feishu.tools.wiki = false;
    mockConfig.feishu.tools.bitable = false;

    const result = createFeishuToolsMcpServer();
    expect(result).toBeDefined();
    const call = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(call.tools).toHaveLength(4);
    expect(mockDocTool).toHaveBeenCalledTimes(1);
    expect(mockDriveTool).toHaveBeenCalledTimes(1);
    expect(mockChatTool).toHaveBeenCalledTimes(1);
    expect(mockWikiTool).not.toHaveBeenCalled();
    expect(mockBitableTool).not.toHaveBeenCalled();
  });

  it('should not include chat tool when chat switch is false', () => {
    mockConfig.feishu.tools.chat = false;

    const result = createFeishuToolsMcpServer();
    expect(result).toBeDefined();
    const call = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(call.tools).toHaveLength(5);
    expect(mockDocTool).toHaveBeenCalledTimes(1);
    expect(mockWikiTool).toHaveBeenCalledTimes(1);
    expect(mockDriveTool).toHaveBeenCalledTimes(1);
    expect(mockBitableTool).toHaveBeenCalledTimes(1);
    expect(mockChatTool).not.toHaveBeenCalled();
  });

  it('should register chat tool even when chatId is undefined', () => {
    // chat tool has internal null-check and returns friendly error,
    // so it should still be registered to surface "not in group chat" message
    const result = createFeishuToolsMcpServer(undefined);
    expect(result).toBeDefined();
    const call = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(call.tools).toHaveLength(6);
    expect(mockChatTool).toHaveBeenCalledTimes(1);
  });

  it('should not include task tool when task switch is false', () => {
    mockConfig.feishu.tools.task = false;

    const result = createFeishuToolsMcpServer();
    expect(result).toBeDefined();
    const call = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(call.tools).toHaveLength(5);
    expect(mockTaskTool).not.toHaveBeenCalled();
  });

  it('should return undefined when all sub-switches are false', () => {
    mockConfig.feishu.tools.doc = false;
    mockConfig.feishu.tools.wiki = false;
    mockConfig.feishu.tools.drive = false;
    mockConfig.feishu.tools.bitable = false;
    mockConfig.feishu.tools.chat = false;
    mockConfig.feishu.tools.task = false;

    const result = createFeishuToolsMcpServer();
    expect(result).toBeUndefined();
    expect(mockCreateSdkMcpServer).not.toHaveBeenCalled();
  });

  it('should return server with single tool when only one sub-switch enabled', () => {
    mockConfig.feishu.tools.doc = false;
    mockConfig.feishu.tools.wiki = false;
    mockConfig.feishu.tools.drive = false;
    mockConfig.feishu.tools.bitable = true;
    mockConfig.feishu.tools.chat = false;
    mockConfig.feishu.tools.task = false;

    const result = createFeishuToolsMcpServer();
    expect(result).toBeDefined();
    const call = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(call.tools).toHaveLength(1);
    expect(mockBitableTool).toHaveBeenCalledTimes(1);
  });
});
