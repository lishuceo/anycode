// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockGetMessageById = vi.fn();
const mockGetUserName = vi.fn();
const mockDownloadMessageImage = vi.fn();

vi.mock('../client.js', () => ({
  feishuClient: {
    getMessageById: (...args: unknown[]) => mockGetMessageById(...args),
    getUserName: (...args: unknown[]) => mockGetUserName(...args),
    downloadMessageImage: (...args: unknown[]) => mockDownloadMessageImage(...args),
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

vi.mock('../../utils/image-compress.js', () => ({
  compressImage: vi.fn(async (buf: Buffer, mediaType: string) => ({
    data: buf,
    mediaType,
  })),
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
    existingImages?: unknown[],
  ) => Promise<{ prompt: string; images?: unknown[] }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../event-handler.js');
    injectQuotedMessage = mod._testing.injectQuotedMessage;
  });

  it('returns prompt unchanged when rootId is undefined', async () => {
    const result = await injectQuotedMessage('hello', undefined, 'msg1', 'chat1');
    expect(result.prompt).toBe('hello');
    expect(mockGetMessageById).not.toHaveBeenCalled();
  });

  it('returns prompt unchanged when rootId equals messageId', async () => {
    const result = await injectQuotedMessage('hello', 'msg1', 'msg1', 'chat1');
    expect(result.prompt).toBe('hello');
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
    expect(result.prompt).toContain('<quoted-message>');
    expect(result.prompt).toContain('quoted text content');
    expect(result.prompt).toContain('user question');
    expect(result.images).toBeUndefined();
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
    expect(result.prompt).toContain('<quoted-message>');
    expect(result.prompt).toContain('my prompt');
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
    expect(result.prompt).toContain('合并转发的聊天记录');
    expect(result.prompt).toContain('Alice');
    expect(result.prompt).toContain('Bob');
    expect(result.prompt).toContain('sub message 1');
    expect(result.prompt).toContain('sub message 2');
  });

  it('returns prompt unchanged when API returns empty', async () => {
    mockGetMessageById.mockResolvedValue([]);
    const result = await injectQuotedMessage('prompt', 'root1', 'msg1', 'chat1');
    expect(result.prompt).toBe('prompt');
  });

  it('returns prompt unchanged when API throws', async () => {
    mockGetMessageById.mockRejectedValue(new Error('API error'));
    const result = await injectQuotedMessage('prompt', 'root1', 'msg1', 'chat1');
    expect(result.prompt).toBe('prompt');
  });

  it('downloads and injects quoted image', async () => {
    mockGetMessageById.mockResolvedValue([
      {
        message_id: 'img1',
        msg_type: 'image',
        body: { content: '{"image_key":"img_key_123"}' },
      },
    ]);
    // Return a small PNG-like buffer
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    mockDownloadMessageImage.mockResolvedValue(fakePng);

    const result = await injectQuotedMessage('prompt', 'img1', 'msg1', 'chat1');
    expect(result.prompt).toContain('<quoted-message>');
    expect(result.prompt).toContain('引用了一张图片');
    expect(result.images).toHaveLength(1);
    expect(result.images![0].mediaType).toBe('image/png');
    expect(mockDownloadMessageImage).toHaveBeenCalledWith('img1', 'img_key_123');
  });

  it('handles image download failure gracefully', async () => {
    mockGetMessageById.mockResolvedValue([
      {
        message_id: 'img2',
        msg_type: 'image',
        body: { content: '{"image_key":"img_key_456"}' },
      },
    ]);
    mockDownloadMessageImage.mockRejectedValue(new Error('download failed'));

    const result = await injectQuotedMessage('prompt', 'img2', 'msg1', 'chat1');
    expect(result.prompt).toContain('下载失败');
    expect(result.images).toBeUndefined();
  });

  it('merges quoted image with existing images', async () => {
    mockGetMessageById.mockResolvedValue([
      {
        message_id: 'img3',
        msg_type: 'image',
        body: { content: '{"image_key":"img_key_789"}' },
      },
    ]);
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    mockDownloadMessageImage.mockResolvedValue(fakePng);

    const existing = [{ data: 'existing_base64', mediaType: 'image/jpeg' as const }];
    const result = await injectQuotedMessage('prompt', 'img3', 'msg1', 'chat1', existing);
    expect(result.images).toHaveLength(2);
    expect(result.images![0].data).toBe('existing_base64');
    expect(result.images![1].mediaType).toBe('image/png');
  });
});
