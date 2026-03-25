// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSendText = vi.fn();
const mockReplyText = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    sendText: (...args: unknown[]) => mockSendText(...args),
    replyText: (...args: unknown[]) => mockReplyText(...args),
  },
}));

// Mock the SDK tool() — capture the handler function for direct testing
let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => {
    capturedHandler = handler as typeof capturedHandler;
    return { name: _name, handler };
  },
}));

import { feishuMainChatTool } from '../main-chat.js';

// ============================================================
// Tests
// ============================================================

describe('feishu_send_to_chat tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error when chatId is undefined', async () => {
    feishuMainChatTool(); // no chatId
    const result = await capturedHandler({ text: 'hello' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('当前不在群聊中');
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockReplyText).not.toHaveBeenCalled();
  });

  it('should use sendText when no threadRootMessageId', async () => {
    feishuMainChatTool('chat_123'); // chatId only, no threadRootMessageId
    mockSendText.mockResolvedValue(undefined);

    const result = await capturedHandler({ text: '面试总结内容' }) as any;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('已发送到群主聊天');
    expect(mockSendText).toHaveBeenCalledWith('chat_123', '面试总结内容');
    expect(mockReplyText).not.toHaveBeenCalled();
  });

  it('should use replyText when threadRootMessageId is provided', async () => {
    feishuMainChatTool('chat_123', 'msg_root_456'); // with threadRootMessageId
    mockReplyText.mockResolvedValue(undefined);

    const result = await capturedHandler({ text: '总结发到群里' }) as any;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('已发送到群主聊天');
    expect(mockReplyText).toHaveBeenCalledWith('msg_root_456', '总结发到群里');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('should return error when send throws', async () => {
    feishuMainChatTool('chat_123');
    mockSendText.mockRejectedValue(new Error('API rate limit'));

    const result = await capturedHandler({ text: 'test' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('发送失败');
    expect(result.content[0].text).toContain('API rate limit');
  });
});
