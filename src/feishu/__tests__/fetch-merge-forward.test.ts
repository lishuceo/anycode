// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must be hoisted so vi.mock factory can reference them
const { mockMessageList, mockMessageGet } = vi.hoisted(() => ({
  mockMessageList: vi.fn(),
  mockMessageGet: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    im = {
      message: {
        list: mockMessageList,
        get: mockMessageGet,
      },
    };
  },
}));

// Mock config
vi.mock('../../config.js', () => ({
  config: {
    feishu: { appId: 'test', appSecret: 'test' },
  },
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { FeishuClient } from '../client.js';

describe('fetchRecentMessages - merge_forward expansion', () => {
  let client: InstanceType<typeof FeishuClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient('test-app', 'test-secret');
  });

  it('should expand merge_forward sub-messages using formatMergeForwardSubMessage', async () => {
    // im.message.list returns a merge_forward message
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [{
          message_id: 'msg_forward_1',
          msg_type: 'merge_forward',
          body: { content: JSON.stringify({ message_id_list: ['sub_1', 'sub_2'] }) },
          sender: { id: 'ou_sender', sender_type: 'user' },
          create_time: '1700000000000',
          deleted: false,
        }],
      },
    });

    // im.message.get returns sub-messages
    mockMessageGet.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: 'msg_forward_1',
            msg_type: 'merge_forward',
            body: { content: '{}' },
          },
          {
            message_id: 'sub_1',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '你好' }) },
            sender: { id: 'ou_a', id_type: 'open_id', sender_type: 'user' },
            upper_message_id: 'msg_forward_1',
            create_time: '1700000001000',
          },
          {
            message_id: 'sub_2',
            msg_type: 'image',
            body: { content: JSON.stringify({ image_key: 'img_xxx' }) },
            sender: { id: 'ou_b', id_type: 'open_id', sender_type: 'user' },
            upper_message_id: 'msg_forward_1',
            create_time: '1700000002000',
          },
        ],
      },
    });

    const messages = await client.fetchRecentMessages('chat_1');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('[合并转发的聊天记录]');
    expect(messages[0].content).toContain('- 你好');
    expect(messages[0].content).toContain('- [图片]');
    expect(messages[0].msgType).toBe('merge_forward');
  });

  it('should limit sub-messages to 20 in history context', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [{
          message_id: 'msg_forward_2',
          msg_type: 'merge_forward',
          body: { content: '{}' },
          sender: { id: 'ou_sender', sender_type: 'user' },
          create_time: '1700000000000',
          deleted: false,
        }],
      },
    });

    // Generate 25 sub-messages
    const subItems = [
      { message_id: 'msg_forward_2', msg_type: 'merge_forward', body: { content: '{}' } },
      ...Array.from({ length: 25 }, (_, i) => ({
        message_id: `sub_${i}`,
        msg_type: 'text',
        body: { content: JSON.stringify({ text: `msg ${i}` }) },
        sender: { id: 'ou_a', id_type: 'open_id', sender_type: 'user' },
        upper_message_id: 'msg_forward_2',
        create_time: String(1700000001000 + i),
      })),
    ];

    mockMessageGet.mockResolvedValue({
      code: 0,
      data: { items: subItems },
    });

    const messages = await client.fetchRecentMessages('chat_1');

    expect(messages).toHaveLength(1);
    // Count the "- msg N" lines (should be 20, not 25)
    const lines = messages[0].content.split('\n');
    // First line is header, rest are sub-messages
    expect(lines[0]).toBe('[合并转发的聊天记录]');
    expect(lines.length).toBe(21); // 1 header + 20 sub-messages
  });

  it('should fall back to placeholder when getMessageById returns null', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [{
          message_id: 'msg_forward_3',
          msg_type: 'merge_forward',
          body: { content: '{}' },
          sender: { id: 'ou_sender', sender_type: 'user' },
          create_time: '1700000000000',
          deleted: false,
        }],
      },
    });

    // API returns error
    mockMessageGet.mockResolvedValue({
      code: 99999,
      msg: 'permission denied',
      data: null,
    });

    const messages = await client.fetchRecentMessages('chat_1');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('[合并转发的聊天记录]');
  });

  it('should fall back to placeholder when getMessageById throws', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [{
          message_id: 'msg_forward_4',
          msg_type: 'merge_forward',
          body: { content: '{}' },
          sender: { id: 'ou_sender', sender_type: 'user' },
          create_time: '1700000000000',
          deleted: false,
        }],
      },
    });

    mockMessageGet.mockRejectedValue(new Error('network error'));

    const messages = await client.fetchRecentMessages('chat_1');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('[合并转发的聊天记录]');
  });

  it('should handle @mentions in merge_forward sub-messages', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [{
          message_id: 'msg_forward_5',
          msg_type: 'merge_forward',
          body: { content: '{}' },
          sender: { id: 'ou_sender', sender_type: 'user' },
          create_time: '1700000000000',
          deleted: false,
        }],
      },
    });

    mockMessageGet.mockResolvedValue({
      code: 0,
      data: {
        items: [
          { message_id: 'msg_forward_5', msg_type: 'merge_forward', body: { content: '{}' } },
          {
            message_id: 'sub_m1',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '@_user_1 看这个' }) },
            sender: { id: 'ou_a', id_type: 'open_id', sender_type: 'user' },
            mentions: [{ key: '@_user_1', id: 'ou_123', id_type: 'open_id', name: '张三' }],
            upper_message_id: 'msg_forward_5',
            create_time: '1700000001000',
          },
        ],
      },
    });

    const messages = await client.fetchRecentMessages('chat_1');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('- @张三 看这个');
  });

  it('should handle post messages in merge_forward sub-messages', async () => {
    mockMessageList.mockResolvedValue({
      code: 0,
      data: {
        items: [{
          message_id: 'msg_forward_6',
          msg_type: 'merge_forward',
          body: { content: '{}' },
          sender: { id: 'ou_sender', sender_type: 'user' },
          create_time: '1700000000000',
          deleted: false,
        }],
      },
    });

    mockMessageGet.mockResolvedValue({
      code: 0,
      data: {
        items: [
          { message_id: 'msg_forward_6', msg_type: 'merge_forward', body: { content: '{}' } },
          {
            message_id: 'sub_p1',
            msg_type: 'post',
            body: {
              content: JSON.stringify({
                zh_cn: {
                  title: '公告',
                  content: [[{ tag: 'text', text: '重要通知' }]],
                },
              }),
            },
            sender: { id: 'ou_a', id_type: 'open_id', sender_type: 'user' },
            upper_message_id: 'msg_forward_6',
            create_time: '1700000001000',
          },
        ],
      },
    });

    const messages = await client.fetchRecentMessages('chat_1');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('- 公告 重要通知');
  });
});
