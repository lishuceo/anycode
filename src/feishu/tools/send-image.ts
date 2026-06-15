import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createReadStream, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';

// 飞书图片消息上限为 10MB
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * 通过 magic bytes 识别图片类型，返回扩展名；非受支持图片返回 null。
 * 覆盖 agent 常见产物：PNG 截图 / JPG / GIF / WebP / BMP。
 */
function detectImageType(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
  if (
    buf.length >= 4
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
  ) return 'png';
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (
    buf.length >= 12
    && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
  return null;
}

/** 读取文件头部若干字节用于类型识别（避免将整图载入内存）。 */
function readHeader(filePath: string, length = 12): Buffer {
  const buf = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    const bytesRead = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * 飞书图片发送 MCP 工具
 *
 * 让 agent 把工作区里的本地图片文件（截图、生成的图表等）发回当前会话。
 * chatId / threadReplyMsgId 通过闭包绑定：话题内回复到话题，否则发到群/会话。
 *
 * @param chatId            当前会话的 chat_id
 * @param threadReplyMsgId  话题内时传入的话题根消息 ID，使图片回复到话题内
 */
export function feishuSendImageTool(chatId?: string, threadReplyMsgId?: string) {
  return tool(
    'feishu_send_image',
    [
      '把本地图片文件发送到当前飞书会话。',
      '',
      '用于将工作区中生成的图片（截图、图表、渲染结果等）发回给用户。',
      '在话题中工作时图片回复到话题内，否则发送到当前群/会话。',
      '',
      '参数:',
      '- file_path: 图片文件的本地绝对路径（如 /root/dev/.workspaces/xxx/out.png）',
      '',
      '限制: 支持 png/jpg/gif/webp/bmp，大小不超过 10MB。',
    ].join('\n'),
    {
      file_path: z.string().describe('图片文件的本地绝对路径'),
    },
    async (args) => {
      if (!chatId) {
        return {
          content: [{ type: 'text' as const, text: '无法发送图片：当前不在会话中' }],
          isError: true,
        };
      }

      const filePath = resolve(args.file_path);

      if (!existsSync(filePath)) {
        return {
          content: [{ type: 'text' as const, text: `图片文件不存在: ${filePath}（请提供绝对路径）` }],
          isError: true,
        };
      }

      let size: number;
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) {
          return {
            content: [{ type: 'text' as const, text: `不是文件: ${filePath}` }],
            isError: true,
          };
        }
        size = stat.size;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `读取文件失败: ${msg}` }],
          isError: true,
        };
      }

      if (size === 0) {
        return {
          content: [{ type: 'text' as const, text: '图片文件为空' }],
          isError: true,
        };
      }
      if (size > MAX_IMAGE_SIZE) {
        return {
          content: [{
            type: 'text' as const,
            text: `图片过大 (${(size / 1024 / 1024).toFixed(1)}MB)，超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB 限制`,
          }],
          isError: true,
        };
      }

      const imageType = detectImageType(readHeader(filePath));
      if (!imageType) {
        return {
          content: [{
            type: 'text' as const,
            text: '无法识别为受支持的图片格式（png/jpg/gif/webp/bmp）',
          }],
          isError: true,
        };
      }

      try {
        const imageKey = await feishuClient.uploadImage(createReadStream(filePath));
        if (!imageKey) {
          return {
            content: [{ type: 'text' as const, text: '图片上传失败（飞书未返回 image_key）' }],
            isError: true,
          };
        }

        const messageId = threadReplyMsgId
          ? await feishuClient.replyImageInThread(threadReplyMsgId, imageKey)
          : await feishuClient.sendImage(chatId, imageKey);

        if (!messageId) {
          return {
            content: [{ type: 'text' as const, text: '图片发送失败' }],
            isError: true,
          };
        }

        logger.info(
          { chatId, threadReplyMsgId, filePath, imageType, sizeBytes: size, imageKey, messageId },
          'feishu_send_image tool invoked',
        );

        return {
          content: [{
            type: 'text' as const,
            text: `图片已发送到${threadReplyMsgId ? '话题' : '会话'} (${(size / 1024).toFixed(1)}KB)`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, chatId, filePath }, 'feishu_send_image failed');
        return {
          content: [{ type: 'text' as const, text: `发送图片失败: ${msg}` }],
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
