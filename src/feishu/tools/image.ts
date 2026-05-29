import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { saveMessageFileToCache } from '../file-cache.js';
import { logger } from '../../utils/logger.js';

const MAX_IMAGE_SIZE = 30 * 1024 * 1024;

function detectImageExt(buf: Buffer): string {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return '.webp';
  return '.png';
}

/**
 * 飞书消息图片下载 MCP 工具
 *
 * 配合父群图片 lazy loading 与工作区切换后的图片落盘策略，
 * 让 agent 在历史上下文中看到图片提示时按需获取原图。
 */
export function feishuMessageImageTool() {
  return tool(
    'feishu_download_message_image',
    [
      '下载飞书消息中的图片到本地，返回图片路径。',
      '',
      '当聊天历史上下文中出现 [群聊历史图片] 或 [历史聊天图片] 等提示时，',
      '可以使用此工具按需下载该图片。下载后用 Read 工具查看图片内容。',
      '',
      '参数:',
      '- message_id: 消息 ID（从历史上下文元数据中获取）',
      '- image_key: 图片 Key（从历史上下文元数据中获取）',
    ].join('\n'),
    {
      message_id: z.string().describe('飞书消息 ID（如 om_xxx）'),
      image_key: z.string().describe('图片 Key（如 img_v3_xxx）'),
    },
    async (args) => {
      try {
        const buf = await feishuClient.downloadMessageImage(args.message_id, args.image_key);

        if (buf.length > MAX_IMAGE_SIZE) {
          return {
            content: [{
              type: 'text' as const,
              text: `图片过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB)，超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB 限制`,
            }],
            isError: true,
          };
        }

        const ext = detectImageExt(buf);
        const filePath = await saveMessageFileToCache(args.message_id, args.image_key, buf, `image${ext}`);

        logger.info(
          { messageId: args.message_id, imageKey: args.image_key, sizeBytes: buf.length, filePath },
          'Message image downloaded on-demand via MCP tool',
        );

        return {
          content: [{
            type: 'text' as const,
            text: `图片已下载到: ${filePath}\n大小: ${(buf.length / 1024).toFixed(1)}KB\n\n请使用 Read 工具查看该图片。`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, messageId: args.message_id, imageKey: args.image_key }, 'feishu_download_message_image failed');
        return {
          content: [{ type: 'text' as const, text: `下载图片失败: ${msg}` }],
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
