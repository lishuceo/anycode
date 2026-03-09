import { describe, it, expect } from 'vitest';
import {
  parseInlineMarkdown,
  markdownToBlocks,
  batchBlocks,
  BLOCK_TYPE,
  LANGUAGE_MAP,
} from '../markdown-to-blocks.js';

describe('parseInlineMarkdown', () => {
  it('should parse plain text', () => {
    const result = parseInlineMarkdown('hello world');
    expect(result).toEqual([{ text_run: { content: 'hello world' } }]);
  });

  it('should parse bold text', () => {
    const result = parseInlineMarkdown('this is **bold** text');
    expect(result).toEqual([
      { text_run: { content: 'this is ' } },
      { text_run: { content: 'bold', text_element_style: { bold: true } } },
      { text_run: { content: ' text' } },
    ]);
  });

  it('should parse italic text with *', () => {
    const result = parseInlineMarkdown('this is *italic* text');
    expect(result).toEqual([
      { text_run: { content: 'this is ' } },
      { text_run: { content: 'italic', text_element_style: { italic: true } } },
      { text_run: { content: ' text' } },
    ]);
  });

  it('should parse italic text with _', () => {
    const result = parseInlineMarkdown('this is _italic_ text');
    expect(result).toEqual([
      { text_run: { content: 'this is ' } },
      { text_run: { content: 'italic', text_element_style: { italic: true } } },
      { text_run: { content: ' text' } },
    ]);
  });

  it('should parse bold+italic text', () => {
    const result = parseInlineMarkdown('this is ***bold italic*** text');
    expect(result).toEqual([
      { text_run: { content: 'this is ' } },
      { text_run: { content: 'bold italic', text_element_style: { bold: true, italic: true } } },
      { text_run: { content: ' text' } },
    ]);
  });

  it('should parse inline code', () => {
    const result = parseInlineMarkdown('use `npm install` command');
    expect(result).toEqual([
      { text_run: { content: 'use ' } },
      { text_run: { content: 'npm install', text_element_style: { inline_code: true } } },
      { text_run: { content: ' command' } },
    ]);
  });

  it('should parse strikethrough', () => {
    const result = parseInlineMarkdown('this is ~~deleted~~ text');
    expect(result).toEqual([
      { text_run: { content: 'this is ' } },
      { text_run: { content: 'deleted', text_element_style: { strikethrough: true } } },
      { text_run: { content: ' text' } },
    ]);
  });

  it('should parse http links', () => {
    const result = parseInlineMarkdown('visit [Google](https://google.com) now');
    expect(result).toEqual([
      { text_run: { content: 'visit ' } },
      { text_run: { content: 'Google', text_element_style: { link: { url: 'https://google.com' } } } },
      { text_run: { content: ' now' } },
    ]);
  });

  it('should render non-http links as plain text', () => {
    const result = parseInlineMarkdown('see [file](./readme.md)');
    expect(result).toEqual([
      { text_run: { content: 'see ' } },
      { text_run: { content: 'file' } },
    ]);
  });

  it('should handle empty string', () => {
    const result = parseInlineMarkdown('');
    expect(result).toEqual([{ text_run: { content: '' } }]);
  });
});

