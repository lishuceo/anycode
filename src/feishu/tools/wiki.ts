import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';
import { validateToken } from './validation.js';

/**
 * 飞书知识库 MCP 工具
 *
 * 支持操作: list_spaces / list_nodes / get_node / create_node
 */
export function feishuWikiTool() {
  return tool(
    'feishu_wiki',
    [
      '浏览和管理飞书知识库 (Wiki)。',
      '',
      'Actions:',
      '- list_spaces: 列出可访问的知识库空间',
      '- list_nodes: 列出知识库下的节点',
      '- get_node: 获取节点详情',
      '- create_node: 在知识库中创建节点',
      '',
      'URL Token 提取: /wiki/ABC123 → node_token: ABC123',
    ].join('\n'),
    {
      action: z.enum(['list_spaces', 'list_nodes', 'get_node', 'create_node']).describe('操作类型'),
      space_id: z.string().optional().describe('知识库空间 ID (list_nodes/create_node 时必填)'),
      node_token: z.string().optional().describe('节点 token (get_node 时必填)'),
      title: z.string().optional().describe('新节点标题 (create_node 时必填)'),
      parent_node_token: z.string().optional().describe('父节点 token (list_nodes/create_node 时可选)'),
    },
    async (args) => {
      const client = feishuClient.raw;
      try {
        if (args.space_id) validateToken(args.space_id, 'space_id');
        if (args.node_token) validateToken(args.node_token, 'node_token');
        if (args.parent_node_token) validateToken(args.parent_node_token, 'parent_node_token');

        switch (args.action) {
          case 'list_spaces': {
            const resp = await client.wiki.space.list({
              params: { page_size: 50 },
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data?.items ?? [], null, 2),
              }],
            };
          }

          case 'list_nodes': {
            if (!args.space_id) throw new Error('list_nodes 操作需要 space_id');
            const resp = await client.wiki.spaceNode.list({
              path: { space_id: args.space_id },
              params: {
                parent_node_token: args.parent_node_token,
                page_size: 50,
              },
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data?.items ?? [], null, 2),
              }],
            };
          }

          case 'get_node': {
            if (!args.node_token) throw new Error('get_node 操作需要 node_token');
            const resp = await client.wiki.space.getNode({
              params: { token: args.node_token },
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data?.node ?? {}, null, 2),
              }],
            };
          }

          case 'create_node': {
            if (!args.space_id) throw new Error('create_node 操作需要 space_id');
            if (!args.title) throw new Error('create_node 操作需要 title');
            const resp = await client.wiki.spaceNode.create({
              path: { space_id: args.space_id },
              data: {
                obj_type: 'docx',
                node_type: 'origin',
                title: args.title,
                parent_node_token: args.parent_node_token,
              },
            });
            if (resp.code !== 0) throw new Error(`创建节点失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: `节点已创建\nnode_token: ${resp.data?.node?.node_token ?? '(未知)'}`,
              }],
            };
          }

          default:
            return { content: [{ type: 'text' as const, text: `未知 action: ${args.action}` }], isError: true };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, action: args.action }, 'feishu_wiki tool error');
        return { content: [{ type: 'text' as const, text: `错误: ${msg}` }], isError: true };
      }
    },
  );
}
