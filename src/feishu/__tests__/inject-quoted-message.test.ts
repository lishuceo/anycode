// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockGetMessageById = vi.fn();
const mockGetUserName = vi.fn();

vi.mock('../client.js', () => ({
  feishuClient: {
    getMessageById: (...args: unknown[]) => mockGetMessageById(...args),
    getUserName: (...args: unknown[]) => mockGetUserName(...args),
  },
}));

vi.mock('../message-parser.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ============================================================
// Tests
// ============================================================

describe('injectQuotedMessage', () => {
  let injectQuotedMessage: (
    effectivePrompt: string,
    rootId: string | undefined,
    messageId: string,
    chatId: string,
  ) => Promise<string>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../event-handler.js');
    injectQuotedMessage = mod._testing.injectQuotedMessage;
  });

  it('returns prompt unchanged when rootId is undefined', async () => {
    const result = await injectQuotedMessage('hello', undefined, 'msg1', 'chat1');
    expect(result).toBe('hello');
    expect(mockGetMessageById).not.toHaveBeenCalled();
  });

  it('returns prompt unchanged when rootId equals messageId', async () => {
    const result = await injectQuotedMessage('hello', 'msg1', 'msg1', 'chat1');
    expect(result).toBe('hello');
    expect(mockGetMessageById).not.toHaveBeenCalled();
  });

  it('injects text message content when rootId points to a text message', async () => {
    mockGetMessageById.mockResolvedValue([
      {
        message_id: 'root1',
        msg_type: 'text',
        body: { content: '{"text":"quoted text content"}' },
      },
    ]);

    const result = await injectQuotedMessage('user question', 'root1', 'msg1', 'chat1');
    expect(result).toContain('<quoted-message>');
    expect(result).toContain('quoted text content');
    expect(result).toContain('user question');
  });

  it('injects post message content', async () => {
    const postContent = JSON.stringify({
      title: 'Post Title',
      content: [[{ tag: 'text', text: 'post body text' }]],
    });
    mockGetMessageById.mockResolvedValue([
      {
        message_id: 'root2',
        msg_type: 'post',
        body: { content: postContent },
      },
    ]);

    const result = await injectQuotedMessage('my prompt', 'root2', 'msg1', 'chat1');
    expect(result).toContain('<quoted-message>');
    expect(result).toContain('my prompt');
  });

  it('expands merge_forward sub-messages', async () => {
    mockGetMessageById.mockResolvedValue([
      {
        message_id: 'mf1',
        msg_type: 'merge_forward',
        body: { content: '{}' },
      },
      {
        message_id: 'sub1',
        msg_type: 'text',
        upper_message_id: 'mf1',
        create_time: '1000',
        sender: { id: 'user_a' },
        body: { content: '{"text":"sub message 1"}' },
      },
      {
        message_id: 'sub2',
        msg_type: 'text',
        upper_message_id: 'mf1',
        create_time: '2000',
        sender: { id: 'user_b' },
        body: { content: '{"text":"sub message 2"}' },
      },
    ]);

    mockGetUserName.mockImplementation(async (id: string) => {
      if (id === 'user_a') return 'Alice';
      if (id === 'user_b') return 'Bob';
      return null;
    });

    const result = await injectQuotedMessage('prompt', 'mf1', 'msg1', 'chat1');
    expect(result).toContain('合并转发的聊天记录');
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
    expect(result).toContain('sub message 1');
    expect(result).toContain('sub message 2');
  });

  it('returns prompt unchanged when API returns empty', async () => {
    mockGetMessageById.mockResolvedValue([]);
    const result = await injectQuotedMessage('prompt', 'root1', 'msg1', 'chat1');
    expect(result).toBe('prompt');
  });

  it('returns prompt unchanged when API throws', async () => {
    mockGetMessageById.mockRejectedValue(new Error('API error'));
    const result = await injectQuotedMessage('prompt', 'root1', 'msg1', 'chat1');
    expect(result).toBe('prompt');
  });

  it('returns prompt unchanged for unsupported message types', async () => {
    mockGetMessageById.mockResolvedValue([
      {
        message_id: 'root1',
        msg_type: 'image',
        body: { content: '{}' },
      },
    ]);
    const result = await injectQuotedMessage('prompt', 'root1', 'msg1', 'chat1');
    expect(result).toBe('prompt');
  });
});
