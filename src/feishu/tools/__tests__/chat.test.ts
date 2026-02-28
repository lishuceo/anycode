// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetChatMembers = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    getChatMembers: (...args: unknown[]) => mockGetChatMembers(...args),
  },
}));

const mockGetBots = vi.fn();

vi.mock('../../bot-registry.js', () => ({
  chatBotRegistry: {
    getBots: (...args: unknown[]) => mockGetBots(...args),
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

import { feishuChatTool } from '../chat.js';

// ============================================================
// Tests
// ============================================================

describe('feishu_chat_members tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feishuChatTool('chat_123'); // triggers tool() which captures handler
  });

  it('should return error when no chatId available', async () => {
    feishuChatTool(); // no chatId
    const result = await capturedHandler({}) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('当前不在群聊中');
  });

  it('should return unified list of users and bots', async () => {
    mockGetChatMembers.mockResolvedValue([
      { memberId: 'ou_user1', name: '张三', memberIdType: 'open_id' },
      { memberId: 'ou_user2', name: '李四', memberIdType: 'open_id' },
    ]);
    mockGetBots.mockReturnValue([
      { openId: 'ou_bot1', name: 'GPT助手', source: 'event_added', discoveredAt: Date.now() },
      { openId: 'ou_bot2', name: undefined, source: 'message_sender', discoveredAt: Date.now() },
    ]);

    const result = await capturedHandler({}) as any;
    const text = result.content[0].text;

    // Summary line
    expect(text).toContain('2 人 + 2 bot');
    // User entries with [user] tag
    expect(text).toContain('1. [user] 张三 (ou_user1)');
    expect(text).toContain('2. [user] 李四 (ou_user2)');
    // Bot entries with [bot] tag, continuous numbering
    expect(text).toContain('3. [bot] GPT助手 (ou_bot1) — 来源: 入群事件');
    expect(text).toContain('4. [bot] [未知名称] (ou_bot2) — 来源: 消息检测');
  });

  it('should show "暂未发现 bot" when no bots known', async () => {
    mockGetChatMembers.mockResolvedValue([
      { memberId: 'ou_user1', name: '张三', memberIdType: 'open_id' },
    ]);
    mockGetBots.mockReturnValue([]);

    const result = await capturedHandler({}) as any;
    const text = result.content[0].text;

    expect(text).toContain('1 人, 暂未发现 bot');
    expect(text).toContain('1. [user] 张三 (ou_user1)');
    expect(text).not.toContain('[bot]');
  });

  it('should use args.chat_id override when provided', async () => {
    mockGetChatMembers.mockResolvedValue([]);
    mockGetBots.mockReturnValue([]);

    await capturedHandler({ chat_id: 'chat_override' });
    expect(mockGetChatMembers).toHaveBeenCalledWith('chat_override');
    expect(mockGetBots).toHaveBeenCalledWith('chat_override');
  });

  it('should return error on API failure', async () => {
    mockGetChatMembers.mockRejectedValue(new Error('API timeout'));

    const result = await capturedHandler({}) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('获取群成员失败');
    expect(result.content[0].text).toContain('API timeout');
  });
});
