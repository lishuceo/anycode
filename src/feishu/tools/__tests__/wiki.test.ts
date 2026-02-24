// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockWikiSpaceList = vi.fn();
const mockWikiSpaceNodeList = vi.fn();
const mockWikiSpaceGetNode = vi.fn();
const mockWikiSpaceNodeCreate = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    raw: {
      wiki: {
        space: {
          list: (...args: unknown[]) => mockWikiSpaceList(...args),
          getNode: (...args: unknown[]) => mockWikiSpaceGetNode(...args),
        },
        spaceNode: {
          list: (...args: unknown[]) => mockWikiSpaceNodeList(...args),
          create: (...args: unknown[]) => mockWikiSpaceNodeCreate(...args),
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

import { feishuWikiTool } from '../wiki.js';

beforeEach(() => {
  vi.clearAllMocks();
  feishuWikiTool();
});

describe('feishu_wiki tool', () => {
  describe('list_spaces', () => {
    it('should return space list', async () => {
      mockWikiSpaceList.mockResolvedValue({
        code: 0,
        data: { items: [{ space_id: 's1', name: 'Wiki 1' }] },
      });
      const result = await capturedHandler({ action: 'list_spaces' });
      expect(result.content[0].text).toContain('s1');
    });

    it('should handle API error', async () => {
      mockWikiSpaceList.mockResolvedValue({ code: 99999, msg: 'forbidden' });
      const result = await capturedHandler({ action: 'list_spaces' });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_nodes', () => {
    it('should return nodes', async () => {
      mockWikiSpaceNodeList.mockResolvedValue({
        code: 0,
        data: { items: [{ node_token: 'n1', title: 'Page 1' }] },
      });
      const result = await capturedHandler({ action: 'list_nodes', space_id: 'SP1' });
      expect(result.content[0].text).toContain('n1');
    });

    it('should require space_id', async () => {
      const result = await capturedHandler({ action: 'list_nodes' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('space_id');
    });
  });

  describe('get_node', () => {
    it('should return node details', async () => {
      mockWikiSpaceGetNode.mockResolvedValue({
        code: 0,
        data: { node: { node_token: 'n1', title: 'Page 1' } },
      });
      const result = await capturedHandler({
        action: 'get_node', space_id: 'SP1', node_token: 'NT1',
      });
      expect(result.content[0].text).toContain('n1');
    });

    it('should require space_id and node_token', async () => {
      const result = await capturedHandler({ action: 'get_node' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('space_id');
    });
  });

  describe('create_node', () => {
    it('should create a node', async () => {
      mockWikiSpaceNodeCreate.mockResolvedValue({
        code: 0,
        data: { node: { node_token: 'NEW_NT' } },
      });
      const result = await capturedHandler({
        action: 'create_node', space_id: 'SP1', title: '新页面',
      });
      expect(result.content[0].text).toContain('NEW_NT');
    });

    it('should require title', async () => {
      const result = await capturedHandler({ action: 'create_node', space_id: 'SP1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('title');
    });
  });

  describe('token validation', () => {
    it('should reject invalid space_id', async () => {
      const result = await capturedHandler({ action: 'list_nodes', space_id: '../xx' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('无效的 space_id');
    });
  });
});
