// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockDocxDocumentRawContent = vi.fn();
const mockDocxDocumentCreate = vi.fn();
const mockDocxDocumentBlockList = vi.fn();
const mockDocxDocumentBlockChildrenBatchDelete = vi.fn();
const mockDocxDocumentBlockChildrenCreate = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    raw: {
      docx: {
        document: {
          rawContent: (...args: unknown[]) => mockDocxDocumentRawContent(...args),
          create: (...args: unknown[]) => mockDocxDocumentCreate(...args),
        },
        documentBlock: {
          list: (...args: unknown[]) => mockDocxDocumentBlockList(...args),
        },
        documentBlockChildren: {
          batchDelete: (...args: unknown[]) => mockDocxDocumentBlockChildrenBatchDelete(...args),
          create: (...args: unknown[]) => mockDocxDocumentBlockChildrenCreate(...args),
        },
      },
    },
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

import { feishuDocTool } from '../doc.js';

beforeEach(() => {
  vi.clearAllMocks();
  feishuDocTool(); // triggers tool() which captures handler
});

// ============================================================
// Tests
// ============================================================

describe('feishu_doc tool', () => {
  describe('read action', () => {
    it('should return document content', async () => {
      mockDocxDocumentRawContent.mockResolvedValue({
        code: 0,
        data: { content: '文档内容' },
      });
      const result = await capturedHandler({ action: 'read', doc_token: 'ABC123' });
      expect(result.content[0].text).toBe('文档内容');
      expect(mockDocxDocumentRawContent).toHaveBeenCalledWith({
        path: { document_id: 'ABC123' },
        params: { lang: 0 },
      });
    });

    it('should return error when doc_token is missing', async () => {
      const result = await capturedHandler({ action: 'read' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('doc_token');
    });

    it('should handle API error', async () => {
      mockDocxDocumentRawContent.mockResolvedValue({
        code: 99999,
        msg: 'permission denied',
      });
      const result = await capturedHandler({ action: 'read', doc_token: 'ABC123' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('99999');
    });
  });

  describe('create action', () => {
    it('should create a document', async () => {
      mockDocxDocumentCreate.mockResolvedValue({
        code: 0,
        data: { document: { document_id: 'NEW_TOKEN', title: '新文档', url: 'https://...' } },
      });
      const result = await capturedHandler({ action: 'create', title: '新文档' });
      expect(result.content[0].text).toContain('NEW_TOKEN');
      expect(result.isError).toBeUndefined();
    });

    it('should return error when title is missing', async () => {
      const result = await capturedHandler({ action: 'create' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('title');
    });
  });

  describe('list_blocks action', () => {
    it('should return block list', async () => {
      mockDocxDocumentBlockList.mockResolvedValue({
        code: 0,
        data: { items: [{ block_id: 'b1', block_type: 1 }] },
      });
      const result = await capturedHandler({ action: 'list_blocks', doc_token: 'ABC123' });
      expect(result.content[0].text).toContain('b1');
    });
  });

  describe('write action', () => {
    it('should clear and write document', async () => {
      mockDocxDocumentBlockList.mockResolvedValue({
        code: 0,
        data: {
          items: [
            { block_id: 'page_1', block_type: 1 },
            { block_id: 'text_1', block_type: 2 },
          ],
        },
      });
      mockDocxDocumentBlockChildrenBatchDelete.mockResolvedValue({ code: 0 });
      mockDocxDocumentBlockChildrenCreate.mockResolvedValue({ code: 0 });

      const result = await capturedHandler({
        action: 'write', doc_token: 'ABC123', content: '新内容',
      });
      expect(result.content[0].text).toBe('文档已更新');
      expect(mockDocxDocumentBlockChildrenBatchDelete).toHaveBeenCalled();
      expect(mockDocxDocumentBlockChildrenCreate).toHaveBeenCalled();
    });
  });

  describe('append action', () => {
    it('should append content', async () => {
      mockDocxDocumentBlockList.mockResolvedValue({
        code: 0,
        data: { items: [{ block_id: 'page_1', block_type: 1 }] },
      });
      mockDocxDocumentBlockChildrenCreate.mockResolvedValue({ code: 0 });

      const result = await capturedHandler({
        action: 'append', doc_token: 'ABC123', content: '追加内容',
      });
      expect(result.content[0].text).toBe('内容已追加');
    });
  });

  describe('token validation', () => {
    it('should reject invalid doc_token', async () => {
      const result = await capturedHandler({ action: 'read', doc_token: '../etc' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('无效的 doc_token');
    });

    it('should reject invalid folder_token', async () => {
      const result = await capturedHandler({
        action: 'create', title: 'test', folder_token: 'a b c',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('无效的 folder_token');
    });
  });
});
