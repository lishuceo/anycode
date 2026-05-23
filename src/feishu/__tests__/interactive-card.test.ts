// @ts-nocheck — test file
import { describe, it, expect } from 'vitest';
import { formatInteractiveCard } from '../message-parser.js';

describe('formatInteractiveCard', () => {
  it('extracts header title from plain_text', () => {
    const card = JSON.stringify({
      header: { title: { tag: 'plain_text', content: '🚀 SpaceX 发射通知' } },
      elements: [],
    });
    expect(formatInteractiveCard(card)).toContain('SpaceX 发射通知');
  });

  it('extracts header title nested under text.content', () => {
    const card = JSON.stringify({
      header: { title: { text: { content: '嵌套标题' } } },
    });
    expect(formatInteractiveCard(card)).toContain('嵌套标题');
  });

  it('extracts text from div element with lark_md content', () => {
    const card = JSON.stringify({
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '**核心内容**' } },
      ],
    });
    expect(formatInteractiveCard(card)).toContain('**核心内容**');
  });

  it('extracts text from div fields array', () => {
    const card = JSON.stringify({
      elements: [
        {
          tag: 'div',
          fields: [
            { is_short: true, text: { tag: 'lark_md', content: '字段A' } },
            { is_short: true, text: { tag: 'lark_md', content: '字段B' } },
          ],
        },
      ],
    });
    const out = formatInteractiveCard(card);
    expect(out).toContain('字段A');
    expect(out).toContain('字段B');
  });

  it('extracts text from note element with nested plain_text', () => {
    const card = JSON.stringify({
      elements: [
        { tag: 'note', elements: [{ tag: 'plain_text', content: '提示文字' }] },
      ],
    });
    expect(formatInteractiveCard(card)).toContain('提示文字');
  });

  it('extracts text from column_set with nested columns', () => {
    const card = JSON.stringify({
      elements: [
        {
          tag: 'column_set',
          columns: [
            { elements: [{ tag: 'markdown', content: '左列' }] },
            { elements: [{ tag: 'markdown', content: '右列' }] },
          ],
        },
      ],
    });
    const out = formatInteractiveCard(card);
    expect(out).toContain('左列');
    expect(out).toContain('右列');
  });

  it('extracts button text from action element', () => {
    const card = JSON.stringify({
      elements: [
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '查看详情' } },
          ],
        },
      ],
    });
    expect(formatInteractiveCard(card)).toContain('[按钮: 查看详情]');
  });

  it('supports v2 card with body.elements', () => {
    const card = JSON.stringify({
      header: { title: { content: 'V2 卡片' } },
      body: { elements: [{ tag: 'markdown', content: '正文内容' }] },
    });
    const out = formatInteractiveCard(card);
    expect(out).toContain('V2 卡片');
    expect(out).toContain('正文内容');
  });

  it('falls back to recursive content extraction for unknown element tags', () => {
    const card = JSON.stringify({
      elements: [
        {
          tag: 'unknown_share_card',
          some_field: { content: '第三方卡片内容' },
        },
      ],
    });
    expect(formatInteractiveCard(card)).toContain('第三方卡片内容');
  });

  it('returns placeholder for empty card', () => {
    expect(formatInteractiveCard('{}')).toBe('[卡片消息]');
  });

  it('returns parse-failed placeholder for invalid JSON', () => {
    expect(formatInteractiveCard('not json')).toBe('[卡片消息 - 解析失败]');
  });

  it('combines header + multiple elements into multi-line output', () => {
    const card = JSON.stringify({
      header: { title: { content: '标题' } },
      elements: [
        { tag: 'div', text: { content: '第一段' } },
        { tag: 'hr' },
        { tag: 'div', text: { content: '第二段' } },
      ],
    });
    const out = formatInteractiveCard(card);
    expect(out).toContain('标题');
    expect(out).toContain('第一段');
    expect(out).toContain('第二段');
  });
});
