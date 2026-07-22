import { describe, it, expect } from 'vitest';
import {
  parseInlineMarkdown,
  markdownToBlocks,
  markdownToSegments,
  parseMarkdownTable,
  buildTableDescendants,
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

describe('parseMarkdownTable', () => {
  it('should parse a GFM table with header separator', () => {
    const table = parseMarkdownTable([
      '| A | B | C |',
      '| --- | --- | --- |',
      '| 1 | 2 | 3 |',
      '| 4 | 5 | 6 |',
    ]);
    expect(table).not.toBeNull();
    expect(table!.hasHeader).toBe(true);
    expect(table!.columnSize).toBe(3);
    expect(table!.rowSize).toBe(3); // header + 2 body rows
    expect(table!.rows[0]).toEqual(['A', 'B', 'C']);
    expect(table!.rows[1]).toEqual(['1', '2', '3']);
    expect(table!.rows[2]).toEqual(['4', '5', '6']);
  });

  it('should recognize alignment separators (:--, --:, :-:)', () => {
    const table = parseMarkdownTable([
      '| L | C | R |',
      '| :-- | :-: | --: |',
      '| a | b | c |',
    ]);
    expect(table).not.toBeNull();
    expect(table!.hasHeader).toBe(true);
    expect(table!.rowSize).toBe(2);
  });

  it('should pad ragged rows to the widest column count', () => {
    const table = parseMarkdownTable([
      '| A | B | C |',
      '| --- | --- | --- |',
      '| 1 | 2 |',
    ]);
    expect(table!.columnSize).toBe(3);
    expect(table!.rows[1]).toEqual(['1', '2', '']);
  });

  it('should treat a table without a separator as headerless', () => {
    const table = parseMarkdownTable([
      '| 1 | 2 |',
      '| 3 | 4 |',
    ]);
    expect(table).not.toBeNull();
    expect(table!.hasHeader).toBe(false);
    expect(table!.rowSize).toBe(2);
    expect(table!.rows[0]).toEqual(['1', '2']);
  });

  it('should return null when there are no data rows', () => {
    expect(parseMarkdownTable(['| --- | --- |'])).toBeNull();
  });
});

describe('markdownToSegments', () => {
  it('should emit a single blocks segment for flat markdown', () => {
    const segments = markdownToSegments('# Title\n\nsome text');
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('blocks');
  });

  it('should split flat content and tables into ordered segments', () => {
    const md = [
      'intro paragraph',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      'outro paragraph',
    ].join('\n');
    const segments = markdownToSegments(md);
    expect(segments.map((s) => s.type)).toEqual(['blocks', 'table', 'blocks']);
    expect(segments[1].type).toBe('table');
    if (segments[1].type === 'table') {
      expect(segments[1].table.columnSize).toBe(2);
      expect(segments[1].table.hasHeader).toBe(true);
    }
  });

  it('should keep two adjacent tables as separate segments', () => {
    const md = [
      '| A |',
      '| --- |',
      '| 1 |',
      '',
      '| B |',
      '| --- |',
      '| 2 |',
    ].join('\n');
    const segments = markdownToSegments(md);
    expect(segments.map((s) => s.type)).toEqual(['table', 'table']);
  });

  it('should fall back to a code block for malformed pipe lines', () => {
    // Only a separator line — not a usable table.
    const segments = markdownToSegments('| --- | --- |');
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('blocks');
    if (segments[0].type === 'blocks') {
      expect(segments[0].blocks[0].block_type).toBe(BLOCK_TYPE.CODE);
    }
  });
});

describe('buildTableDescendants', () => {
  it('should build a native table structure with correct block types', () => {
    const table = parseMarkdownTable([
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ])!;
    const { childrenId, descendants } = buildTableDescendants(table);

    // Top-level attaches exactly the table block.
    expect(childrenId).toHaveLength(1);
    const tableBlock = descendants.find((b) => b.block_id === childrenId[0])!;
    expect(tableBlock.block_type).toBe(BLOCK_TYPE.TABLE);
    expect(tableBlock.table).toEqual({
      property: { row_size: 2, column_size: 2, header_row: true },
    });

    // row_size * column_size cells, each referenced by the table in row-major order.
    const cellIds = tableBlock.children as string[];
    expect(cellIds).toHaveLength(4);
    for (const id of cellIds) {
      const cell = descendants.find((b) => b.block_id === id)!;
      expect(cell.block_type).toBe(BLOCK_TYPE.TABLE_CELL);
      expect((cell.children as string[]).length).toBe(1);
    }

    // Every cell has a text child; descendants total = 1 table + 4 cells + 4 texts.
    expect(descendants).toHaveLength(9);
    const textBlocks = descendants.filter((b) => b.block_type === BLOCK_TYPE.TEXT);
    expect(textBlocks).toHaveLength(4);
  });

  it('should render inline markdown inside cells', () => {
    const table = parseMarkdownTable([
      '| **bold** | plain |',
      '| --- | --- |',
      '| x | y |',
    ])!;
    const { descendants } = buildTableDescendants(table);
    const headerText = descendants.find((b) => b.block_id === 't_0_0')!;
    const elements = (headerText.text as { elements: unknown[] }).elements as Array<{
      text_run: { content: string; text_element_style?: { bold?: boolean } };
    }>;
    expect(elements[0].text_run.content).toBe('bold');
    expect(elements[0].text_run.text_element_style?.bold).toBe(true);
  });

  it('should give empty cells a single empty-content text_run (Feishu rejects empty elements)', () => {
    const table = parseMarkdownTable([
      '| A | B |',
      '| --- | --- |',
      '| 1 | |',
    ])!;
    const { descendants } = buildTableDescendants(table);
    const emptyCellText = descendants.find((b) => b.block_id === 't_1_1')!;
    // Verified against the live Feishu API: `elements: []` returns 1770001 invalid param.
    expect((emptyCellText.text as { elements: unknown[] }).elements).toEqual([
      { text_run: { content: '' } },
    ]);
  });
});

describe('markdownToBlocks (table backward compat)', () => {
  it('should render tables as a plaintext code block in the flat API', () => {
    const blocks = markdownToBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(BLOCK_TYPE.CODE);
    const code = blocks[0].code as { language: number };
    expect(code.language).toBe(1); // plaintext
  });
});
