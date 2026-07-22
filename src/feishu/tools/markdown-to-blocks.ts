/**
 * Markdown → Feishu Document Blocks converter
 *
 * Converts standard markdown into an array of Feishu document block structures
 * that can be inserted via `documentBlockChildren.create`.
 */

// --- Feishu block type constants ---
export const BLOCK_TYPE = {
  PAGE: 1,
  TEXT: 2,
  HEADING1: 3,
  HEADING2: 4,
  HEADING3: 5,
  HEADING4: 6,
  HEADING5: 7,
  HEADING6: 8,
  HEADING7: 9,
  HEADING8: 10,
  HEADING9: 11,
  BULLET: 12,
  ORDERED: 13,
  CODE: 14,
  QUOTE: 15,
  TODO: 17,
  DIVIDER: 22,
  TABLE: 31,
  TABLE_CELL: 32,
} as const;

// Map language names to Feishu's language enum values
export const LANGUAGE_MAP: Record<string, number> = {
  plaintext: 1, abap: 2, ada: 3, apache: 4, apex: 5,
  assembly: 6, bash: 7, shell: 7, sh: 7, csharp: 8, 'c#': 8, cs: 8,
  'c++': 9, cpp: 9, c: 10, cobol: 11, css: 12, coffeescript: 13,
  d: 14, dart: 15, delphi: 16, django: 17, dockerfile: 18,
  erlang: 19, fortran: 20, foxpro: 21, go: 22, groovy: 23,
  html: 24, htmlbars: 25, http: 26, haskell: 27, json: 28,
  java: 29, javascript: 30, js: 30, julia: 31, kotlin: 32,
  latex: 33, lisp: 34, lua: 36, matlab: 38, makefile: 39,
  markdown: 40, md: 40, nginx: 41, 'objective-c': 42, objc: 42,
  openedgeabl: 43, perl: 44, php: 45, powershell: 47, prolog: 48,
  protobuf: 49, python: 50, py: 50, r: 51, rpg: 52, ruby: 53, rb: 53,
  rust: 54, rs: 54, sas: 55, scss: 56, sql: 57, scala: 58,
  scheme: 59, smalltalk: 60, swift: 61, thrift: 62, typescript: 63,
  ts: 63, tsx: 63, jsx: 30, vbscript: 64, vbnet: 65, xml: 66,
  yaml: 67, yml: 67, cmake: 68, diff: 69, gams: 70,
  less: 72, pascal: 73, stata: 76, toml: 80,
};

// Feishu API limits text_run content to ~2000 bytes. Split at line boundaries.
const MAX_TEXT_RUN_CHARS = 500;

function splitLongContent(content: string): string[] {
  if (content.length <= MAX_TEXT_RUN_CHARS) return [content];
  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > MAX_TEXT_RUN_CHARS && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface TextElement {
  text_run?: {
    content: string;
    text_element_style?: {
      bold?: boolean;
      italic?: boolean;
      strikethrough?: boolean;
      inline_code?: boolean;
      link?: { url: string };
    };
  };
}

export interface FeishuBlock {
  block_type: number;
  [key: string]: unknown;
}

/** Parse inline Markdown formatting into Feishu TextElement array. */
export function parseInlineMarkdown(text: string): TextElement[] {
  const elements: TextElement[] = [];
  // Regex for inline formatting: inline code, links, bold+italic, bold, italic (*/_ variants), strikethrough
  const regex = /(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*\*([^*]+)\*\*\*)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)|(~~([^~]+)~~)/g;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push({ text_run: { content: text.slice(lastIndex, match.index) } });
    }

    if (match[1]) {
      // Inline code: `code`
      elements.push({
        text_run: {
          content: match[1].slice(1, -1),
          text_element_style: { inline_code: true },
        },
      });
    } else if (match[2]) {
      // Link: [text](url)
      const rawUrl = match[4];
      if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        elements.push({
          text_run: {
            content: match[3],
            text_element_style: { link: { url: rawUrl } },
          },
        });
      } else {
        elements.push({ text_run: { content: match[3] } });
      }
    } else if (match[5]) {
      // Bold+italic: ***text***
      elements.push({
        text_run: {
          content: match[6],
          text_element_style: { bold: true, italic: true },
        },
      });
    } else if (match[7]) {
      // Bold: **text**
      elements.push({
        text_run: {
          content: match[8],
          text_element_style: { bold: true },
        },
      });
    } else if (match[9]) {
      // Italic: *text*
      elements.push({
        text_run: {
          content: match[10],
          text_element_style: { italic: true },
        },
      });
    } else if (match[11]) {
      // Italic alt: _text_
      elements.push({
        text_run: {
          content: match[12],
          text_element_style: { italic: true },
        },
      });
    } else if (match[13]) {
      // Strikethrough: ~~text~~
      elements.push({
        text_run: {
          content: match[14],
          text_element_style: { strikethrough: true },
        },
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    elements.push({ text_run: { content: text.slice(lastIndex) } });
  }

  if (elements.length === 0) {
    elements.push({ text_run: { content: text } });
  }

  return elements;
}

/** A parsed Markdown table, normalized so every row has `columnSize` cells. */
export interface TableData {
  /** Cell text in row-major order; row 0 is the header when `hasHeader` is true. */
  rows: string[][];
  rowSize: number;
  columnSize: number;
  hasHeader: boolean;
}

/** A converted Markdown segment: either a run of flat blocks or a native table. */
export type MarkdownSegment =
  | { type: 'blocks'; blocks: FeishuBlock[] }
  | { type: 'table'; table: TableData };

/** Split a single Markdown table row into trimmed cell strings. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** A separator row looks like |---|:--:|--:| — dashes with optional leading/trailing colons. */
function isTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '')));
}

