import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';
import { validateToken } from './validation.js';
import { grantOwnerPermission, grantChatMembersPermission } from './permissions.js';
import { markdownToBlocks, batchBlocks, parseInlineMarkdown } from './markdown-to-blocks.js';

/** Max lines returned by read before truncation (matches Claude Code's Read tool default) */
const READ_LINE_LIMIT = 2000;

/** Block type ID → human-readable name */
const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: 'page', 2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3',
  6: 'heading4', 7: 'heading5', 8: 'heading6', 9: 'heading7',
  10: 'heading8', 11: 'heading9', 12: 'bullet', 13: 'ordered',
  14: 'code', 15: 'quote', 16: 'todo', 17: 'bitable', 18: 'callout',
  19: 'chat_card', 20: 'diagram', 21: 'divider', 22: 'file',
  23: 'grid', 24: 'grid_column', 25: 'iframe', 26: 'image',
  27: 'isv', 28: 'mindnote', 29: 'sheet', 30: 'table',
  31: 'table_cell', 32: 'view', 33: 'undefined', 999: 'virtual_merge',
  34: 'quote_container', 40: 'task', 41: 'okr',
  42: 'okr_objective', 43: 'okr_key_result', 44: 'okr_progress',
  46: 'add_ons', 48: 'jira_issue', 49: 'wiki_catalog',
  51: 'board', 52: 'agenda', 53: 'agenda_item',
  54: 'agenda_item_content',
};

/**
 * Extract plain text from a single block's rich text elements.
 */
function extractBlockText(block: Record<string, unknown>): string {
  // Different block types store text in different properties
  const textContainers = ['text', 'heading1', 'heading2', 'heading3', 'heading4',
    'heading5', 'heading6', 'heading7', 'heading8', 'heading9',
    'bullet', 'ordered', 'quote', 'todo', 'callout'];
  for (const key of textContainers) {
    const container = block[key] as Record<string, unknown> | undefined;
    if (container?.elements && Array.isArray(container.elements)) {
      return (container.elements as Array<Record<string, unknown>>)
        .map((el) => {
          const run = el.text_run as Record<string, unknown> | undefined;
          return run?.content as string ?? '';
        })
        .join('');
    }
  }
  // Code block
  const code = block.code as Record<string, unknown> | undefined;
  if (code?.elements && Array.isArray(code.elements)) {
    return (code.elements as Array<Record<string, unknown>>)
      .map((el) => {
        const run = el.text_run as Record<string, unknown> | undefined;
        return run?.content as string ?? '';
      })
      .join('');
  }
  return '';
}

/**
 * 飞书文档 MCP 工具
 *
 * 支持操作: read / write / append / create / list_blocks / read_blocks / update_block / insert_blocks / delete_blocks
 */
