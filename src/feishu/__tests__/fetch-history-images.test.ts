// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMessageList } = vi.hoisted(() => ({
  mockMessageList: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    im = {
      message: {
        list: mockMessageList,
      },
    };
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    feishu: { appId: 'test', appSecret: 'test' },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { FeishuClient } from '../client.js';

describe('fetchRecentMessages - image ref extraction', () => {
  let client: InstanceType<typeof FeishuClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient('test-app', 'test-secret');
  });

  it('should extract imageRefs from standalone image messages', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [{
          message_id: 'msg_img_1',
          msg_type: 'image',
          body: { content: JSON.stringify({ image_key: 'img-key-abc123' }) },
          sender: { id: 'ou_user1', sender_type: 'user' },
          create_time: '1700000000000',
          deleted: false,
        }],
      },
    });

    const messages = await client.fetchRecentMessages('chat_1');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('[图片]');
    expect(messages[0].imageRefs).toEqual([{ imageKey: 'img-key-abc123' }]);
  });

  it('should extract imageRefs from post messages with img tags', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [{
          message_id: 'msg_post_1',
          msg_type: 'post',
          body: {
            content: JSON.stringify({
              zh_cn: {
                title: '带图片的帖子',
                content: [
                  [
                    { tag: 'text', text: '看看这张图' },
                    { tag: 'img', image_key: 'img-key-post1' },
                  ],
                  [
                    { tag: 'img', image_key: 'img-key-post2' },
                  ],
                ],
              },
            }),
          },
          sender: { id: 'ou_user1', sender_type: 'user' },
          create_time: '1700000000000',
          deleted: false,
        }],
      },
    });

    const messages = await client.fetchRecentMessages('chat_1');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('看看这张图');
    expect(messages[0].content).toContain('[图片]');
    expect(messages[0].imageRefs).toEqual([
      { imageKey: 'img-key-post1' },
      { imageKey: 'img-key-post2' },
    ]);
  });

  it('should not include imageRefs for text messages', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [{
          message_id: 'msg_text_1',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '普通文字消息' }) },
          sender: { id: 'ou_user1', sender_type: 'user' },
          create_time: '1700000000000',
          deleted: false,
        }],
      },
    });

    const messages = await client.fetchRecentMessages('chat_1');
    expect(messages).toHaveLength(1);
    expect(messages[0].imageRefs).toBeUndefined();
  });

  it('should handle mixed messages with and without images', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: 'msg_1',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '文字' }) },
            sender: { id: 'ou_user1', sender_type: 'user' },
            create_time: '1700000002000',
            deleted: false,
          },
          {
            message_id: 'msg_2',
            msg_type: 'image',
            body: { content: JSON.stringify({ image_key: 'img-key-1' }) },
            sender: { id: 'ou_user1', sender_type: 'user' },
            create_time: '1700000001000',
            deleted: false,
          },
        ],
      },
    });

    const messages = await client.fetchRecentMessages('chat_1');
    expect(messages).toHaveLength(2);
    // Reversed to chronological order
    expect(messages[0].imageRefs).toEqual([{ imageKey: 'img-key-1' }]);
    expect(messages[1].imageRefs).toBeUndefined();
  });
});
