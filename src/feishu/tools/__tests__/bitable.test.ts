// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockAppTableList = vi.fn();
const mockAppTableFieldList = vi.fn();
const mockAppTableRecordList = vi.fn();
const mockAppTableRecordGet = vi.fn();
const mockAppTableRecordCreate = vi.fn();
const mockAppTableRecordUpdate = vi.fn();
const mockAppTableRecordDelete = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    raw: {
      bitable: {
        appTable: {
          list: (...args: unknown[]) => mockAppTableList(...args),
        },
        appTableField: {
          list: (...args: unknown[]) => mockAppTableFieldList(...args),
        },
        appTableRecord: {
          list: (...args: unknown[]) => mockAppTableRecordList(...args),
          get: (...args: unknown[]) => mockAppTableRecordGet(...args),
          create: (...args: unknown[]) => mockAppTableRecordCreate(...args),
          update: (...args: unknown[]) => mockAppTableRecordUpdate(...args),
          delete: (...args: unknown[]) => mockAppTableRecordDelete(...args),
        },
      },
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

import { feishuBitableTool } from '../bitable.js';

beforeEach(() => {
  vi.clearAllMocks();
  feishuBitableTool();
});

describe('feishu_bitable tool', () => {
  describe('list_tables', () => {
    it('should return table list', async () => {
      mockAppTableList.mockResolvedValue({
        code: 0,
        data: { items: [{ table_id: 'tbl1', name: '表格1' }] },
      });
      const result = await capturedHandler({ action: 'list_tables', app_token: 'APP1' });
      expect(result.content[0].text).toContain('tbl1');
    });

    it('should require app_token', async () => {
      const result = await capturedHandler({ action: 'list_tables' });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_fields', () => {
    it('should return field list', async () => {
      mockAppTableFieldList.mockResolvedValue({
        code: 0,
        data: { items: [{ field_id: 'fld1', field_name: '字段1' }] },
      });
      const result = await capturedHandler({
        action: 'list_fields', app_token: 'APP1', table_id: 'TBL1',
      });
      expect(result.content[0].text).toContain('fld1');
    });
  });

  describe('list_records', () => {
    it('should return records with filter', async () => {
      mockAppTableRecordList.mockResolvedValue({
        code: 0,
        data: { total: 1, items: [{ record_id: 'rec1' }] },
      });
      const result = await capturedHandler({
        action: 'list_records', app_token: 'APP1', table_id: 'TBL1',
        filter: 'CurrentValue.[字段]="值"', page_size: 10,
      });
      expect(result.content[0].text).toContain('rec1');
    });
  });

  describe('get_record', () => {
    it('should return a single record', async () => {
      mockAppTableRecordGet.mockResolvedValue({
        code: 0,
        data: { record: { record_id: 'rec1', fields: { name: '张三' } } },
      });
      const result = await capturedHandler({
        action: 'get_record', app_token: 'APP1', table_id: 'TBL1', record_id: 'REC1',
      });
      expect(result.content[0].text).toContain('张三');
    });

    it('should require record_id', async () => {
      const result = await capturedHandler({
        action: 'get_record', app_token: 'APP1', table_id: 'TBL1',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('create_record', () => {
    it('should create a record', async () => {
      mockAppTableRecordCreate.mockResolvedValue({
        code: 0,
        data: { record: { record_id: 'NEW_REC' } },
      });
      const result = await capturedHandler({
        action: 'create_record', app_token: 'APP1', table_id: 'TBL1',
        fields: '{"name": "张三"}',
      });
      expect(result.content[0].text).toContain('NEW_REC');
    });

    it('should require fields', async () => {
      const result = await capturedHandler({
        action: 'create_record', app_token: 'APP1', table_id: 'TBL1',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('update_record', () => {
    it('should update a record', async () => {
      mockAppTableRecordUpdate.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'update_record', app_token: 'APP1', table_id: 'TBL1',
        record_id: 'REC1', fields: '{"name": "李四"}',
      });
      expect(result.content[0].text).toBe('记录已更新');
    });
  });

  describe('delete_record', () => {
    it('should delete a record', async () => {
      mockAppTableRecordDelete.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'delete_record', app_token: 'APP1', table_id: 'TBL1', record_id: 'REC1',
      });
      expect(result.content[0].text).toBe('记录已删除');
    });
  });

  describe('fields validation', () => {
    it('should reject invalid JSON', async () => {
      const result = await capturedHandler({
        action: 'create_record', app_token: 'APP1', table_id: 'TBL1',
        fields: 'not-json',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('不是有效的 JSON');
    });

    it('should reject array fields', async () => {
      const result = await capturedHandler({
        action: 'create_record', app_token: 'APP1', table_id: 'TBL1',
        fields: '[1,2,3]',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('JSON 对象');
    });

    it('should reject __proto__ in fields (prototype pollution)', async () => {
      const result = await capturedHandler({
        action: 'create_record', app_token: 'APP1', table_id: 'TBL1',
        fields: '{"__proto__": {"admin": true}}',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('不允许的 key');
    });

    it('should reject string fields', async () => {
      const result = await capturedHandler({
        action: 'create_record', app_token: 'APP1', table_id: 'TBL1',
        fields: '"just a string"',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('JSON 对象');
    });
  });

  describe('token validation', () => {
    it('should reject invalid app_token', async () => {
      const result = await capturedHandler({
        action: 'list_tables', app_token: '../bad',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('无效的 app_token');
    });
  });

  describe('API error handling', () => {
    it('should handle API error codes', async () => {
      mockAppTableList.mockResolvedValue({ code: 99999, msg: 'forbidden' });
      const result = await capturedHandler({ action: 'list_tables', app_token: 'APP1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('99999');
    });

    it('should handle thrown exceptions', async () => {
      mockAppTableList.mockRejectedValue(new Error('network error'));
      const result = await capturedHandler({ action: 'list_tables', app_token: 'APP1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('network error');
    });
  });
});
