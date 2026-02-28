import { describe, it, expect } from 'vitest';
import { serializeCard } from '../client.js';

describe('serializeCard', () => {
  it('should escape ${...} patterns in card content', () => {
    const card = {
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content: 'code: `routing:${chatId}:${userId}`' },
      }],
    };
    const result = serializeCard(card);
    // Should not contain bare ${ which Feishu interprets as template variables
    expect(result).not.toContain('${');
    // Should contain the zero-width space escaped version
    expect(result).toContain('$\u200B{chatId}');
    expect(result).toContain('$\u200B{userId}');
  });

  it('should preserve valid JSON structure', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'hello ${world}' } }],
    };
    const result = serializeCard(card);
    // The result should be parseable JSON
    const parsed = JSON.parse(result);
    expect(parsed.header.title.content).toBe('Test');
    // Content should have zero-width space inserted
    expect(parsed.elements[0].text.content).toBe('hello $\u200B{world}');
  });

  it('should not modify content without ${...} patterns', () => {
    const card = {
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'normal text $100' } }],
    };
    const result = serializeCard(card);
    const parsed = JSON.parse(result);
    expect(parsed.elements[0].text.content).toBe('normal text $100');
  });

  it('should handle multiple ${...} patterns in one string', () => {
    const card = {
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content: '`${a}` and `${b}` and `${c}`' },
      }],
    };
    const result = serializeCard(card);
    expect(result).not.toContain('${');
    const parsed = JSON.parse(result);
    expect(parsed.elements[0].text.content).toContain('$\u200B{a}');
    expect(parsed.elements[0].text.content).toContain('$\u200B{b}');
    expect(parsed.elements[0].text.content).toContain('$\u200B{c}');
  });

  it('should handle empty card', () => {
    expect(serializeCard({})).toBe('{}');
  });

  it('should handle nested objects with ${...} patterns', () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🤖 Claude Code' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: 'line 1' } },
        { tag: 'div', text: { tag: 'lark_md', content: 'const key = `${prefix}:${suffix}`' } },
      ],
    };
    const result = serializeCard(card);
    expect(result).not.toContain('${');
    const parsed = JSON.parse(result);
    expect(parsed.elements[0].text.content).toBe('line 1');
    expect(parsed.elements[1].text.content).toContain('$\u200B{prefix}');
  });
});
