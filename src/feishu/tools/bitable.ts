import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';
import { validateToken, validateFieldsObject } from './validation.js';

/**
 * 飞书多维表格 MCP 工具
 *
 * 支持操作: list_tables / list_fields / list_records / get_record / create_record / update_record / delete_record
 */
export function feishuBitableTool() {
  return tool(
    'feishu_bitable',
    [
      '读写飞书多维表格 (Bitable/Base)。',
      '',
      'Actions:',
      '- list_tables: 列出多维表格中的数据表',
      '- list_fields: 列出数据表的字段定义',
      '- list_records: 列出记录 (支持 filter/sort/page_size)',
      '- get_record: 获取单条记录',
      '- create_record: 创建记录 (fields 为 JSON 字符串)',
      '- update_record: 更新记录 (fields 为 JSON 字符串)',
      '- delete_record: 删除记录',
      '',
      'URL Token 提取: /base/ABC123 → app_token: ABC123',
      '',
      'fields 格式示例: \'{"姓名": "张三", "年龄": 25}\'',
    ].join('\n'),
    {
      action: z.enum([
        'list_tables', 'list_fields', 'list_records', 'get_record',
        'create_record', 'update_record', 'delete_record',
      ]).describe('操作类型'),
      app_token: z.string().optional().describe('多维表格 app_token'),
      table_id: z.string().optional().describe('数据表 ID'),
      record_id: z.string().optional().describe('记录 ID (get_record/update_record/delete_record 时必填)'),
      fields: z.string().optional().describe('字段数据 JSON 字符串 (create_record/update_record 时必填)'),
      filter: z.string().optional().describe('过滤条件 (list_records 时可选)'),
      sort: z.string().optional().describe('排序条件 JSON (list_records 时可选)'),
      page_size: z.number().optional().describe('每页记录数 (list_records 时可选, 默认 20)'),
    },
    async (args) => {
      const client = feishuClient.raw;
      try {
        if (args.app_token) validateToken(args.app_token, 'app_token');
        if (args.table_id) validateToken(args.table_id, 'table_id');
        if (args.record_id) validateToken(args.record_id, 'record_id');

        // fields 校验 (review 反馈修复: JSON.parse 后做类型校验 + 原型污染防护)
        let validatedFields: Record<string, unknown> | undefined;
        if (args.fields) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(args.fields);
          } catch {
            throw new Error('fields 不是有效的 JSON 字符串');
          }
          validatedFields = validateFieldsObject(parsed);
        }

        switch (args.action) {
          case 'list_tables': {
            if (!args.app_token) throw new Error('list_tables 操作需要 app_token');
            const resp = await client.bitable.appTable.list({
              path: { app_token: args.app_token },
              params: { page_size: 100 },
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data?.items ?? [], null, 2),
              }],
            };
          }

          case 'list_fields': {
            if (!args.app_token) throw new Error('list_fields 操作需要 app_token');
            if (!args.table_id) throw new Error('list_fields 操作需要 table_id');
            const resp = await client.bitable.appTableField.list({
              path: { app_token: args.app_token, table_id: args.table_id },
              params: { page_size: 100 },
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data?.items ?? [], null, 2),
              }],
            };
          }

          case 'list_records': {
            if (!args.app_token) throw new Error('list_records 操作需要 app_token');
            if (!args.table_id) throw new Error('list_records 操作需要 table_id');
            const params: Record<string, unknown> = {
              page_size: args.page_size ?? 20,
            };
            if (args.filter) params.filter = args.filter;
            if (args.sort) params.sort = args.sort;
            const resp = await client.bitable.appTableRecord.list({
              path: { app_token: args.app_token, table_id: args.table_id },
              params: params as { page_size?: number; filter?: string; sort?: string },
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  total: resp.data?.total,
                  items: resp.data?.items ?? [],
                }, null, 2),
              }],
            };
          }

          case 'get_record': {
            if (!args.app_token) throw new Error('get_record 操作需要 app_token');
            if (!args.table_id) throw new Error('get_record 操作需要 table_id');
            if (!args.record_id) throw new Error('get_record 操作需要 record_id');
            const resp = await client.bitable.appTableRecord.get({
              path: { app_token: args.app_token, table_id: args.table_id, record_id: args.record_id },
            });
            if (resp.code !== 0) throw new Error(`API 错误 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data?.record ?? {}, null, 2),
              }],
            };
          }

          case 'create_record': {
            if (!args.app_token) throw new Error('create_record 操作需要 app_token');
            if (!args.table_id) throw new Error('create_record 操作需要 table_id');
            if (!validatedFields) throw new Error('create_record 操作需要 fields');
            const resp = await client.bitable.appTableRecord.create({
              path: { app_token: args.app_token, table_id: args.table_id },
              data: { fields: validatedFields as Record<string, string | number | boolean> },
            });
            if (resp.code !== 0) throw new Error(`创建记录失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: `记录已创建\nrecord_id: ${resp.data?.record?.record_id ?? '(未知)'}`,
              }],
            };
          }

          case 'update_record': {
            if (!args.app_token) throw new Error('update_record 操作需要 app_token');
            if (!args.table_id) throw new Error('update_record 操作需要 table_id');
            if (!args.record_id) throw new Error('update_record 操作需要 record_id');
            if (!validatedFields) throw new Error('update_record 操作需要 fields');
            const resp = await client.bitable.appTableRecord.update({
              path: { app_token: args.app_token, table_id: args.table_id, record_id: args.record_id },
              data: { fields: validatedFields as Record<string, string | number | boolean> },
            });
            if (resp.code !== 0) throw new Error(`更新记录失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: '记录已更新',
              }],
            };
          }

          case 'delete_record': {
            if (!args.app_token) throw new Error('delete_record 操作需要 app_token');
            if (!args.table_id) throw new Error('delete_record 操作需要 table_id');
            if (!args.record_id) throw new Error('delete_record 操作需要 record_id');
            const resp = await client.bitable.appTableRecord.delete({
              path: { app_token: args.app_token, table_id: args.table_id, record_id: args.record_id },
            });
            if (resp.code !== 0) throw new Error(`删除记录失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: '记录已删除',
              }],
            };
          }

          default:
            return { content: [{ type: 'text' as const, text: `未知 action: ${args.action}` }], isError: true };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, action: args.action }, 'feishu_bitable tool error');
        return { content: [{ type: 'text' as const, text: `错误: ${msg}` }], isError: true };
      }
    },
  );
}
