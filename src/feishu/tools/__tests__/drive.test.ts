// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockDriveFileListWithIterator = vi.fn();
const mockDriveFileCreateFolder = vi.fn();
const mockClientRequest = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    raw: {
      drive: {
        file: {
          listWithIterator: (...args: unknown[]) => mockDriveFileListWithIterator(...args),
          createFolder: (...args: unknown[]) => mockDriveFileCreateFolder(...args),
        },
      },
      request: (...args: unknown[]) => mockClientRequest(...args),
    },
  },
}));

let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => {
    capturedHandler = handler as typeof capturedHandler;
    return { name: _name, handler };
  },
}));

import { feishuDriveTool } from '../drive.js';

beforeEach(() => {
  vi.clearAllMocks();
  feishuDriveTool();
});

describe('feishu_drive tool', () => {
  describe('list action', () => {
    it('should return file list', async () => {
      // Mock async iterator
      mockDriveFileListWithIterator.mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          let called = false;
          return {
            next: () => {
              if (!called) {
                called = true;
                return Promise.resolve({
                  value: { files: [{ name: 'file1.txt', token: 'f1' }] },
                  done: false,
                });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      });

      const result = await capturedHandler({ action: 'list' });
      expect(result.content[0].text).toContain('file1.txt');
    });
  });

  describe('info action', () => {
    it('should return file info', async () => {
      mockClientRequest.mockResolvedValue({
        code: 0,
        data: { file: { name: 'file1.txt', type: 'docx' } },
      });
      const result = await capturedHandler({ action: 'info', file_token: 'FT123' });
      expect(result.content[0].text).toContain('file1.txt');
    });

    it('should require file_token', async () => {
      const result = await capturedHandler({ action: 'info' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('file_token');
    });

    it('should handle API error', async () => {
      mockClientRequest.mockResolvedValue({ code: 99999, msg: 'not found' });
      const result = await capturedHandler({ action: 'info', file_token: 'FT123' });
      expect(result.isError).toBe(true);
    });
  });

  describe('create_folder action', () => {
    it('should create a folder', async () => {
      mockDriveFileCreateFolder.mockResolvedValue({
        code: 0,
        data: { token: 'NEW_FOLDER', url: 'https://...' },
      });
      const result = await capturedHandler({ action: 'create_folder', name: '新文件夹' });
      expect(result.content[0].text).toContain('NEW_FOLDER');
    });

    it('should require name', async () => {
      const result = await capturedHandler({ action: 'create_folder' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name');
    });
  });

  describe('token validation', () => {
    it('should reject invalid folder_token', async () => {
      const result = await capturedHandler({ action: 'list', folder_token: 'a/b' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('无效的 folder_token');
    });

    it('should reject invalid file_token', async () => {
      const result = await capturedHandler({ action: 'info', file_token: 'a b' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('无效的 file_token');
    });
  });
});
