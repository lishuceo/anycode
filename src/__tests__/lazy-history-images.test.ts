/**
 * Tests for lazy loading of parent chat images in history context.
 *
 * 与 lazy-history-files.test.ts 对齐：当 buildChatHistoryContext / buildDirectTaskHistory
 * 从父群补充消息时，父群中的图片附件不应被自动下载并嵌入 prompt。
 * 应仅注入元数据提示（包含 message_id 和 image_key），由 LLM 在需要时
 * 通过 feishu_download_message_image MCP 工具按需加载。
 *
 * 这条防护针对的真实场景：群聊里有人发简历图片 → 别人在话题里 @bot 问另一份简历，
 * 此前 bot 会把所有简历图片一起下载分析，导致候选人信息混淆。
 */
// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDownloadMessageImage = vi.fn();

vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    downloadMessageImage: (...args: unknown[]) => mockDownloadMessageImage(...args),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/image-compress.js', () => ({
  compressImage: vi.fn(),
  compressImageForHistory: vi.fn(async (buf: Buffer, mediaType: string) => ({
    data: buf,
    mediaType,
  })),
}));

import { _testDownloadHistoryImages as downloadHistoryImages } from '../feishu/event-handler.js';

function makeMsg(id: string, imageRefs?: Array<{ imageKey: string }>) {
  return { messageId: id, ...(imageRefs ? { imageRefs } : {}) };
}

// JPEG magic bytes — let detectImageMediaType succeed
const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
function makeImageBuf(payload = 'fake'): Buffer {
  return Buffer.concat([JPEG_PREFIX, Buffer.from(payload)]);
}

describe('downloadHistoryImages with parentMsgCount (lazy loading)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadMessageImage.mockResolvedValue(makeImageBuf());
  });

  it('downloads all images when parentMsgCount is 0 (default)', async () => {
    const messages = [
      makeMsg('m1', [{ imageKey: 'ik1' }]),
      makeMsg('m2', [{ imageKey: 'ik2' }]),
    ];

    const result = await downloadHistoryImages(messages);

    expect(mockDownloadMessageImage).toHaveBeenCalledTimes(2);
    expect(result.images).toHaveLength(2);
    expect(result.lazyHints).toHaveLength(0);
  });

  it('skips parent message images and outputs metadata instead', async () => {
    const messages = [
      // 父群消息（index 0，在 parentMsgCount=1 范围内）— 模拟群里其他人发的简历
      makeMsg('parent_msg_other_resume', [{ imageKey: 'ik_other_resume' }]),
      // 话题消息（index 1，超出 parentMsgCount）— 用户当前关心的简历
      makeMsg('thread_msg_target_resume', [{ imageKey: 'ik_target_resume' }]),
    ];

    const result = await downloadHistoryImages(messages, 1);

    // 仅话题图片被下载
    expect(mockDownloadMessageImage).toHaveBeenCalledTimes(1);
    expect(mockDownloadMessageImage).toHaveBeenCalledWith('thread_msg_target_resume', 'ik_target_resume');

    expect(result.images).toHaveLength(1);

    // 父群图片变成元数据
    expect(result.lazyHints).toHaveLength(1);
    expect(result.lazyHints[0]).toContain('parent_msg_other_resume');
    expect(result.lazyHints[0]).toContain('ik_other_resume');
    expect(result.lazyHints[0]).toContain('feishu_download_message_image');
    expect(result.lazyHints[0]).toContain('未自动加载');
  });

  it('handles parent-only scenario (all images from parent chat)', async () => {
    const messages = [
      makeMsg('p1', [{ imageKey: 'ik1' }]),
      makeMsg('p2', [{ imageKey: 'ik2' }]),
    ];

    const result = await downloadHistoryImages(messages, 2);

    // 全部父群图片都不下载
    expect(mockDownloadMessageImage).not.toHaveBeenCalled();
    expect(result.images).toHaveLength(0);
    expect(result.lazyHints).toHaveLength(2);
  });

  it('handles thread-only scenario (parentMsgCount=0)', async () => {
    const messages = [
      makeMsg('t1', [{ imageKey: 'ik1' }]),
    ];

    const result = await downloadHistoryImages(messages, 0);

    expect(mockDownloadMessageImage).toHaveBeenCalledTimes(1);
    expect(result.images).toHaveLength(1);
    expect(result.lazyHints).toHaveLength(0);
  });

  it('returns empty when no images in messages', async () => {
    const messages = [makeMsg('m1'), makeMsg('m2')];

    const result = await downloadHistoryImages(messages, 1);

    expect(mockDownloadMessageImage).not.toHaveBeenCalled();
    expect(result.images).toHaveLength(0);
    expect(result.lazyHints).toHaveLength(0);
  });

  it('metadata format includes message_id and image_key for tool invocation', async () => {
    const messages = [
      makeMsg('om_abc123', [{ imageKey: 'img_xyz789' }]),
    ];

    const result = await downloadHistoryImages(messages, 1);

    const meta = result.lazyHints[0];
    expect(meta).toContain('message_id="om_abc123"');
    expect(meta).toContain('image_key="img_xyz789"');
  });

  it('handles download failure for thread images gracefully', async () => {
    mockDownloadMessageImage.mockRejectedValue(new Error('network error'));

    const messages = [
      makeMsg('p1', [{ imageKey: 'ik1' }]),
      makeMsg('t1', [{ imageKey: 'ik2' }]),
    ];

    const result = await downloadHistoryImages(messages, 1);

    // 父群图片仍输出元数据
    expect(result.lazyHints).toHaveLength(1);
    expect(result.lazyHints[0]).toContain('p1');
    // 话题图片下载失败，images 为空
    expect(result.images).toHaveLength(0);
  });

  it('multiple imageRefs in one message are tracked separately by source', async () => {
    const messages = [
      makeMsg('parent_msg', [{ imageKey: 'ik_p1' }, { imageKey: 'ik_p2' }]),
      makeMsg('thread_msg', [{ imageKey: 'ik_t1' }]),
    ];

    const result = await downloadHistoryImages(messages, 1);

    // 父群消息的两张图片都成 metadata
    expect(result.lazyHints).toHaveLength(2);
    expect(result.lazyHints[0]).toContain('ik_p1');
    expect(result.lazyHints[1]).toContain('ik_p2');

    // 话题图片正常下载
    expect(mockDownloadMessageImage).toHaveBeenCalledTimes(1);
    expect(mockDownloadMessageImage).toHaveBeenCalledWith('thread_msg', 'ik_t1');
  });
});