describe('markdownToBlocks', () => {
  describe('headings', () => {
    it('should convert h1', () => {
      const blocks = markdownToBlocks('# Title');
      expect(blocks).toEqual([{
        block_type: BLOCK_TYPE.HEADING1,
        heading1: { elements: [{ text_run: { content: 'Title' } }] },
      }]);
    });

    it('should convert h2', () => {
      const blocks = markdownToBlocks('## Subtitle');
      expect(blocks).toEqual([{
        block_type: BLOCK_TYPE.HEADING2,
        heading2: { elements: [{ text_run: { content: 'Subtitle' } }] },
      }]);
    });

    it('should convert h3', () => {
      const blocks = markdownToBlocks('### Section');
      expect(blocks).toEqual([{
        block_type: BLOCK_TYPE.HEADING3,
        heading3: { elements: [{ text_run: { content: 'Section' } }] },
      }]);
    });

    it('should convert h4-h6', () => {
      const blocks = markdownToBlocks('#### H4\n##### H5\n###### H6');
      expect(blocks).toHaveLength(3);
      expect(blocks[0].block_type).toBe(BLOCK_TYPE.HEADING4);
      expect(blocks[1].block_type).toBe(BLOCK_TYPE.HEADING5);
      expect(blocks[2].block_type).toBe(BLOCK_TYPE.HEADING6);
    });

    it('should parse inline formatting within headings', () => {
      const blocks = markdownToBlocks('# **Bold** heading');
      expect(blocks[0]).toEqual({
        block_type: BLOCK_TYPE.HEADING1,
        heading1: {
          elements: [
            { text_run: { content: 'Bold', text_element_style: { bold: true } } },
            { text_run: { content: ' heading' } },
          ],
        },
      });
    });
  });

  describe('bullet list', () => {
    it('should convert bullet items with -', () => {
      const blocks = markdownToBlocks('- item 1\n- item 2');
      expect(blocks).toEqual([
        { block_type: BLOCK_TYPE.BULLET, bullet: { elements: [{ text_run: { content: 'item 1' } }] } },
        { block_type: BLOCK_TYPE.BULLET, bullet: { elements: [{ text_run: { content: 'item 2' } }] } },
      ]);
    });

    it('should convert bullet items with * and +', () => {
      const blocks = markdownToBlocks('* item A\n+ item B');
      expect(blocks).toHaveLength(2);
      expect(blocks[0].block_type).toBe(BLOCK_TYPE.BULLET);
      expect(blocks[1].block_type).toBe(BLOCK_TYPE.BULLET);
    });
  });

  describe('ordered list', () => {
    it('should convert ordered list items', () => {
      const blocks = markdownToBlocks('1. first\n2. second');
      expect(blocks).toEqual([
        { block_type: BLOCK_TYPE.ORDERED, ordered: { elements: [{ text_run: { content: 'first' } }] } },
        { block_type: BLOCK_TYPE.ORDERED, ordered: { elements: [{ text_run: { content: 'second' } }] } },
      ]);
    });

    it('should handle 1) style numbering', () => {
      const blocks = markdownToBlocks('1) first');
      expect(blocks[0].block_type).toBe(BLOCK_TYPE.ORDERED);
    });
  });

  describe('code block', () => {
    it('should convert fenced code block', () => {
      const blocks = markdownToBlocks('```typescript\nconst x = 1;\n```');
      expect(blocks).toEqual([{
        block_type: BLOCK_TYPE.CODE,
        code: {
          elements: [{ text_run: { content: 'const x = 1;' } }],
          language: LANGUAGE_MAP['typescript'],
        },
      }]);
    });

    it('should fallback to plaintext for unknown language', () => {
      const blocks = markdownToBlocks('```unknownlang\nhello\n```');
      expect(blocks[0]).toEqual({
        block_type: BLOCK_TYPE.CODE,
        code: {
          elements: [{ text_run: { content: 'hello' } }],
          language: 1,
        },
      });
    });

    it('should handle code block without language', () => {
      const blocks = markdownToBlocks('```\nline 1\nline 2\n```');
      expect(blocks[0].block_type).toBe(BLOCK_TYPE.CODE);
      expect((blocks[0].code as { language: number }).language).toBe(1);
    });
  });

  describe('todo / checkbox', () => {
    it('should convert unchecked todo', () => {
      const blocks = markdownToBlocks('- [ ] task pending');
      expect(blocks).toEqual([{
        block_type: BLOCK_TYPE.TODO,
        todo: {
          elements: [{ text_run: { content: 'task pending' } }],
          style: { done: false },
        },
      }]);
    });

    it('should convert checked todo', () => {
      const blocks = markdownToBlocks('- [x] task done');
      expect(blocks).toEqual([{
        block_type: BLOCK_TYPE.TODO,
        todo: {
          elements: [{ text_run: { content: 'task done' } }],
          style: { done: true },
        },
      }]);
    });
  });

  describe('divider', () => {
    it('should convert --- to divider', () => {
      const blocks = markdownToBlocks('---');
      expect(blocks).toEqual([{ block_type: BLOCK_TYPE.DIVIDER, divider: {} }]);
    });

    it('should convert *** to divider', () => {
      const blocks = markdownToBlocks('***');
      expect(blocks).toEqual([{ block_type: BLOCK_TYPE.DIVIDER, divider: {} }]);
    });

    it('should convert ___ to divider', () => {
      const blocks = markdownToBlocks('___');
      expect(blocks).toEqual([{ block_type: BLOCK_TYPE.DIVIDER, divider: {} }]);
    });
  });

  describe('blockquote', () => {
    it('should convert blockquote to text block (fallback)', () => {
      const blocks = markdownToBlocks('> quoted text');
      expect(blocks).toEqual([{
        block_type: BLOCK_TYPE.TEXT,
        text: { elements: [{ text_run: { content: 'quoted text' } }] },
      }]);
    });

    it('should merge multi-line blockquote', () => {
      const blocks = markdownToBlocks('> line 1\n> line 2');
      expect(blocks).toHaveLength(1);
      expect(blocks[0].block_type).toBe(BLOCK_TYPE.TEXT);
    });
  });

  describe('table', () => {
    it('should convert table to code block (fallback)', () => {
      const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
      const blocks = markdownToBlocks(md);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].block_type).toBe(BLOCK_TYPE.CODE);
    });
  });

  describe('paragraph', () => {
    it('should convert plain text to text block', () => {
      const blocks = markdownToBlocks('Hello world');
      expect(blocks).toEqual([{
        block_type: BLOCK_TYPE.TEXT,
        text: { elements: [{ text_run: { content: 'Hello world' } }] },
      }]);
    });

    it('should merge continuation lines into one paragraph', () => {
      const blocks = markdownToBlocks('line one\nline two');
      expect(blocks).toHaveLength(1);
      expect(blocks[0].block_type).toBe(BLOCK_TYPE.TEXT);
    });

    it('should split paragraphs on blank line', () => {
      const blocks = markdownToBlocks('para one\n\npara two');
      expect(blocks).toHaveLength(2);
      expect(blocks[0].block_type).toBe(BLOCK_TYPE.TEXT);
      expect(blocks[1].block_type).toBe(BLOCK_TYPE.TEXT);
    });
  });

  describe('mixed content', () => {
    it('should handle a document with various block types', () => {
      const md = [
        '# Title',
        '',
        'Some text with **bold**.',
        '',
        '- item 1',
        '- item 2',
        '',
        '```js',
        'console.log("hi");',
        '```',
        '',
        '---',
        '',
        '1. first',
        '2. second',
      ].join('\n');

      const blocks = markdownToBlocks(md);
      expect(blocks[0].block_type).toBe(BLOCK_TYPE.HEADING1);
      expect(blocks[1].block_type).toBe(BLOCK_TYPE.TEXT);
      expect(blocks[2].block_type).toBe(BLOCK_TYPE.BULLET);
      expect(blocks[3].block_type).toBe(BLOCK_TYPE.BULLET);
      expect(blocks[4].block_type).toBe(BLOCK_TYPE.CODE);
      expect(blocks[5].block_type).toBe(BLOCK_TYPE.DIVIDER);
      expect(blocks[6].block_type).toBe(BLOCK_TYPE.ORDERED);
      expect(blocks[7].block_type).toBe(BLOCK_TYPE.ORDERED);
    });
  });

  describe('empty input', () => {
    it('should return empty array for empty string', () => {
      expect(markdownToBlocks('')).toEqual([]);
    });

    it('should return empty array for whitespace-only', () => {
      expect(markdownToBlocks('  \n\n  ')).toEqual([]);
    });
  });
});

describe('batchBlocks', () => {
  it('should return single batch for small arrays', () => {
    const blocks = [{ block_type: 2 }, { block_type: 2 }];
    expect(batchBlocks(blocks)).toEqual([blocks]);
  });

  it('should split into multiple batches', () => {
    const blocks = Array.from({ length: 120 }, () => ({ block_type: 2 }));
    const batches = batchBlocks(blocks);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(50);
    expect(batches[2]).toHaveLength(20);
  });

  it('should return empty array for empty input', () => {
    expect(batchBlocks([])).toEqual([]);
  });
});
