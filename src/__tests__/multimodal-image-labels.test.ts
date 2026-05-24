/**
 * Tests for buildMultimodalPrompt label injection.
 *
 * 验证标签机制:有 label 的图片在 content block 序列中前置一个文本块说明来源,
 * 防止 agent 混淆"用户当前消息的图片" / "话题首条" / "引用消息" 等不同图片来源。
 */
// @ts-nocheck — test file

import { describe, it, expect, vi } from 'vitest';

// 屏蔽重型模块:executor.ts 顶层会 import MCP server / memory / cron 等,
// 测试 buildMultimodalPrompt 这个纯函数时无需真实初始化。
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../workspace/tool.js', () => ({ createWorkspaceMcpServer: vi.fn() }));
vi.mock('../feishu/tools/index.js', () => ({ createFeishuToolsMcpServer: vi.fn() }));
vi.mock('../memory/tools/memory-search.js', () => ({ createMemorySearchMcpServer: vi.fn() }));
vi.mock('../memory/init.js', () => ({
  getMemoryStore: vi.fn(),
  getHybridSearch: vi.fn(),
  isMemoryEnabled: () => false,
}));
vi.mock('../cron/tool.js', () => ({ createCronMcpServer: vi.fn() }));
vi.mock('../cron/init.js', () => ({ getCronScheduler: vi.fn() }));
vi.mock('../feishu/client.js', () => ({
  feishuClientContext: { getStore: () => undefined },
}));
vi.mock('../workspace/isolation.js', () => ({
  isAutoWorkspacePath: vi.fn(),
  isServiceOwnRepo: vi.fn(),
  isInsideSourceRepo: vi.fn(),
}));
vi.mock('../utils/runtime.js', () => ({ detectRuntime: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config.js', () => ({
  config: { claude: { defaultModel: 'claude-opus-4-6' } },
}));

import { _testBuildMultimodalPrompt } from '../claude/executor.js';

async function collectFirstMessage(gen: AsyncIterable<unknown>) {
  for await (const msg of gen) return msg as { message: { content: Array<{ type: string; text?: string; source?: { media_type: string } }> } };
  throw new Error('no message yielded');
}

const IMG_DATA = 'fake-base64';

describe('buildMultimodalPrompt — image labels', () => {
  it('inserts a text block before each labeled image', async () => {
    const images = [
      { data: IMG_DATA, mediaType: 'image/png', label: '用户当前消息的图片' },
      { data: IMG_DATA, mediaType: 'image/jpeg', label: '话题首条消息的图片' },
    ];

    const msg = await collectFirstMessage(_testBuildMultimodalPrompt('hello', images));
    const blocks = msg.message.content;

    // 期望顺序:[label-text, image, label-text, image, main-text]
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toMatchObject({ type: 'text', text: '[图片说明: 用户当前消息的图片]' });
    expect(blocks[1]).toMatchObject({ type: 'image' });
    expect((blocks[1] as any).source.media_type).toBe('image/png');
    expect(blocks[2]).toMatchObject({ type: 'text', text: '[图片说明: 话题首条消息的图片]' });
    expect(blocks[3]).toMatchObject({ type: 'image' });
    expect((blocks[3] as any).source.media_type).toBe('image/jpeg');
    expect(blocks[4]).toMatchObject({ type: 'text', text: 'hello' });
  });

  it('omits the label text block when image has no label', async () => {
    const images = [{ data: IMG_DATA, mediaType: 'image/png' }];
    const msg = await collectFirstMessage(_testBuildMultimodalPrompt('main text', images));
    const blocks = msg.message.content;

    // 期望:[image, main-text],无前置 label 文本块
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'image' });
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'main text' });
  });

  it('mixes labeled and unlabeled images correctly', async () => {
    const images = [
      { data: IMG_DATA, mediaType: 'image/png', label: '用户当前消息的图片' },
      { data: IMG_DATA, mediaType: 'image/jpeg' },
      { data: IMG_DATA, mediaType: 'image/webp', label: '用户引用的消息中的图片' },
    ];

    const msg = await collectFirstMessage(_testBuildMultimodalPrompt('q', images));
    const blocks = msg.message.content;

    expect(blocks).toHaveLength(6);
    expect(blocks[0]).toMatchObject({ type: 'text', text: '[图片说明: 用户当前消息的图片]' });
    expect(blocks[1]).toMatchObject({ type: 'image' });
    expect(blocks[2]).toMatchObject({ type: 'image' }); // 无 label, 不前置
    expect(blocks[3]).toMatchObject({ type: 'text', text: '[图片说明: 用户引用的消息中的图片]' });
    expect(blocks[4]).toMatchObject({ type: 'image' });
    expect(blocks[5]).toMatchObject({ type: 'text', text: 'q' });
  });

  it('keeps documents → images → text ordering with labels', async () => {
    const documents = [{ data: 'pdf-base64', mediaType: 'application/pdf' as const, fileName: 'a.pdf' }];
    const images = [{ data: IMG_DATA, mediaType: 'image/png', label: '用户当前消息的图片' }];

    const msg = await collectFirstMessage(_testBuildMultimodalPrompt('main', images, documents));
    const blocks = msg.message.content;

    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ type: 'document' });
    expect(blocks[1]).toMatchObject({ type: 'text', text: '[图片说明: 用户当前消息的图片]' });
    expect(blocks[2]).toMatchObject({ type: 'image' });
    expect(blocks[3]).toMatchObject({ type: 'text', text: 'main' });
  });

  it('returns just the main text block when no images and no documents', async () => {
    const msg = await collectFirstMessage(_testBuildMultimodalPrompt('only text', []));
    const blocks = msg.message.content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'only text' });
  });
});
