import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';
import { validateToken } from './validation.js';
import { grantOwnerPermission, grantChatMembersPermission } from './permissions.js';
import { markdownToBlocks, batchBlocks, parseInlineMarkdown } from './markdown-to-blocks.js';

/**
 * 飞书文档 MCP 工具
 *
 * 支持操作: read / write / append / create / list_blocks / update_block / insert_blocks / delete_blocks
 */
export function feishuDocTool(chatId?: string) {
  return tool(
    'feishu_doc',
    [
      '读写飞书文档 (Docx)。',
      '',
      'Actions:',
      '- read: 读取文档纯文本内容',
      '- write: 覆盖写入文档 (清空后写入 Markdown，自动转换为飞书富文本格式)',
      '- append: 在文档末尾追加内容 (支持 Markdown 格式)',
      '- create: 创建新文档',
      '- list_blocks: 列出文档的 block 结构',
      '- update_block: 更新指定 block 的文本内容 (仅支持行内 Markdown: 加粗/斜体/删除线/行内代码/链接，不支持标题/列表等块级语法。需要 block_id，通过 list_blocks 获取)',
      '- insert_blocks: 在指定位置插入新 block (需要 block_id 作为父 block，index 指定位置)',
      '- delete_blocks: 删除指定 block (需要 block_id)',
      '',
      'write/append/insert_blocks 支持的 Markdown 语法: 标题(#)、加粗(**)、斜体(*)、删除线(~~)、行内代码(`)、链接、无序列表(-)、有序列表(1.)、代码块(```)、待办(- [ ])、分隔线(---)。',
      '',
      '编辑他人文档的推荐流程: list_blocks → 找到目标 block_id → update_block/insert_blocks/delete_blocks',
      '',
      'URL Token 提取: /docx/ABC123 → doc_token: ABC123',
    ].join('\n'),
    {
      action: z.enum(['read', 'write', 'append', 'create', 'list_blocks', 'update_block', 'insert_blocks', 'delete_blocks']).describe('操作类型'),
      doc_token: z.string().optional().describe('文档 token (read/write/append/list_blocks/update_block/insert_blocks/delete_blocks 时必填)'),
      content: z.string().optional().describe('写入/追加的 Markdown 内容 (write/append/update_block/insert_blocks 时必填，自动转换为飞书富文本)'),
      title: z.string().optional().describe('新文档标题 (create 时必填)'),
      folder_token: z.string().optional().describe('目标文件夹 token (create 时可选)'),
      block_id: z.string().optional().describe('目标 block ID (update_block/insert_blocks/delete_blocks 时必填，通过 list_blocks 获取)'),
      index: z.number().int().min(0).optional().describe('插入位置索引 (insert_blocks 时可选，0-based，不指定则追加到父 block 末尾)'),
    },
    async (args) => {
      const client = feishuClient.raw;
      try {
        if (args.doc_token) validateToken(args.doc_token, 'doc_token');
        if (args.folder_token) validateToken(args.folder_token, 'folder_token');
        if (args.block_id) validateToken(args.block_id, 'block_id');

        switch (args.action) {
          case 'read': {
            if (!args.doc_token) throw new Error('read 操作需要 doc_token');
            const resp = await client.docx.document.rawContent({
              path: { document_id: args.doc_token },
              params: { lang: 0 },
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            return { content: [{ type: 'text' as const, text: resp.data?.content ?? '(空文档)' }] };
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
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(blocksResp.data?.items ?? [], null, 2),
              }],
            };
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
