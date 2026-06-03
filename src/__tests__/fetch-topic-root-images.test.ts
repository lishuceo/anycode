/**
 * Tests for fetchTopicRootImages — separately fetched topic-root multimodal images.
 *
 * 覆盖:
 * - msg_type='image' / msg_type='post' 解析
 * - LRU 缓存命中重排 + 上限淘汰
 * - 失败/空 / 删除等场景写哨兵, 避免每轮 resume 重复打 API
 * - imageKeys 截长防御 (MAX_HISTORY_IMAGES)
 */
// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetMessageById = vi.fn();
const mockDownloadMessageImage = vi.fn();
const mockSaveMessageFileToCache = vi.fn();

vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    getMessageById: (...args: unknown[]) => mockGetMessageById(...args),
    downloadMessageImage: (...args: unknown[]) => mockDownloadMessageImage(...args),
  },
}));

vi.mock('../feishu/file-cache.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    saveMessageFileToCache: (...args: unknown[]) => mockSaveMessageFileToCache(...args),
  };
});

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

import {
  _testFetchTopicRootImages as fetchTopicRootImages,
  _testClearTopicRootCache as clearCache,
} from '../feishu/event-handler.js';

const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const imageBuf = () => Buffer.concat([JPEG_PREFIX, Buffer.from('fake')]);

describe('fetchTopicRootImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    mockDownloadMessageImage.mockResolvedValue(imageBuf());
    mockSaveMessageFileToCache.mockImplementation(async (msgId, key) =>
      `/tmp/cache/${msgId}-${key}.jpg`,
    );
  });

  it('extracts image_key from msg_type=image root', async () => {
    mockGetMessageById.mockResolvedValue([
      {
        message_id: 'root1',
        msg_type: 'image',
        body: { content: '{"image_key":"ik_root"}' },
      },
    ]);

    const res = await fetchTopicRootImages('root1');
    expect(res.rootMessageId).toBe('root1');
    expect(res.images).toHaveLength(1);
    expect(res.images[0].label).toBe('话题首条消息的图片');
    expect(res.savedPaths).toEqual(['/tmp/cache/root1-ik_root.jpg']);
    expect(mockDownloadMessageImage).toHaveBeenCalledWith('root1', 'ik_root');
  });

  it('extracts img tags from msg_type=post root', async () => {
    const postContent = JSON.stringify({
      zh_cn: {
        title: 'hi',
        content: [
          [{ tag: 'text', text: 'before' }, { tag: 'img', image_key: 'ik_a' }],
          [{ tag: 'img', image_key: 'ik_b' }, { tag: 'text', text: 'after' }],
        ],
      },
    });
    mockGetMessageById.mockResolvedValue([
      { message_id: 'root2', msg_type: 'post', body: { content: postContent } },
    ]);

    const res = await fetchTopicRootImages('root2');
    expect(res.images).toHaveLength(2);
    expect(mockDownloadMessageImage).toHaveBeenCalledWith('root2', 'ik_a');
    expect(mockDownloadMessageImage).toHaveBeenCalledWith('root2', 'ik_b');
  });

  it('caps imageKeys at MAX_HISTORY_IMAGES (5)', async () => {
    // post 含 7 张图,只取前 5
    const content = [
      [{ tag: 'img', image_key: 'k1' }, { tag: 'img', image_key: 'k2' }],
      [{ tag: 'img', image_key: 'k3' }, { tag: 'img', image_key: 'k4' }],
      [{ tag: 'img', image_key: 'k5' }, { tag: 'img', image_key: 'k6' }, { tag: 'img', image_key: 'k7' }],
    ];
    mockGetMessageById.mockResolvedValue([
      { message_id: 'r', msg_type: 'post', body: { content: JSON.stringify({ zh_cn: { content } }) } },
    ]);

    const res = await fetchTopicRootImages('r');
    expect(res.images).toHaveLength(5);
    expect(mockDownloadMessageImage).toHaveBeenCalledTimes(5);
  });

  it('skips non-string image_key values defensively', async () => {
    const content = [[
      { tag: 'img', image_key: null },
      { tag: 'img', image_key: 123 },
      { tag: 'img' /* missing */ },
      { tag: 'img', image_key: 'good' },
    ]];
    mockGetMessageById.mockResolvedValue([
      { message_id: 'r', msg_type: 'post', body: { content: JSON.stringify({ content }) } },
    ]);

    const res = await fetchTopicRootImages('r');
    expect(res.images).toHaveLength(1);
    expect(mockDownloadMessageImage).toHaveBeenCalledWith('r', 'good');
  });

  it('caches result and returns it on second call without re-fetching', async () => {
    mockGetMessageById.mockResolvedValue([
      { message_id: 'root1', msg_type: 'image', body: { content: '{"image_key":"ik"}' } },
    ]);

    const first = await fetchTopicRootImages('root1');
    const second = await fetchTopicRootImages('root1');

    expect(mockGetMessageById).toHaveBeenCalledTimes(1);
    expect(mockDownloadMessageImage).toHaveBeenCalledTimes(1);
    expect(second.images).toEqual(first.images);
  });

  it('caches empty sentinel on getMessageById returning empty (negative cache)', async () => {
    mockGetMessageById.mockResolvedValue([]);

    const first = await fetchTopicRootImages('t_empty');
    const second = await fetchTopicRootImages('t_empty');

    expect(first.rootMessageId).toBeUndefined();
    expect(first.images).toHaveLength(0);
    // 关键: 第二次不再 hit Feishu API
    expect(mockGetMessageById).toHaveBeenCalledTimes(1);
    expect(second.images).toHaveLength(0);
  });

  it('caches empty sentinel on getMessageById throwing (transient errors should not hammer API)', async () => {
    mockGetMessageById.mockRejectedValue(new Error('network'));

    const first = await fetchTopicRootImages('t_err');
    const second = await fetchTopicRootImages('t_err');

    expect(first.images).toHaveLength(0);
    expect(mockGetMessageById).toHaveBeenCalledTimes(1);
    expect(second.images).toHaveLength(0);
  });

  it('caches empty result when root message has no images', async () => {
    mockGetMessageById.mockResolvedValue([
      { message_id: 'root_text', msg_type: 'text', body: { content: '{"text":"hi"}' } },
    ]);

    await fetchTopicRootImages('root_text');
    await fetchTopicRootImages('root_text');

    expect(mockGetMessageById).toHaveBeenCalledTimes(1);
  });

  it('handles malformed body content gracefully', async () => {
    mockGetMessageById.mockResolvedValue([
      { message_id: 'r', msg_type: 'image', body: { content: 'not-json' } },
    ]);

    const res = await fetchTopicRootImages('r');
    expect(res.images).toHaveLength(0);
  });

  it('returns partial results when some downloads fail', async () => {
    const content = [[{ tag: 'img', image_key: 'ok' }, { tag: 'img', image_key: 'fail' }]];
    mockGetMessageById.mockResolvedValue([
      { message_id: 'r', msg_type: 'post', body: { content: JSON.stringify({ content }) } },
    ]);
    mockDownloadMessageImage.mockImplementation(async (_msgId, key) => {
      if (key === 'fail') throw new Error('boom');
      return imageBuf();
    });

    const res = await fetchTopicRootImages('r');
    expect(res.images).toHaveLength(1);
    expect(res.savedPaths).toHaveLength(1);
  });
});
