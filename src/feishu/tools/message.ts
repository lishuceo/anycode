import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';

const DOWNLOAD_DIR = join(tmpdir(), 'feishu-downloads');
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB

/**
 * 飞书消息文件下载 MCP 工具
 *
 * 允许 agent 按需下载飞书消息中的文件附件。
 * 典型场景：历史上下文中提示存在某个文件（lazy loading 元数据），agent 判断需要查看后调用此工具获取。
 */
export function feishuMessageFileTool() {
  return tool(
    'feishu_download_message_file',
    [
      '下载飞书消息中的文件附件到本地，返回文件路径。',
      '',
      '当聊天历史上下文中出现 [群聊历史文件: xxx] 的提示时，',
      '可以使用此工具按需下载该文件。下载后用 Read 工具读取文件内容。',
      '',
      '参数:',
      '- message_id: 消息 ID（从历史上下文元数据中获取）',
      '- file_key: 文件 Key（从历史上下文元数据中获取）',
    ].join('\n'),
    {
      message_id: z.string().describe('飞书消息 ID（如 om_xxx）'),
      file_key: z.string().describe('文件 Key（如 file_xxx）'),
    },
    async (args) => {
      try {
        const buf = await feishuClient.downloadMessageFile(args.message_id, args.file_key);

        if (buf.length > MAX_FILE_SIZE) {
          return {
            content: [{ type: 'text' as const, text: `文件过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB)，超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 限制` }],
            isError: true,
          };
        }

        // 确保下载目录存在
        await mkdir(DOWNLOAD_DIR, { recursive: true });

        // 文件名：messageId-fileKey 避免冲突
        const safeFileName = `${args.message_id}-${args.file_key}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filePath = join(DOWNLOAD_DIR, safeFileName);
        await writeFile(filePath, buf);

        logger.info(
          { messageId: args.message_id, fileKey: args.file_key, sizeBytes: buf.length, filePath },
          'Message file downloaded on-demand via MCP tool',
        );

        return {
          content: [{
            type: 'text' as const,
            text: `文件已下载到: ${filePath}\n大小: ${(buf.length / 1024).toFixed(1)}KB\n\n请使用 Read 工具读取该文件。`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, messageId: args.message_id, fileKey: args.file_key }, 'feishu_download_message_file failed');
        return {
          content: [{ type: 'text' as const, text: `下载文件失败: ${msg}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
  );
}
