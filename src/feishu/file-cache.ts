import { writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { logger } from '../utils/logger.js';

export const DOWNLOAD_DIR = join(tmpdir(), 'feishu-downloads');

const SAFE_NAME_RE = /[^a-zA-Z0-9_-]/g;

/**
 * 把飞书消息附件落盘到共享缓存目录，返回绝对路径。
 *
 * 用于 lazy-loading 文本类附件：上传后只把路径注入 prompt，让 agent 用 Read 工具按需 offset/limit 读取。
 */
export async function saveMessageFileToCache(
  messageId: string,
  fileKey: string,
  buf: Buffer,
  originalFileName?: string,
): Promise<string> {
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const base = `${messageId}-${fileKey}`.replace(SAFE_NAME_RE, '_');
  const ext = originalFileName ? extname(originalFileName).toLowerCase() : '';
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
  const filePath = join(DOWNLOAD_DIR, base + safeExt);
  await writeFile(filePath, buf);
  return filePath;
}

/**
 * 清理 DOWNLOAD_DIR 中早于 maxAgeMs 的文件。默认 24 小时。
 *
 * 由 index.ts 的周期性 cleanup interval 调用，硬盘充裕，给 agent 留足回头读的窗口。
 */
export async function cleanupOldDownloads(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  let cleaned = 0;
  let entries: string[];
  try {
    entries = await readdir(DOWNLOAD_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    logger.warn({ err }, 'cleanupOldDownloads: readdir failed');
    return 0;
  }

  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(entries.map(async (name) => {
    const filePath = join(DOWNLOAD_DIR, name);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) return;
      if (st.mtimeMs < cutoff) {
        await unlink(filePath);
        cleaned += 1;
      }
    } catch (err) {
      logger.debug({ err, filePath }, 'cleanupOldDownloads: stat/unlink failed');
    }
  }));

  if (cleaned > 0) logger.info({ cleaned, maxAgeMs }, 'Old feishu-downloads cleaned');
  return cleaned;
}
