// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockTaskCreate = vi.fn();
const mockTaskGet = vi.fn();
const mockTaskList = vi.fn();
const mockTaskPatch = vi.fn();
const mockRequest = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    raw: {
      task: {
        v1: {
          task: {
            list: (...args: unknown[]) => mockTaskList(...args),
          },
        },
        v2: {
          task: {
            create: (...args: unknown[]) => mockTaskCreate(...args),
            get: (...args: unknown[]) => mockTaskGet(...args),
            patch: (...args: unknown[]) => mockTaskPatch(...args),
          },
        },
      },
      request: (...args: unknown[]) => mockRequest(...args),
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

import { feishuTaskTool, parseDueDate } from '../task.js';

beforeEach(() => {
  vi.clearAllMocks();
  feishuTaskTool();
});

// ============================================================
// parseDueDate 单元测试
// ============================================================

describe('parseDueDate', () => {
  it('should pass through valid second-level timestamps', () => {
    expect(parseDueDate('1773532800')).toBe('1773532800');
    expect(parseDueDate('1700000000')).toBe('1700000000');
  });

  it('should convert millisecond timestamps to seconds', () => {
    expect(parseDueDate('1773532800000')).toBe('1773532800');
    expect(parseDueDate('1700000000123')).toBe('1700000000');
  });

  it('should reject out-of-range numeric strings (e.g. "20260315")', () => {
    expect(() => parseDueDate('20260315')).toThrow('无效的时间戳');
    expect(() => parseDueDate('999999999')).toThrow('无效的时间戳');
    expect(() => parseDueDate('0')).toThrow('无效的时间戳');
  });

  it('should parse date-only strings as UTC midnight', () => {
    // 2026-03-15T00:00:00Z = 1773532800
    const result = parseDueDate('2026-03-15');
    expect(result).toBe(String(new Date('2026-03-15T00:00:00Z').getTime() / 1000));
  });

  it('should parse datetime without timezone as UTC', () => {
    // "2026-03-15T10:00:00" should be treated as UTC
    const result = parseDueDate('2026-03-15T10:00:00');
    const expected = String(new Date('2026-03-15T10:00:00Z').getTime() / 1000);
    expect(result).toBe(expected);
  });

  it('should parse datetime with short format (no seconds) as UTC', () => {
    const result = parseDueDate('2026-03-15T10:00');
    const expected = String(new Date('2026-03-15T10:00Z').getTime() / 1000);
    expect(result).toBe(expected);
  });

  it('should preserve timezone in datetime with explicit timezone', () => {
    const result = parseDueDate('2026-03-15T10:00:00+08:00');
    const expected = String(new Date('2026-03-15T10:00:00+08:00').getTime() / 1000);
    expect(result).toBe(expected);
  });

  it('should handle whitespace trimming', () => {
    expect(parseDueDate('  1773532800  ')).toBe('1773532800');
    expect(parseDueDate('  2026-03-15  ')).toBe(String(new Date('2026-03-15T00:00:00Z').getTime() / 1000));
  });

  it('should throw on invalid date strings', () => {
    expect(() => parseDueDate('not-a-date')).toThrow('无效的日期格式');
    expect(() => parseDueDate('')).toThrow();
    expect(() => parseDueDate('abc123')).toThrow();
  });

  it('should throw on invalid date-only format', () => {
    expect(() => parseDueDate('9999-99-99')).toThrow('无效的日期');
  });
});

// ============================================================
// feishu_task tool 单元测试
// ============================================================

describe('feishu_task tool', () => {
  describe('create', () => {
    it('should create a task with only summary', async () => {
      mockTaskCreate.mockResolvedValue({
        code: 0,
        data: { task: { guid: 'TASK_001', summary: '开会' } },
      });
      const result = await capturedHandler({ action: 'create', summary: '开会' });
      expect(result.content[0].text).toContain('TASK_001');
      expect(result.content[0].text).toContain('开会');
      expect(mockTaskCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ summary: '开会' }),
        params: { user_id_type: 'open_id' },
      }));
    });

    it('should create a task with due date and description', async () => {
      mockTaskCreate.mockResolvedValue({
        code: 0,
        data: { task: { guid: 'TASK_002', summary: '发布版本', due: { timestamp: '1773532800' } } },
      });
      const result = await capturedHandler({
        action: 'create',
        summary: '发布版本',
        description: '发布 v2.0',
        due: '2026-03-15',
      });
      expect(result.content[0].text).toContain('TASK_002');
      const callData = mockTaskCreate.mock.calls[0][0].data;
      expect(callData.description).toBe('发布 v2.0');
      expect(callData.due.timestamp).toBe(String(new Date('2026-03-15T00:00:00Z').getTime() / 1000));
      expect(callData.due.is_all_day).toBe(false);
    });

    it('should create a task with members', async () => {
      mockTaskCreate.mockResolvedValue({
        code: 0,
        data: { task: { guid: 'TASK_003', summary: '任务' } },
      });
      const result = await capturedHandler({
        action: 'create',
        summary: '任务',
        members: '[{"id": "ou_123", "role": "assignee"}]',
      });
      expect(result.isError).toBeUndefined();
      const callData = mockTaskCreate.mock.calls[0][0].data;
      expect(callData.members).toEqual([{ id: 'ou_123', role: 'assignee' }]);
    });

    it('should create a task with is_all_day', async () => {
      mockTaskCreate.mockResolvedValue({
        code: 0,
        data: { task: { guid: 'TASK_004', summary: '全天任务' } },
      });
      await capturedHandler({
        action: 'create',
        summary: '全天任务',
        due: '2026-03-15',
        is_all_day: true,
      });
      const callData = mockTaskCreate.mock.calls[0][0].data;
      expect(callData.due.is_all_day).toBe(true);
    });

    it('should require summary', async () => {
      const result = await capturedHandler({ action: 'create' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('summary');
    });

    it('should reject invalid members JSON', async () => {
      const result = await capturedHandler({
        action: 'create',
        summary: '任务',
        members: 'not-json',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('不是有效的 JSON');
    });

    it('should reject members without id/role', async () => {
      const result = await capturedHandler({
        action: 'create',
        summary: '任务',
        members: '[{"name": "张三"}]',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('id');
    });

    it('should reject non-array members', async () => {
      const result = await capturedHandler({
        action: 'create',
        summary: '任务',
        members: '{"id": "ou_123", "role": "assignee"}',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('JSON 数组');
    });
  });

  describe('get', () => {
    it('should return task details', async () => {
      mockTaskGet.mockResolvedValue({
        code: 0,
        data: {
          task: {
            guid: 'TASK_001',
            summary: '开会',
            description: '周一例会',
            completed_at: '0',
          },
        },
      });
      const result = await capturedHandler({ action: 'get', task_guid: 'TASK_001' });
      expect(result.content[0].text).toContain('开会');
      expect(result.content[0].text).toContain('周一例会');
    });

    it('should require task_guid', async () => {
      const result = await capturedHandler({ action: 'get' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('task_guid');
    });
  });

  describe('list', () => {
    it('should list tasks via v1 API and map to v2 format', async () => {
      mockTaskList.mockResolvedValue({
        code: 0,
        data: {
          items: [
            { id: 'T1', summary: '任务1', due: { time: '0', is_all_day: false }, complete_time: '0', creator_id: 'ou_111' },
            { id: 'T2', summary: '任务2', due: { time: '1773532800', is_all_day: true }, complete_time: '1773600000', creator_id: 'ou_222' },
          ],
          has_more: false,
        },
      });
      const result = await capturedHandler({ action: 'list' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items[0].guid).toBe('T1');
      expect(parsed.items[0].due).toBeUndefined(); // time=0 → no due
      expect(parsed.items[0].completed_at).toBeUndefined(); // complete_time=0 → not completed
      expect(parsed.items[1].guid).toBe('T2');
      expect(parsed.items[1].due).toEqual({ timestamp: '1773532800', is_all_day: true });
      expect(parsed.items[1].completed_at).toBe('1773600000');
      expect(mockTaskList).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ page_size: 20, user_id_type: 'open_id' }),
      }));
    });

    it('should pass page_size and map completed to task_completed', async () => {
      mockTaskList.mockResolvedValue({
        code: 0,
        data: { items: [], has_more: false },
      });
      await capturedHandler({ action: 'list', page_size: 10, completed: true });
      expect(mockTaskList).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ page_size: 10, task_completed: true }),
      }));
    });

    it('should pass page_token for pagination', async () => {
      mockTaskList.mockResolvedValue({
        code: 0,
        data: { items: [], has_more: false },
      });
      await capturedHandler({ action: 'list', page_token: 'next_page_abc' });
      expect(mockTaskList).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ page_token: 'next_page_abc' }),
      }));
    });
  });

  describe('update', () => {
    it('should update task summary', async () => {
      mockTaskPatch.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'update',
        task_guid: 'TASK_001',
        update_fields: 'summary',
        summary: '新标题',
      });
      expect(result.content[0].text).toBe('任务已更新');
      expect(mockTaskPatch).toHaveBeenCalledWith(expect.objectContaining({
        path: { task_guid: 'TASK_001' },
        data: expect.objectContaining({
          task: expect.objectContaining({ summary: '新标题' }),
          update_fields: ['summary'],
        }),
      }));
    });

    it('should update multiple fields', async () => {
      mockTaskPatch.mockResolvedValue({ code: 0 });
      await capturedHandler({
        action: 'update',
        task_guid: 'TASK_001',
        update_fields: 'summary, due',
        summary: '更新标题',
        due: '1773532800',
      });
      const callData = mockTaskPatch.mock.calls[0][0].data;
      expect(callData.update_fields).toEqual(['summary', 'due']);
      expect(callData.task.summary).toBe('更新标题');
      expect(callData.task.due.timestamp).toBe('1773532800');
    });

    it('should require task_guid', async () => {
      const result = await capturedHandler({
        action: 'update',
        update_fields: 'summary',
        summary: '新标题',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('task_guid');
    });

    it('should require update_fields', async () => {
      const result = await capturedHandler({
        action: 'update',
        task_guid: 'TASK_001',
        summary: '新标题',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('update_fields');
    });

    it('should reject empty update_fields', async () => {
      const result = await capturedHandler({
        action: 'update',
        task_guid: 'TASK_001',
        update_fields: '  ,  ',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('update_fields');
    });
  });

  describe('token validation', () => {
    it('should reject invalid task_guid', async () => {
      const result = await capturedHandler({
        action: 'get',
        task_guid: '../bad/path',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('无效的 task_guid');
    });
  });

  describe('API error handling', () => {
    it('should handle API error codes', async () => {
      mockTaskCreate.mockResolvedValue({ code: 99999, msg: 'forbidden' });
      const result = await capturedHandler({ action: 'create', summary: '任务' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('99999');
    });

    it('should handle thrown exceptions', async () => {
      mockTaskGet.mockRejectedValue(new Error('network error'));
      const result = await capturedHandler({ action: 'get', task_guid: 'TASK_001' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('network error');
    });
  });

  describe('unknown action', () => {
    it('should return error for unknown action', async () => {
      const result = await capturedHandler({ action: 'delete' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('未知 action');
    });
  });
});

// ============================================================
// list with user_access_token (Task v2 API)
// ============================================================

describe('feishu_task tool with getUserToken', () => {
  let handlerWithToken: (args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockGetUserToken = vi.fn().mockResolvedValue('u-test-access-token');
    feishuTaskTool(mockGetUserToken);
    handlerWithToken = capturedHandler;
  });

  it('should use Task v2 API with user token for list', async () => {
    mockRequest.mockResolvedValue({
      code: 0,
      data: {
        items: [
          { guid: 'T1', summary: '个人任务', due: { timestamp: '1773532800' }, creator: { id: 'ou_123' } },
        ],
        has_more: false,
      },
    });

    const result = await handlerWithToken({ action: 'list' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._token_type).toBe('user');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].guid).toBe('T1');

    // Should use client.request with user token header, not client.task.v1.task.list
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/open-apis/task/v2/tasks',
      headers: { Authorization: 'Bearer u-test-access-token' },
    }));
    expect(mockTaskList).not.toHaveBeenCalled();
  });

  it('should fall back to v1 API when getUserToken returns undefined', async () => {
    // Create a new tool instance with getUserToken returning undefined
    const mockGetNoToken = vi.fn().mockResolvedValue(undefined);
    feishuTaskTool(mockGetNoToken);
    const handler = capturedHandler;

    mockTaskList.mockResolvedValue({
      code: 0,
      data: { items: [], has_more: false },
    });

    const result = await handler({ action: 'list' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._token_type).toBe('bot');
    expect(mockTaskList).toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
