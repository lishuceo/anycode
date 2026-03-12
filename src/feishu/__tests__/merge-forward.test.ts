// @ts-nocheck — test file
import { describe, it, expect } from 'vitest';

// formatMergeForwardSubMessage is a pure function — no external deps needed
import { formatMergeForwardSubMessage } from '../message-parser.js';

describe('formatMergeForwardSubMessage', () => {
  it('should parse text message content', () => {
    const content = JSON.stringify({ text: 'Hello world' });
    expect(formatMergeForwardSubMessage(content, 'text')).toBe('Hello world');
  });

  it('should resolve @mention placeholders in text messages', () => {
    const content = JSON.stringify({ text: '@_user_1 你好 @_user_2 再见' });
    const mentions = [
      { key: '@_user_1', id: 'ou_123', id_type: 'open_id', name: '张三' },
      { key: '@_user_2', id: 'ou_456', id_type: 'open_id', name: '李四' },
    ];
    expect(formatMergeForwardSubMessage(content, 'text', mentions)).toBe('@张三 你好 @李四 再见');
  });

  it('should handle empty text message', () => {
    const content = JSON.stringify({ text: '' });
    expect(formatMergeForwardSubMessage(content, 'text')).toBe('');
  });

  it('should handle text message without text field', () => {
    const content = JSON.stringify({});
    expect(formatMergeForwardSubMessage(content, 'text')).toBe('');
  });

  it('should parse post message with direct content structure', () => {
    const content = JSON.stringify({
      title: '公告',
      content: [
        [{ tag: 'text', text: '第一段 ' }, { tag: 'text', text: '内容' }],
        [{ tag: 'text', text: '第二段' }],
      ],
    });
    // Note: trailing space in '第一段 ' + join with ' ' creates double space — matches real Feishu data
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('公告 第一段  内容 第二段');
  });

  it('should parse post message with locale-wrapped content', () => {
    const content = JSON.stringify({
      zh_cn: {
        title: '标题',
        content: [[{ tag: 'text', text: '中文内容' }]],
      },
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('标题 中文内容');
  });

  it('should parse post message without title', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'text', text: '无标题内容' }]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('无标题内容');
  });

  it('should return placeholder for image message', () => {
    const content = JSON.stringify({ image_key: 'img_xxx' });
    expect(formatMergeForwardSubMessage(content, 'image')).toBe('[图片]');
  });

  it('should return file name for file message', () => {
    const content = JSON.stringify({ file_name: 'report.pdf' });
    expect(formatMergeForwardSubMessage(content, 'file')).toBe('[文件: report.pdf]');
  });

  it('should return placeholder for audio message', () => {
    expect(formatMergeForwardSubMessage('{}', 'audio')).toBe('[语音消息]');
  });

  it('should return placeholder for video message', () => {
    expect(formatMergeForwardSubMessage('{}', 'video')).toBe('[视频]');
  });

  it('should return placeholder for sticker message', () => {
    expect(formatMergeForwardSubMessage('{}', 'sticker')).toBe('[表情]');
  });

  it('should return placeholder for nested merge_forward', () => {
    expect(formatMergeForwardSubMessage('{}', 'merge_forward')).toBe('[嵌套的合并转发消息]');
  });

  it('should return generic placeholder for unknown message types', () => {
    expect(formatMergeForwardSubMessage('{}', 'share_calendar_event')).toBe('[share_calendar_event消息]');
  });

  it('should handle malformed JSON gracefully', () => {
    expect(formatMergeForwardSubMessage('not json', 'text')).toBe('[text消息 - 解析失败]');
  });

  it('should handle empty content string', () => {
    expect(formatMergeForwardSubMessage('', 'text')).toBe('');
  });

  it('should parse post message with link (a tag)', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'a', text: 'Google', href: 'https://google.com' }]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('[Google](https://google.com)');
  });

  it('should parse post message with mixed text and links', () => {
    const content = JSON.stringify({
      title: '分享',
      content: [
        [
          { tag: 'text', text: '看看这个链接 ' },
          { tag: 'a', text: '点击查看', href: 'https://example.com/article' },
          { tag: 'text', text: ' 很有意思' },
        ],
      ],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe(
      '分享 看看这个链接  [点击查看](https://example.com/article)  很有意思',
    );
  });

  it('should parse post with link-only content (no text elements)', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'a', text: '', href: 'https://example.com/page' }]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('https://example.com/page');
  });

  it('should parse post with link that has text but no href', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'a', text: 'some text', href: '' }]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('some text');
  });

  // --- Post element tags: at, img, media, emotion, code_block, md, hr ---

  it('should parse post with @mention (at tag)', () => {
    const content = JSON.stringify({
      content: [[
        { tag: 'text', text: '请看 ' },
        { tag: 'at', user_id: 'ou_123', user_name: '张三' },
        { tag: 'text', text: ' 的方案' },
      ]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('请看  @张三  的方案');
  });

  it('should parse post with inline image (img tag)', () => {
    const content = JSON.stringify({
      content: [[
        { tag: 'text', text: '截图如下 ' },
        { tag: 'img', image_key: 'img_xxx' },
      ]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('截图如下  [图片]');
  });

  it('should parse post with media (video) tag', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'media', file_key: 'file_xxx', image_key: 'img_xxx' }]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('[视频]');
  });

  it('should parse post with emotion tag', () => {
    const content = JSON.stringify({
      content: [[
        { tag: 'text', text: '好的 ' },
        { tag: 'emotion', emoji_type: 'THUMBSUP' },
      ]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('好的  [THUMBSUP]');
  });

  it('should parse post with emotion tag without emoji_type', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'emotion' }]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('[表情]');
  });

  it('should parse post with code_block tag', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'code_block', language: 'typescript', text: 'const x = 1;' }]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('```typescript\nconst x = 1;```');
  });

  it('should parse post with code_block tag without language', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'code_block', text: 'echo hello' }]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('```\necho hello```');
  });

  it('should parse post with md tag', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'md', text: '**bold** and _italic_' }]],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('**bold** and _italic_');
  });

  it('should parse post with hr tag', () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'text', text: '上面的内容' }],
        [{ tag: 'hr' }],
        [{ tag: 'text', text: '下面的内容' }],
      ],
    });
    expect(formatMergeForwardSubMessage(content, 'post')).toBe('上面的内容 --- 下面的内容');
  });

  it('should parse post with all element types mixed', () => {
    const content = JSON.stringify({
      title: '技术分享',
      content: [
        [
          { tag: 'text', text: '请 ' },
          { tag: 'at', user_id: 'ou_123', user_name: '李四' },
          { tag: 'text', text: ' 看看这个 ' },
          { tag: 'a', text: '链接', href: 'https://example.com' },
        ],
        [{ tag: 'img', image_key: 'img_xxx' }],
        [{ tag: 'emotion', emoji_type: 'SMILE' }],
      ],
    });
    const result = formatMergeForwardSubMessage(content, 'post');
    expect(result).toContain('技术分享');
    expect(result).toContain('@李四');
    expect(result).toContain('[链接](https://example.com)');
    expect(result).toContain('[图片]');
    expect(result).toContain('[SMILE]');
  });

  // --- Message type placeholders ---

  it('should return placeholder for media message type', () => {
    expect(formatMergeForwardSubMessage('{}', 'media')).toBe('[视频]');
  });

  it('should return placeholder for interactive (card) message type', () => {
    expect(formatMergeForwardSubMessage('{}', 'interactive')).toBe('[卡片消息]');
  });

  it('should return placeholder for share_chat message type', () => {
    expect(formatMergeForwardSubMessage('{}', 'share_chat')).toBe('[群名片]');
  });

  it('should return placeholder for share_user message type', () => {
    expect(formatMergeForwardSubMessage('{}', 'share_user')).toBe('[个人名片]');
  });

  it('should return placeholder for system message type', () => {
    expect(formatMergeForwardSubMessage('{}', 'system')).toBe('[系统消息]');
  });
});
