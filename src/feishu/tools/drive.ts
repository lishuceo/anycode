import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';
import { validateToken } from './validation.js';
import { grantOwnerPermission, grantChatMembersPermission } from './permissions.js';

/**
 * 飞书云空间 MCP 工具
 *
 * 支持操作: list / info / create_folder
 */
export function feishuDriveTool(chatId?: string) {
  return tool(
    'feishu_drive',
    [
      '浏览飞书云空间文件和文件夹。',
      '',
      'Actions:',
      '- list: 列出文件夹中的文件 (folder_token 可选，空则列根目录)',
      '- info: 获取文件/文件夹详情',
      '- create_folder: 创建文件夹',
      '',
      'URL Token 提取: /drive/folder/ABC123 → folder_token: ABC123',
    ].join('\n'),
    {
      action: z.enum(['list', 'info', 'create_folder']).describe('操作类型'),
      folder_token: z.string().optional().describe('文件夹 token (list/create_folder 时可选)'),
      file_token: z.string().optional().describe('文件 token (info 时必填)'),
      name: z.string().optional().describe('新文件夹名称 (create_folder 时必填)'),
    },
    async (args) => {
      const client = feishuClient.raw;
      try {
        if (args.folder_token) validateToken(args.folder_token, 'folder_token');
        if (args.file_token) validateToken(args.file_token, 'file_token');

        switch (args.action) {
          case 'list': {
            const params: Record<string, unknown> = { page_size: 50 };
            if (args.folder_token) params.folder_token = args.folder_token;
            const resp = await client.drive.file.listWithIterator({
              params: params as { page_size?: number; folder_token?: string },
            });
            // listWithIterator 返回 async iterator，取第一页即可
            const items: unknown[] = [];
            for await (const page of resp) {
              if (page?.files) items.push(...page.files);
              break; // 只取第一页
            }
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(items, null, 2),
              }],
            };
          }

          case 'info': {
            if (!args.file_token) throw new Error('info 操作需要 file_token');
            // 使用通用 request 方法，因为 drive.file.get 不一定在所有 SDK 版本中可用
            const resp = await client.request<{
              code?: number;
              msg?: string;
              data?: { file?: Record<string, unknown> };
            }>({
              method: 'GET',
              url: `/open-apis/drive/v1/files/${args.file_token}`,
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data?.file ?? {}, null, 2),
              }],
            };
          }

          case 'create_folder': {
            if (!args.name) throw new Error('create_folder 操作需要 name');
            const resp = await client.drive.file.createFolder({
              data: {
                name: args.name!,
                folder_token: args.folder_token ?? '',
              },
            });
            if (resp.code !== 0) throw new Error(`创建文件夹失败 (${resp.code}): ${resp.msg}`);
            if (resp.data?.token) {
              await grantOwnerPermission(resp.data.token, 'folder');
              await grantChatMembersPermission(resp.data.token, 'folder', chatId);
            }
            return {
              content: [{
                type: 'text' as const,
                text: `文件夹已创建\ntoken: ${resp.data?.token ?? '(未知)'}\nurl: ${resp.data?.url ?? '(无)'}`,
              }],
            };
          }

          default:
            return { content: [{ type: 'text' as const, text: `未知 action: ${args.action}` }], isError: true };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, action: args.action }, 'feishu_drive tool error');
        return { content: [{ type: 'text' as const, text: `错误: ${msg}` }], isError: true };
      }
    },
  );
}
