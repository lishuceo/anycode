// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockUploadImage = vi.fn();
const mockSendImage = vi.fn();
const mockReplyImageInThread = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    uploadImage: (...args: unknown[]) => mockUploadImage(...args),
    sendImage: (...args: unknown[]) => mockSendImage(...args),
    replyImageInThread: (...args: unknown[]) => mockReplyImageInThread(...args),
  },
}));

const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();
const mockOpenSync = vi.fn(() => 3);
const mockReadSync = vi.fn();
const mockCloseSync = vi.fn();
const mockCreateReadStream = vi.fn(() => ({ __fakeStream: true }));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
  openSync: (...args: unknown[]) => mockOpenSync(...args),
  readSync: (...args: unknown[]) => mockReadSync(...args),
  closeSync: (...args: unknown[]) => mockCloseSync(...args),
  createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
}));

// Mock the SDK tool() — capture the handler function for direct testing
let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => {
    capturedHandler = handler as typeof capturedHandler;
    return { name: _name, handler };
  },
}));

import { feishuSendImageTool } from '../send-image.js';

// PNG magic bytes for the happy path
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function writeHeader(sig: Buffer) {
  mockReadSync.mockImplementation((_fd: number, buf: Buffer) => {
    sig.copy(buf);
    return sig.length;
  });
}

// ============================================================
// Tests
// ============================================================

describe('feishu_send_image tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default happy-path file system state: existing 2KB PNG
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isFile: () => true, size: 2048 });
    writeHeader(PNG_SIG);
    mockUploadImage.mockResolvedValue('img_key_1');
    mockSendImage.mockResolvedValue('msg_1');
    mockReplyImageInThread.mockResolvedValue('thread_msg_1');
  });

  it('should return error when chatId is undefined', async () => {
    feishuSendImageTool();
    const result = await capturedHandler({ file_path: '/abs/out.png' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('当前不在会话中');
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  it('should upload and send image to chat when no thread', async () => {
    feishuSendImageTool('chat_123');
    const result = await capturedHandler({ file_path: '/abs/out.png' }) as any;
    expect(result.isError).toBeUndefined();
    expect(mockUploadImage).toHaveBeenCalledWith({ __fakeStream: true });
    expect(mockSendImage).toHaveBeenCalledWith('chat_123', 'img_key_1');
    expect(mockReplyImageInThread).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('会话');
  });

  it('should reply image in thread when threadReplyMsgId provided', async () => {
    feishuSendImageTool('chat_123', 'thread_root_1');
    const result = await capturedHandler({ file_path: '/abs/out.png' }) as any;
    expect(result.isError).toBeUndefined();
    expect(mockReplyImageInThread).toHaveBeenCalledWith('thread_root_1', 'img_key_1');
    expect(mockSendImage).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('话题');
  });

  it('should return error when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    feishuSendImageTool('chat_123');
    const result = await capturedHandler({ file_path: '/abs/missing.png' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('不存在');
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  it('should return error when file is too large', async () => {
    mockStatSync.mockReturnValue({ isFile: () => true, size: 11 * 1024 * 1024 });
    feishuSendImageTool('chat_123');
    const result = await capturedHandler({ file_path: '/abs/huge.png' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('过大');
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  it('should return error when file is empty', async () => {
    mockStatSync.mockReturnValue({ isFile: () => true, size: 0 });
    feishuSendImageTool('chat_123');
    const result = await capturedHandler({ file_path: '/abs/empty.png' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('为空');
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  it('should return error for unsupported (non-image) format', async () => {
    writeHeader(Buffer.from([0x00, 0x01, 0x02, 0x03])); // not an image
    feishuSendImageTool('chat_123');
    const result = await capturedHandler({ file_path: '/abs/data.bin' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('无法识别');
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  it('should return error when upload returns no image_key', async () => {
    mockUploadImage.mockResolvedValue(undefined);
    feishuSendImageTool('chat_123');
    const result = await capturedHandler({ file_path: '/abs/out.png' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('image_key');
    expect(mockSendImage).not.toHaveBeenCalled();
  });

  it('should return error when send returns no message_id', async () => {
    mockSendImage.mockResolvedValue(undefined);
    feishuSendImageTool('chat_123');
    const result = await capturedHandler({ file_path: '/abs/out.png' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('发送失败');
  });

  it('should return error when upload throws', async () => {
    mockUploadImage.mockRejectedValue(new Error('network down'));
    feishuSendImageTool('chat_123');
    const result = await capturedHandler({ file_path: '/abs/out.png' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network down');
  });

  it('should accept jpg via magic bytes', async () => {
    writeHeader(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
    feishuSendImageTool('chat_123');
    const result = await capturedHandler({ file_path: '/abs/photo.jpg' }) as any;
    expect(result.isError).toBeUndefined();
    expect(mockSendImage).toHaveBeenCalledWith('chat_123', 'img_key_1');
  });
});
