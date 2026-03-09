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
const mockDocxDocumentBlockBatchUpdate = vi.fn();
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
          batchUpdate: (...args: unknown[]) => mockDocxDocumentBlockBatchUpdate(...args),
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
    it('should clear and write document with markdown blocks', async () => {
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
        action: 'write', doc_token: 'ABC123', content: '# 标题\n\n- 列表项',
      });
      expect(result.content[0].text).toBe('文档已更新');
      expect(mockDocxDocumentBlockChildrenBatchDelete).toHaveBeenCalled();
      expect(mockDocxDocumentBlockChildrenCreate).toHaveBeenCalled();
      // Verify blocks contain heading and bullet, not a single text block
      const createCall = mockDocxDocumentBlockChildrenCreate.mock.calls[0][0];
      const children = createCall.data.children;
      expect(children[0].block_type).toBe(3); // heading1
      expect(children[1].block_type).toBe(12); // bullet
    });

    it('should return error when batchDelete fails', async () => {
      mockDocxDocumentBlockList.mockResolvedValue({
        code: 0,
        data: {
          items: [
            { block_id: 'page_1', block_type: 1 },
            { block_id: 'text_1', block_type: 2 },
          ],
        },
      });
      mockDocxDocumentBlockChildrenBatchDelete.mockResolvedValue({ code: 99999, msg: 'delete failed' });
      const result = await capturedHandler({
        action: 'write', doc_token: 'ABC123', content: '# 标题',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('99999');
    });

    it('should return error when create fails', async () => {
      mockDocxDocumentBlockList.mockResolvedValue({
        code: 0,
        data: { items: [{ block_id: 'page_1', block_type: 1 }] },
      });
      mockDocxDocumentBlockChildrenCreate.mockResolvedValue({ code: 99999, msg: 'write failed' });
      const result = await capturedHandler({
        action: 'write', doc_token: 'ABC123', content: '# 标题',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('99999');
    });
  });

  describe('append action', () => {
    it('should append markdown content as blocks', async () => {
      mockDocxDocumentBlockList.mockResolvedValue({
        code: 0,
        data: { items: [{ block_id: 'page_1', block_type: 1 }] },
      });
      mockDocxDocumentBlockChildrenCreate.mockResolvedValue({ code: 0 });

      const result = await capturedHandler({
        action: 'append', doc_token: 'ABC123', content: '## 小标题\n\n追加段落',
      });
      expect(result.content[0].text).toBe('内容已追加');
      const createCall = mockDocxDocumentBlockChildrenCreate.mock.calls[0][0];
      const children = createCall.data.children;
      expect(children[0].block_type).toBe(4); // heading2
      expect(children[1].block_type).toBe(2); // text
    });
  });

  describe('update_block action', () => {
    it('should update block text content', async () => {
      mockDocxDocumentBlockBatchUpdate.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'update_block', doc_token: 'ABC123', block_id: 'blk_001', content: '新的文本内容',
      });
      expect(result.content[0].text).toBe('Block 已更新');
      expect(mockDocxDocumentBlockBatchUpdate).toHaveBeenCalledWith({
        path: { document_id: 'ABC123' },
        data: {
          requests: [{
            block_id: 'blk_001',
            update_text_elements: {
              elements: [{ text_run: { content: '新的文本内容' } }],
            },
          }],
        },
      });
    });

    it('should support inline markdown in update', async () => {
      mockDocxDocumentBlockBatchUpdate.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'update_block', doc_token: 'ABC123', block_id: 'blk_001', content: '这是**加粗**文本',
      });
      expect(result.content[0].text).toBe('Block 已更新');
      const call = mockDocxDocumentBlockBatchUpdate.mock.calls[0][0];
      const elements = call.data.requests[0].update_text_elements.elements;
      expect(elements[1].text_run.text_element_style.bold).toBe(true);
    });

    it('should return error when block_id is missing', async () => {
      const result = await capturedHandler({
        action: 'update_block', doc_token: 'ABC123', content: 'text',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('block_id');
    });

    it('should return error on API failure', async () => {
      mockDocxDocumentBlockBatchUpdate.mockResolvedValue({ code: 99999, msg: 'update failed' });
      const result = await capturedHandler({
        action: 'update_block', doc_token: 'ABC123', block_id: 'blk_001', content: 'text',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('99999');
    });
  });

  describe('insert_blocks action', () => {
    it('should insert markdown blocks at specified position', async () => {
      mockDocxDocumentBlockChildrenCreate.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'insert_blocks', doc_token: 'ABC123', block_id: 'page_1',
        content: '## 插入标题', index: 2,
      });
      expect(result.content[0].text).toContain('1 个 block');
      const call = mockDocxDocumentBlockChildrenCreate.mock.calls[0][0];
      expect(call.path.block_id).toBe('page_1');
      expect(call.data.index).toBe(2);
      expect(call.data.children[0].block_type).toBe(4); // heading2
    });

    it('should insert without index (append to parent)', async () => {
      mockDocxDocumentBlockChildrenCreate.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'insert_blocks', doc_token: 'ABC123', block_id: 'page_1',
        content: '新段落',
      });
      expect(result.content[0].text).toContain('1 个 block');
      const call = mockDocxDocumentBlockChildrenCreate.mock.calls[0][0];
      expect(call.data.index).toBeUndefined();
    });

    it('should increment index across multiple batches', async () => {
      mockDocxDocumentBlockChildrenCreate.mockResolvedValue({ code: 0 });
      // Create content that produces >50 blocks to trigger multiple batches
      const lines = Array.from({ length: 60 }, (_, i) => `- item ${i}`).join('\n');
      const result = await capturedHandler({
        action: 'insert_blocks', doc_token: 'ABC123', block_id: 'page_1',
        content: lines, index: 5,
      });
      expect(result.content[0].text).toContain('60 个 block');
      expect(mockDocxDocumentBlockChildrenCreate).toHaveBeenCalledTimes(2);
      // First batch at index 5
      const call1 = mockDocxDocumentBlockChildrenCreate.mock.calls[0][0];
      expect(call1.data.index).toBe(5);
      // Second batch at index 5 + 50 = 55
      const call2 = mockDocxDocumentBlockChildrenCreate.mock.calls[1][0];
      expect(call2.data.index).toBe(55);
    });

    it('should return error when block_id is missing', async () => {
      const result = await capturedHandler({
        action: 'insert_blocks', doc_token: 'ABC123', content: 'text',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('block_id');
    });

    it('should return error on API failure', async () => {
      mockDocxDocumentBlockChildrenCreate.mockResolvedValue({ code: 99999, msg: 'insert failed' });
      const result = await capturedHandler({
        action: 'insert_blocks', doc_token: 'ABC123', block_id: 'page_1', content: '段落',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('99999');
    });
  });

  describe('delete_blocks action', () => {
    it('should delete a block by id', async () => {
      mockDocxDocumentBlockList.mockResolvedValue({
        code: 0,
        data: {
          items: [
            { block_id: 'page_1', block_type: 1, children: ['blk_a', 'blk_b', 'blk_c'] },
            { block_id: 'blk_a', block_type: 2, parent_id: 'page_1' },
            { block_id: 'blk_b', block_type: 3, parent_id: 'page_1' },
            { block_id: 'blk_c', block_type: 2, parent_id: 'page_1' },
          ],
        },
      });
      mockDocxDocumentBlockChildrenBatchDelete.mockResolvedValue({ code: 0 });

      const result = await capturedHandler({
        action: 'delete_blocks', doc_token: 'ABC123', block_id: 'blk_b',
      });
      expect(result.content[0].text).toBe('Block 已删除');
      expect(mockDocxDocumentBlockChildrenBatchDelete).toHaveBeenCalledWith({
        path: { document_id: 'ABC123', block_id: 'page_1' },
        data: { start_index: 1, end_index: 2 },
      });
    });

    it('should return error when block not found', async () => {
      mockDocxDocumentBlockList.mockResolvedValue({
        code: 0,
        data: { items: [{ block_id: 'page_1', block_type: 1 }] },
      });
      const result = await capturedHandler({
        action: 'delete_blocks', doc_token: 'ABC123', block_id: 'nonexistent',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('未找到');
    });

    it('should return error when block_id is missing', async () => {
      const result = await capturedHandler({
        action: 'delete_blocks', doc_token: 'ABC123',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('block_id');
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