export function feishuDocTool(chatId?: string) {
  return tool(
    'feishu_doc',
    [
      '读写飞书文档 (Docx)。',
      '',
      'Actions:',
      '- read: 读取文档纯文本内容 (超过 2000 行自动截断，返回前 2000 行 + 文档结构摘要)',
      '- write: 覆盖写入文档 (清空后写入 Markdown，自动转换为飞书富文本格式)',
      '- append: 在文档末尾追加内容 (支持 Markdown 格式)',
      '- create: 创建新文档 (可同时传 content 写入内容，避免创建空文档)',
      '- list_blocks: 列出文档的 block 结构 (返回精简目录: block_id、类型、文本摘要)',
      '- read_blocks: 读取指定 block 的完整文本内容 (传入 block_id，逗号分隔可读多个)',
      '- update_block: 更新指定 block 的文本内容 (仅支持行内 Markdown: 加粗/斜体/删除线/行内代码/链接，不支持标题/列表等块级语法。需要 block_id，通过 list_blocks 获取)',
      '- insert_blocks: 在指定位置插入新 block (需要 block_id 作为父 block，index 指定位置)',
      '- delete_blocks: 删除指定 block (需要 block_id)',
      '',
      'write/append/insert_blocks 支持的 Markdown 语法: 标题(#)、加粗(**)、斜体(*)、删除线(~~)、行内代码(`)、链接、无序列表(-)、有序列表(1.)、代码块(```)、待办(- [ ])、分隔线(---)。',
      '',
      '读取文档的推荐流程: read (自动截断大文档) → 如需查看被截断部分，用 list_blocks 定位 → read_blocks 按需读取',
      '编辑他人文档的推荐流程: list_blocks → 找到目标 block_id → update_block/insert_blocks/delete_blocks',
      '',
      'URL Token 提取: /docx/ABC123 → doc_token: ABC123',
    ].join('\n'),
    {
      action: z.enum(['read', 'write', 'append', 'create', 'list_blocks', 'read_blocks', 'update_block', 'insert_blocks', 'delete_blocks']).describe('操作类型'),
      doc_token: z.string().optional().describe('文档 token (read/write/append/list_blocks/read_blocks/update_block/insert_blocks/delete_blocks 时必填)'),
      content: z.string().optional().describe('Markdown 内容 (write/append/update_block/insert_blocks 时必填；create 时可选，传入则创建后自动写入，避免空文档)'),
      title: z.string().optional().describe('新文档标题 (create 时必填)'),
      folder_token: z.string().optional().describe('目标文件夹 token (create 时可选)'),
      block_id: z.string().optional().describe('目标 block ID (read_blocks 时支持逗号分隔多个; update_block/insert_blocks/delete_blocks 时必填)'),
      index: z.number().int().min(0).optional().describe('插入位置索引 (insert_blocks 时可选，0-based，不指定则追加到父 block 末尾)'),
    },
    async (args) => {
      const client = feishuClient.raw;
      try {
        if (args.doc_token) validateToken(args.doc_token, 'doc_token');
        if (args.folder_token) validateToken(args.folder_token, 'folder_token');
        if (args.block_id) {
          // read_blocks supports comma-separated block IDs — validate each individually
          const ids = args.action === 'read_blocks'
            ? args.block_id.split(',').map((id) => id.trim()).filter(Boolean)
            : [args.block_id];
          for (const id of ids) validateToken(id, 'block_id');
        }

        switch (args.action) {
          case 'read': {
            if (!args.doc_token) throw new Error('read 操作需要 doc_token');
            const resp = await client.docx.document.rawContent({
              path: { document_id: args.doc_token },
              params: { lang: 0 },
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            const fullText = resp.data?.content ?? '';
            if (!fullText) return { content: [{ type: 'text' as const, text: '(空文档)' }] };

            const lines = fullText.split('\n');
            if (lines.length <= READ_LINE_LIMIT) {
              return { content: [{ type: 'text' as const, text: fullText }] };
            }

            // Document exceeds line limit — truncate and append structure summary
            const truncated = lines.slice(0, READ_LINE_LIMIT).join('\n');
            const totalChars = fullText.length;
            const returnedChars = truncated.length;

            // Fetch block structure for the summary
            let structureSummary = '';
            try {
              const blocksResp = await client.docx.documentBlock.list({
                path: { document_id: args.doc_token },
                params: { page_size: 500 },
              });
              if (blocksResp.code === 0 && blocksResp.data?.items) {
                const headings = (blocksResp.data.items as Array<Record<string, unknown>>)
                  .filter((b) => {
                    const t = b.block_type as number;
                    return t >= 3 && t <= 11; // heading1-9
                  })
                  .map((b) => {
                    const level = (b.block_type as number) - 2;
                    const text = extractBlockText(b);
                    return `${'  '.repeat(level - 1)}- ${text || '(无标题)'} [${b.block_id}]`;
                  });
                if (headings.length > 0) {
                  structureSummary = '\n\n目录:\n' + headings.join('\n');
                }
              }
            } catch {
              // Structure summary is best-effort, don't fail the read
            }

            const hint = [
              `\n\n--- 文档已截断 ---`,
              `已返回前 ${READ_LINE_LIMIT} 行 (${returnedChars} 字符)，共 ${lines.length} 行 (${totalChars} 字符)。`,
              `如需查看完整内容，使用 list_blocks 查看结构，再用 read_blocks 按需读取指定段落。`,
            ].join('\n');

            return { content: [{ type: 'text' as const, text: truncated + hint + structureSummary }] };
          }

          case 'write': {
            if (!args.doc_token) throw new Error('write 操作需要 doc_token');
            if (!args.content) throw new Error('write 操作需要 content');
            // 1. 获取现有 blocks
            const listResp = await client.docx.documentBlock.list({
              path: { document_id: args.doc_token },
              params: { page_size: 500 },
            });
            if (listResp.code !== 0) throw new Error(`获取 blocks 失败 (${listResp.code}): ${listResp.msg}`);

            // 2. 删除所有子 block (跳过 page block 本身)
            const blockIds = (listResp.data?.items ?? [])
              .filter((b) => b.block_type !== 1) // block_type 1 = page
              .map((b) => b.block_id)
              .filter((id): id is string => !!id);

            if (blockIds.length > 0) {
              // 获取 page block id
              const pageBlock = (listResp.data?.items ?? []).find((b) => b.block_type === 1);
              const pageBlockId = pageBlock?.block_id ?? args.doc_token;

              const delResp = await client.docx.documentBlockChildren.batchDelete({
                path: { document_id: args.doc_token, block_id: pageBlockId },
                data: { start_index: 0, end_index: blockIds.length },
              });
              if (delResp.code !== 0) throw new Error(`删除 blocks 失败 (${delResp.code}): ${delResp.msg}`);
            }

            // 3. 将 Markdown 转换为 block 并批量写入
            const pageBlock2 = (listResp.data?.items ?? []).find((b) => b.block_type === 1);
            const pageBlockId2 = pageBlock2?.block_id ?? args.doc_token;

            const blocks = markdownToBlocks(args.content);
            const batches = batchBlocks(blocks);
            for (const batch of batches) {
              const createResp1 = await client.docx.documentBlockChildren.create({
                path: { document_id: args.doc_token, block_id: pageBlockId2 },
                data: { children: batch },
              });
              if (createResp1.code !== 0) throw new Error(`写入 blocks 失败 (${createResp1.code}): ${createResp1.msg}`);
            }
            return { content: [{ type: 'text' as const, text: '文档已更新' }] };
          }

          case 'append': {
            if (!args.doc_token) throw new Error('append 操作需要 doc_token');
            if (!args.content) throw new Error('append 操作需要 content');
            // 获取 page block id
            const listResp2 = await client.docx.documentBlock.list({
              path: { document_id: args.doc_token },
              params: { page_size: 1 },
            });
            const pageBlock3 = (listResp2.data?.items ?? []).find((b) => b.block_type === 1);
            const pageBlockId3 = pageBlock3?.block_id ?? args.doc_token;

            const appendBlocks = markdownToBlocks(args.content);
            const appendBatches = batchBlocks(appendBlocks);
            for (const batch of appendBatches) {
              const createResp2 = await client.docx.documentBlockChildren.create({
                path: { document_id: args.doc_token, block_id: pageBlockId3 },
                data: { children: batch },
              });
              if (createResp2.code !== 0) throw new Error(`追加 blocks 失败 (${createResp2.code}): ${createResp2.msg}`);
            }
            return { content: [{ type: 'text' as const, text: '内容已追加' }] };
          }

          case 'create': {
            if (!args.title) throw new Error('create 操作需要 title');
            const createResp = await client.docx.document.create({
              data: {
                title: args.title,
                folder_token: args.folder_token,
              },
            });
            if (createResp.code !== 0) throw new Error(`创建文档失败 (${createResp.code}): ${createResp.msg}`);
            const doc = createResp.data?.document;
            if (doc?.document_id) {
              await grantOwnerPermission(doc.document_id, 'docx');
              await grantChatMembersPermission(doc.document_id, 'docx', chatId);

              // 如果提供了 content，创建后自动写入，避免空文档
              if (args.content) {
                const blocks = markdownToBlocks(args.content);
                const batches = batchBlocks(blocks);
                for (const batch of batches) {
                  const writeResp = await client.docx.documentBlockChildren.create({
                    path: { document_id: doc.document_id, block_id: doc.document_id },
                    data: { children: batch },
                  });
                  if (writeResp.code !== 0) {
                    logger.warn({ code: writeResp.code, msg: writeResp.msg }, 'create: 写入内容失败，文档已创建但为空');
                  }
                }
              }
            }
            return {
              content: [{
                type: 'text' as const,
                text: `文档已创建\ntoken: ${doc?.document_id}\ntitle: ${doc?.title}`,
              }],
            };
          }

          case 'list_blocks': {
            if (!args.doc_token) throw new Error('list_blocks 操作需要 doc_token');
            const blocksResp = await client.docx.documentBlock.list({
              path: { document_id: args.doc_token },
              params: { page_size: 500 },
            });
            if (blocksResp.code !== 0) throw new Error(`API 错误 (${blocksResp.code}): ${blocksResp.msg}`);
            const items = (blocksResp.data?.items ?? []) as Array<Record<string, unknown>>;

            // Build concise structure: block_id | type | text preview
            const lines = items
              .filter((b) => (b.block_type as number) !== 1) // skip page block
              .map((b) => {
                const typeId = b.block_type as number;
                const typeName = BLOCK_TYPE_NAMES[typeId] ?? `type_${typeId}`;
                const text = extractBlockText(b);
                const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
                return `${b.block_id}\t${typeName}\t${preview}`;
              });

            const header = `block_id\ttype\tpreview (共 ${lines.length} blocks)`;
            return {
              content: [{
                type: 'text' as const,
                text: [header, ...lines].join('\n'),
              }],
            };
          }

          case 'read_blocks': {
            if (!args.doc_token) throw new Error('read_blocks 操作需要 doc_token');
            if (!args.block_id) throw new Error('read_blocks 操作需要 block_id (逗号分隔可读多个)');
            const targetIds = args.block_id.split(',').map((id) => id.trim()).filter(Boolean);
            if (targetIds.length === 0) throw new Error('block_id 不能为空');

            // Fetch all blocks and filter
            const allBlocks = await client.docx.documentBlock.list({
              path: { document_id: args.doc_token },
              params: { page_size: 500 },
            });
            if (allBlocks.code !== 0) throw new Error(`API 错误 (${allBlocks.code}): ${allBlocks.msg}`);

            const blockMap = new Map<string, Record<string, unknown>>();
            for (const b of (allBlocks.data?.items ?? []) as Array<Record<string, unknown>>) {
              if (b.block_id) blockMap.set(b.block_id as string, b);
            }

            // Collect target blocks and their descendants
            const collectDescendants = (blockId: string): string[] => {
              const block = blockMap.get(blockId);
              if (!block) return [];
              const result = [blockId];
              const children = block.children as string[] | undefined;
              if (children) {
                for (const childId of children) {
                  result.push(...collectDescendants(childId));
                }
              }
              return result;
            };

            const results: string[] = [];
            for (const targetId of targetIds) {
              const allIds = collectDescendants(targetId);
              if (allIds.length === 0) {
                results.push(`[${targetId}] (未找到)`);
                continue;
              }
              const blockTexts: string[] = [];
              for (const id of allIds) {
                const block = blockMap.get(id);
                if (!block) continue;
                const typeId = block.block_type as number;
                const typeName = BLOCK_TYPE_NAMES[typeId] ?? `type_${typeId}`;
                const text = extractBlockText(block);
                if (text || typeId === 21 /* divider */) {
                  blockTexts.push(`[${typeName}] ${text}`);
                }
              }
              results.push(`--- ${targetId} (${allIds.length} blocks) ---\n${blockTexts.join('\n')}`);
            }

            return { content: [{ type: 'text' as const, text: results.join('\n\n') }] };
          }

          case 'update_block': {
            if (!args.doc_token) throw new Error('update_block 操作需要 doc_token');
            if (!args.block_id) throw new Error('update_block 操作需要 block_id');
            if (!args.content) throw new Error('update_block 操作需要 content');
            const updateElements = parseInlineMarkdown(args.content);
            const updateResp = await client.docx.documentBlock.batchUpdate({
              path: { document_id: args.doc_token },
              data: {
                requests: [{
                  block_id: args.block_id,
                  update_text_elements: { elements: updateElements },
                }],
              },
            });
            if (updateResp.code !== 0) throw new Error(`更新 block 失败 (${updateResp.code}): ${updateResp.msg}`);
            return { content: [{ type: 'text' as const, text: 'Block 已更新' }] };
          }

          case 'insert_blocks': {
            if (!args.doc_token) throw new Error('insert_blocks 操作需要 doc_token');
            if (!args.block_id) throw new Error('insert_blocks 操作需要 block_id (父 block)');
            if (!args.content) throw new Error('insert_blocks 操作需要 content');
            const insertedBlocks = markdownToBlocks(args.content);
            const insertBatches = batchBlocks(insertedBlocks);
            let currentIndex = args.index;
            for (const batch of insertBatches) {
              const createResp3 = await client.docx.documentBlockChildren.create({
                path: { document_id: args.doc_token, block_id: args.block_id },
                data: {
                  children: batch,
                  ...(currentIndex != null ? { index: currentIndex } : {}),
                },
              });
              if (createResp3.code !== 0) throw new Error(`插入 blocks 失败 (${createResp3.code}): ${createResp3.msg}`);
              if (currentIndex != null) currentIndex += batch.length;
            }
            return { content: [{ type: 'text' as const, text: `已插入 ${insertedBlocks.length} 个 block` }] };
          }

          case 'delete_blocks': {
            if (!args.doc_token) throw new Error('delete_blocks 操作需要 doc_token');
            if (!args.block_id) throw new Error('delete_blocks 操作需要 block_id (要删除的 block)');
            // 找到 block 的 parent 和在 parent 中的 index
            const allBlocksResp = await client.docx.documentBlock.list({
              path: { document_id: args.doc_token },
              params: { page_size: 500 },
            });
            if (allBlocksResp.code !== 0) throw new Error(`获取 blocks 失败 (${allBlocksResp.code}): ${allBlocksResp.msg}`);
            const targetBlock = (allBlocksResp.data?.items ?? []).find((b) => b.block_id === args.block_id);
            if (!targetBlock) throw new Error(`未找到 block: ${args.block_id}`);
            const parentId = targetBlock.parent_id;
            if (!parentId) throw new Error('无法确定 block 的父节点');
            // 找到 parent block 的 children 列表中 target 的 index
            const parentBlock = (allBlocksResp.data?.items ?? []).find((b) => b.block_id === parentId);
            const childrenIds = parentBlock?.children ?? [];
            const blockIndex = childrenIds.indexOf(args.block_id);
            if (blockIndex === -1) throw new Error(`block ${args.block_id} 不在父节点的 children 中`);
            const delResp2 = await client.docx.documentBlockChildren.batchDelete({
              path: { document_id: args.doc_token, block_id: parentId },
              data: { start_index: blockIndex, end_index: blockIndex + 1 },
            });
            if (delResp2.code !== 0) throw new Error(`删除 block 失败 (${delResp2.code}): ${delResp2.msg}`);
            return { content: [{ type: 'text' as const, text: 'Block 已删除' }] };
          }

          default:
            return { content: [{ type: 'text' as const, text: `未知 action: ${args.action}` }], isError: true };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, action: args.action }, 'feishu_doc tool error');
        return { content: [{ type: 'text' as const, text: `错误: ${msg}` }], isError: true };
      }
    },
  );
}
