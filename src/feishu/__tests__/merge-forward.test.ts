// @ts-nocheck — test file
import { describe, it, expect } from 'vitest';

// formatMergeForwardSubMessage is a pure function — no external deps needed
import { formatMergeForwardSubMessage } from '../event-handler.js';

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
    expect(formatMergeForwardSubMessage('{}', 'share_chat')).toBe('[share_chat消息]');
  });

  it('should handle malformed JSON gracefully', () => {
    expect(formatMergeForwardSubMessage('not json', 'text')).toBe('[text消息 - 解析失败]');
  });

  it('should handle empty content string', () => {
    expect(formatMergeForwardSubMessage('', 'text')).toBe('');
  });
});
