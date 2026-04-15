// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockDownloadMessageFile = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    downloadMessageFile: (...args: unknown[]) => mockDownloadMessageFile(...args),
  },
}));

// Mock fs/promises to avoid actual file I/O
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

// Mock the SDK tool() — capture the handler function for direct testing
let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => {
    capturedHandler = handler as typeof capturedHandler;
    return { name: _name, handler };
  },
}));

import { feishuMessageFileTool } from '../message.js';

// ============================================================
// Tests
// ============================================================

describe('feishu_download_message_file tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feishuMessageFileTool(); // triggers tool() which captures handler
  });

  it('downloads file and returns local path', async () => {
    const fileContent = Buffer.from('fake PDF content here');
    mockDownloadMessageFile.mockResolvedValue(fileContent);

    const result = await capturedHandler({
      message_id: 'om_test123',
      file_key: 'file_abc',
    }) as any;

    expect(result.isError).toBeUndefined();
    expect(mockDownloadMessageFile).toHaveBeenCalledWith('om_test123', 'file_abc');
    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();

    const text = result.content[0].text;
    expect(text).toContain('文件已下载到');
    expect(text).toContain('Read');
  });

  it('returns error for files exceeding size limit', async () => {
    // 31MB buffer
    const bigBuffer = Buffer.alloc(31 * 1024 * 1024);
    mockDownloadMessageFile.mockResolvedValue(bigBuffer);

    const result = await capturedHandler({
      message_id: 'om_big',
      file_key: 'file_big',
    }) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('文件过大');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('returns error on download failure', async () => {
    mockDownloadMessageFile.mockRejectedValue(new Error('API rate limit'));

    const result = await capturedHandler({
      message_id: 'om_fail',
      file_key: 'file_fail',
    }) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('下载文件失败');
    expect(result.content[0].text).toContain('API rate limit');
  });

  it('sanitizes file path to prevent path traversal', async () => {
    mockDownloadMessageFile.mockResolvedValue(Buffer.from('content'));

    await capturedHandler({
      message_id: 'om_../../etc/passwd',
      file_key: 'file_key',
    });

    // The path should have unsafe chars replaced
    const writtenPath = mockWriteFile.mock.calls[0][0] as string;
    expect(writtenPath).not.toContain('..');
    expect(writtenPath).not.toContain('/etc/passwd');
  });

  it('creates download directory with recursive flag', async () => {
    mockDownloadMessageFile.mockResolvedValue(Buffer.from('content'));

    await capturedHandler({
      message_id: 'om_test',
      file_key: 'fk_test',
    });

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('feishu-downloads'),
      { recursive: true },
    );
  });

  it('shows file size in KB in the response', async () => {
    // 5KB file
    mockDownloadMessageFile.mockResolvedValue(Buffer.alloc(5120));

    const result = await capturedHandler({
      message_id: 'om_sized',
      file_key: 'fk_sized',
    }) as any;

    expect(result.content[0].text).toContain('5.0KB');
  });
});
