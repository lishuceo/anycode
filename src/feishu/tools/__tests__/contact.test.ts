// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockContactUserGet = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    raw: {
      contact: {
        user: {
          get: (...args: unknown[]) => mockContactUserGet(...args),
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

import { feishuContactTool } from '../contact.js';

// ============================================================
// Tests
// ============================================================

describe('feishu_contact tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feishuContactTool(); // triggers tool() which captures handler
  });

  it('should return error when open_id is missing for get_user', async () => {
    const result = await capturedHandler({ action: 'get_user' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('缺少参数: open_id');
  });

  it('should return user info on success', async () => {
    mockContactUserGet.mockResolvedValue({
      code: 0,
      data: {
        user: {
          name: '张三',
          en_name: 'Zhang San',
          open_id: 'ou_test123',
          union_id: 'on_union456',
          user_id: 'uid789',
          avatar: {
            avatar_origin: 'https://example.com/avatar.jpg',
            avatar_240: 'https://example.com/avatar_240.jpg',
          },
          department_ids: ['dep_001', 'dep_002'],
          job_title: '高级工程师',
          city: '上海',
          employee_no: 'EMP001',
        },
      },
    });

    const result = await capturedHandler({ action: 'get_user', open_id: 'ou_test123' }) as any;
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;

    expect(text).toContain('姓名: 张三');
    expect(text).toContain('英文名: Zhang San');
    expect(text).toContain('头像: https://example.com/avatar.jpg');
    expect(text).toContain('部门 ID: dep_001, dep_002');
    expect(text).toContain('职位: 高级工程师');
    expect(text).toContain('城市: 上海');
    expect(text).toContain('工号: EMP001');
    expect(text).toContain('open_id: ou_test123');
    expect(text).toContain('union_id: on_union456');
    expect(text).toContain('user_id: uid789');
  });

  it('should handle minimal user info (only name)', async () => {
    mockContactUserGet.mockResolvedValue({
      code: 0,
      data: {
        user: {
          name: '李四',
          open_id: 'ou_minimal',
        },
      },
    });

    const result = await capturedHandler({ action: 'get_user', open_id: 'ou_minimal' }) as any;
    const text = result.content[0].text;

    expect(text).toContain('姓名: 李四');
    expect(text).toContain('open_id: ou_minimal');
    expect(text).not.toContain('英文名');
    expect(text).not.toContain('职位');
    expect(text).not.toContain('城市');
  });

  it('should return error on non-zero API code', async () => {
    mockContactUserGet.mockResolvedValue({
      code: 40003,
      msg: 'no permission',
    });

    const result = await capturedHandler({ action: 'get_user', open_id: 'ou_noperm' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('查询失败 (code 40003)');
    expect(result.content[0].text).toContain('no permission');
  });

  it('should return error when user not found in response', async () => {
    mockContactUserGet.mockResolvedValue({
      code: 0,
      data: { user: undefined },
    });

    const result = await capturedHandler({ action: 'get_user', open_id: 'ou_notfound' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('未找到用户: ou_notfound');
  });

  it('should return error on API exception', async () => {
    mockContactUserGet.mockRejectedValue(new Error('Network timeout'));

    const result = await capturedHandler({ action: 'get_user', open_id: 'ou_err' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('查询用户失败: Network timeout');
  });

  it('should return error for unknown action', async () => {
    const result = await capturedHandler({ action: 'unknown_action' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('未知操作: unknown_action');
  });

  it('should pass correct params to SDK', async () => {
    mockContactUserGet.mockResolvedValue({
      code: 0,
      data: { user: { name: 'Test', open_id: 'ou_sdk_check' } },
    });

    await capturedHandler({ action: 'get_user', open_id: 'ou_sdk_check' });

    expect(mockContactUserGet).toHaveBeenCalledWith({
      path: { user_id: 'ou_sdk_check' },
      params: { user_id_type: 'open_id' },
    });
  });
});
