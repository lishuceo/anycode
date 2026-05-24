// @ts-nocheck — test file
import { describe, it, expect } from 'vitest';
import { extractCardText, extractMessageText } from '../message-text.js';

/**
 * extractCardText 兼容性回归 — 来自原 formatInteractiveCard 的契约。
 *
 * formatInteractiveCard 已被 extractCardText 取代;这些用例确保统一后的解析器
 * 仍覆盖 v1 嵌套 title / v2 body.elements / 第三方 share-card 等历史场景。
 */
describe('extractCardText (compat with legacy formatInteractiveCard)', () => {
  it('extracts header title from plain_text', () => {
    const card = JSON.stringify({
      header: { title: { tag: 'plain_text', content: '🚀 SpaceX 发射通知' } },
      elements: [],
    });
    expect(extractCardText(card)).toContain('SpaceX 发射通知');
  });

  it('extracts header title nested under text.content (v1 form, no tag)', () => {
    const card = JSON.stringify({
      header: { title: { text: { content: '嵌套标题' } } },
    });
    expect(extractCardText(card)).toContain('嵌套标题');
  });

  it('extracts text from div element with lark_md content', () => {
    const card = JSON.stringify({
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '**核心内容**' } },
      ],
    });
    expect(extractCardText(card)).toContain('**核心内容**');
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
    const out = extractCardText(card);
    expect(out).toContain('字段A');
    expect(out).toContain('字段B');
  });

  it('extracts text from note element with nested plain_text', () => {
    const card = JSON.stringify({
      elements: [
        { tag: 'note', elements: [{ tag: 'plain_text', content: '提示文字' }] },
      ],
    });
    expect(extractCardText(card)).toContain('提示文字');
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
    const out = extractCardText(card);
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
    // 统一后不再加 [按钮: ] 前缀,只保留按钮文字
    expect(extractCardText(card)).toContain('查看详情');
  });

  it('supports v2 card with body.elements', () => {
    const card = JSON.stringify({
      header: { title: { content: 'V2 卡片' } },
      body: { elements: [{ tag: 'markdown', content: '正文内容' }] },
    });
    const out = extractCardText(card);
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
    expect(extractCardText(card)).toContain('第三方卡片内容');
  });

  it('extracts direct content/text string on unknown tag (not just nested)', () => {
    const card = JSON.stringify({
      elements: [
        { tag: 'custom_share', content: 'Hello 直接字符串' },
        { tag: 'custom_share2', text: '另一个直接字符串' },
      ],
    });
    const out = extractCardText(card);
    expect(out).toContain('Hello 直接字符串');
    expect(out).toContain('另一个直接字符串');
  });

  it('extractMessageType(interactive) returns "[卡片消息]" for empty card', () => {
    expect(extractMessageText('interactive', '{}').text).toBe('[卡片消息]');
  });

  it('extractMessageType(interactive) returns "[卡片消息]" for invalid JSON', () => {
    expect(extractMessageText('interactive', 'not json').text).toBe('[卡片消息]');
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
    const out = extractCardText(card);
    expect(out).toContain('标题');
    expect(out).toContain('第一段');
    expect(out).toContain('第二段');
  });
});