/**
 * Parse collected Markdown table lines into normalized {@link TableData}.
 * Returns null if the lines don't form a usable table.
 */
export function parseMarkdownTable(tableLines: string[]): TableData | null {
  const rawRows = tableLines.map(splitTableRow);
  let hasHeader = false;
  let dataRows: string[][];

  // GFM tables put the alignment separator on the second line.
  if (rawRows.length >= 2 && isTableSeparator(rawRows[1])) {
    hasHeader = true;
    dataRows = [rawRows[0], ...rawRows.slice(2)];
  } else {
    dataRows = rawRows.filter((r) => !isTableSeparator(r));
  }

  // Drop fully-empty rows (e.g. produced by a trailing pipe-only line).
  dataRows = dataRows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (dataRows.length === 0) return null;

  const columnSize = Math.max(...dataRows.map((r) => r.length));
  if (columnSize === 0) return null;

  const rows = dataRows.map((r) => {
    const cells = r.slice(0, columnSize);
    while (cells.length < columnSize) cells.push('');
    return cells;
  });

  return { rows, rowSize: rows.length, columnSize, hasHeader };
}

/** Render raw table lines as a plaintext code block (fallback for the flat-block API). */
function tableToCodeBlock(tableLines: string[]): FeishuBlock {
  const chunks = splitLongContent(tableLines.join('\n'));
  return {
    block_type: BLOCK_TYPE.CODE,
    code: {
      elements: chunks.map((c) => ({ text_run: { content: c } })),
      language: 1, // plaintext
    },
  };
}

/**
 * Convert Markdown into ordered segments. Flat blocks (headings, lists, text…) are
 * grouped together; each Markdown table becomes its own `table` segment so callers
 * can render it as a native Feishu table via `documentBlockDescendant.create`.
 */
export function markdownToSegments(markdown: string): MarkdownSegment[] {
  const lines = markdown.split('\n');
  const segments: MarkdownSegment[] = [];
  let flat: FeishuBlock[] = [];
  let i = 0;

  const flushFlat = () => {
    if (flat.length > 0) {
      segments.push({ type: 'blocks', blocks: flat });
      flat = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // --- Code block ---
    const codeMatch = line.match(/^```(\w*)/);
    if (codeMatch) {
      const lang = codeMatch[1].toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ``` only if found
      const content = codeLines.join('\n');
      const chunks = splitLongContent(content);
      flat.push({
        block_type: BLOCK_TYPE.CODE,
        code: {
          elements: chunks.map((c) => ({ text_run: { content: c } })),
          language: LANGUAGE_MAP[lang] || 1,
        },
      });
      continue;
    }

    // --- Table → its own segment (native Feishu table) ---
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const table = parseMarkdownTable(tableLines);
      if (table) {
        flushFlat();
        segments.push({ type: 'table', table });
      } else {
        // Not a usable table — preserve old behavior (plaintext code block).
        flat.push(tableToCodeBlock(tableLines));
      }
      continue;
    }

    // --- Heading ---
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const blockType = BLOCK_TYPE.HEADING1 + level - 1;
      const key = `heading${level}`;
      flat.push({
        block_type: blockType,
        [key]: { elements: parseInlineMarkdown(text) },
      });
      i++;
      continue;
    }

    // --- Horizontal rule ---
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flat.push({ block_type: BLOCK_TYPE.DIVIDER, divider: {} });
      i++;
      continue;
    }

    // --- Checkbox / todo ---
    const todoMatch = line.match(/^(\s*)-\s+\[([ xX])\]\s+(.*)/);
    if (todoMatch) {
      const done = todoMatch[2].toLowerCase() === 'x';
      const text = todoMatch[3].trim();
      flat.push({
        block_type: BLOCK_TYPE.TODO,
        todo: {
          elements: parseInlineMarkdown(text),
          style: { done },
        },
      });
      i++;
      continue;
    }

    // --- Unordered list ---
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (bulletMatch) {
      const text = bulletMatch[2].trim();
      flat.push({
        block_type: BLOCK_TYPE.BULLET,
        bullet: { elements: parseInlineMarkdown(text) },
      });
      i++;
      continue;
    }

    // --- Ordered list ---
    const orderedMatch = line.match(/^(\s*)\d+[.)]\s+(.*)/);
    if (orderedMatch) {
      const text = orderedMatch[2].trim();
      flat.push({
        block_type: BLOCK_TYPE.ORDERED,
        ordered: { elements: parseInlineMarkdown(text) },
      });
      i++;
      continue;
    }

    // --- Blockquote (fallback to text since Feishu quote_container requires two-step creation) ---
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const quoteText = quoteLines.join('\n').trim();
      flat.push({
        block_type: BLOCK_TYPE.TEXT,
        text: { elements: parseInlineMarkdown(quoteText) },
      });
      continue;
    }

    // --- Empty line (skip) ---
    if (line.trim() === '') {
      i++;
      continue;
    }

    // --- Regular paragraph ---
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (
        next.trim() === '' ||
        next.match(/^#{1,6}\s/) ||
        next.match(/^[-*+]\s/) ||
        next.match(/^\d+[.)]\s/) ||
        next.startsWith('>') ||
        next.startsWith('```') ||
        /^(-{3,}|\*{3,}|_{3,})\s*$/.test(next) ||
        (next.includes('|') && next.trim().startsWith('|'))
      ) {
        break;
      }
      paraLines.push(next);
      i++;
    }
    const paraText = paraLines.join('\n').trim();
    if (paraText) {
      flat.push({
        block_type: BLOCK_TYPE.TEXT,
        text: { elements: parseInlineMarkdown(paraText) },
      });
    }
  }

  flushFlat();
  return segments;
}

/**
 * Convert Markdown to a flat array of Feishu blocks (for `documentBlockChildren.create`).
 * Tables are rendered as plaintext code blocks here because the flat API can't nest;
 * use {@link markdownToSegments} + the descendant API for native tables.
 */
export function markdownToBlocks(markdown: string): FeishuBlock[] {
  const blocks: FeishuBlock[] = [];
  for (const seg of markdownToSegments(markdown)) {
    if (seg.type === 'blocks') {
      blocks.push(...seg.blocks);
    } else {
      const lines = seg.table.rows.map((r) => `| ${r.join(' | ')} |`);
      blocks.push(tableToCodeBlock(lines));
    }
  }
  return blocks;
}

/**
 * Build a `documentBlockDescendant.create` payload for a single native Feishu table.
 * Produces the nested `table` → `table_cell` → `text` structure with client-side temp
 * block IDs (unique within one request); Feishu assigns real IDs on creation.
 */
export function buildTableDescendants(table: TableData): {
  childrenId: string[];
  descendants: FeishuBlock[];
} {
  const tableId = 'tbl';
  const cellIds: string[] = [];
  const cellBlocks: FeishuBlock[] = [];
  const textBlocks: FeishuBlock[] = [];

  for (let r = 0; r < table.rows.length; r++) {
    for (let c = 0; c < table.columnSize; c++) {
      const cellId = `c_${r}_${c}`;
      const textId = `t_${r}_${c}`;
      cellIds.push(cellId);
      const content = table.rows[r][c] ?? '';
      cellBlocks.push({
        block_id: cellId,
        block_type: BLOCK_TYPE.TABLE_CELL,
        table_cell: {},
        children: [textId],
      });
      textBlocks.push({
        block_id: textId,
        block_type: BLOCK_TYPE.TEXT,
        // Empty cells use an empty elements array (Feishu rejects empty text_run content).
        text: { elements: content ? parseInlineMarkdown(content) : [] },
      });
    }
  }

  const tableBlock: FeishuBlock = {
    block_id: tableId,
    block_type: BLOCK_TYPE.TABLE,
    table: {
      property: {
        row_size: table.rowSize,
        column_size: table.columnSize,
        header_row: table.hasHeader,
      },
    },
    children: cellIds,
  };

  return { childrenId: [tableId], descendants: [tableBlock, ...cellBlocks, ...textBlocks] };
}

/**
 * Split blocks into batches for safe insertion.
 * Feishu API limits the number of blocks per request (~50).
 */
export function batchBlocks(blocks: FeishuBlock[], maxPerBatch = 50): FeishuBlock[][] {
  const batches: FeishuBlock[][] = [];
  for (let i = 0; i < blocks.length; i += maxPerBatch) {
    batches.push(blocks.slice(i, i + maxPerBatch));
  }
  return batches;
}
