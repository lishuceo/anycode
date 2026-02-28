import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';
import { validateToken } from './validation.js';

// ============================================================
// 飞书任务 (Task v2) MCP 工具
//
// 支持操作: create / get / list / update
// 使用 @larksuiteoapi/node-sdk 的 client.task.v2.task API
// ============================================================

/**
 * 将用户输入的时间字符串解析为飞书 API 需要的秒级 Unix 时间戳字符串。
 *
 * 支持格式:
 * - Unix 秒级时间戳: "1773532800"
 * - Unix 毫秒级时间戳: "1773532800000" → 自动转秒
 * - ISO date-only: "2026-03-15" → 追加 T00:00:00Z 按 UTC 解析
 * - ISO datetime 无时区: "2026-03-15T10:00:00" → 追加 Z 按 UTC 解析
 * - ISO datetime 带时区: "2026-03-15T10:00:00+08:00" → 按指定时区解析
 */
export function parseDueDate(input: string): string {
  const trimmed = input.trim();

  // 1. 纯数字 → 可能是 Unix 时间戳
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    // 合理的秒级时间戳范围: >1e9 (2001-09-09) 且 <1e10 (2286-11-20)
    // 排除 "20260315" 等被误判为时间戳的类日期数字串
    if (num > 1_000_000_000 && num < 10_000_000_000) {
      return trimmed;
    }
    // 毫秒级时间戳 → 转秒
    if (num > 1_000_000_000_000 && num < 10_000_000_000_000) {
      return String(Math.floor(num / 1000));
    }
    // 不在合理范围的纯数字，当作无效输入
    throw new Error(`无效的时间戳: ${trimmed}（秒级时间戳应在 1e9 ~ 1e10 范围内）`);
  }

  // 2. date-only 格式 (如 "2026-03-15") → 显式追加 T00:00:00Z 避免时区歧义
  //    ECMAScript 规范: date-only 解析为 UTC 午夜，但行为在不同引擎间可能不一致
  //    显式追加 Z 保证结果确定性
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const ms = new Date(trimmed + 'T00:00:00Z').getTime();
    if (isNaN(ms)) throw new Error(`无效的日期: ${trimmed}`);
    return String(Math.floor(ms / 1000));
  }

  // 3. ISO datetime 无时区后缀 (如 "2026-03-15T10:00:00" 或 "2026-03-15T10:00")
  //    追加 Z 统一按 UTC 解析，避免服务器本地时区导致偏差
  let dateStr = trimmed;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(dateStr)) {
    dateStr += 'Z';
  }

  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) throw new Error(`无效的日期格式: ${trimmed}`);
  return String(Math.floor(ms / 1000));
}

/**
 * 校验 members JSON 字符串，解析为飞书任务 API 要求的成员数组
 *
 * 格式: [{"id": "ou_xxx", "role": "assignee"}, ...]
 * - id: 用户 open_id
 * - role: "assignee" (执行者) 或 "follower" (关注者)
 * - type: 可选，默认 "user"
 */
function validateMembers(jsonStr: string): Array<{ id: string; role: string; type?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('members 不是有效的 JSON 字符串');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('members 必须是 JSON 数组 (如 [{"id": "ou_xxx", "role": "assignee"}])');
  }
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('members 数组元素必须是对象');
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string' || !obj.id) {
      throw new Error('members 元素需要 id 字段 (用户 open_id)');
    }
    if (typeof obj.role !== 'string' || !obj.role) {
      throw new Error('members 元素需要 role 字段 ("assignee" 或 "follower")');
    }
  }
  return parsed as Array<{ id: string; role: string; type?: string }>;
}

/**
 * 飞书任务 MCP 工具
 *
 * 支持操作: create / get / list / update
 *
 * @param getUserToken 可选，返回当前用户的 user_access_token。
 *   有 user token 时 list 使用 Task v2 API（支持查看用户个人任务）；
 *   无 user token 时降级为 Task v1 API（仅 bot 创建的任务）。
 */
export function feishuTaskTool(getUserToken?: () => Promise<string | undefined>) {
  return tool(
    'feishu_task',
    [
      '创建和管理飞书任务 (Task v2)。',
      '',
      'Actions:',
      '- create: 创建任务 (需要 summary)',
      '- get: 获取任务详情 (需要 task_guid)',
      '- list: 查询任务列表 (支持 completed/page_size 过滤)',
      '- update: 编辑任务 (需要 task_guid + update_fields)',
      '',
      '时间格式 (due/start): Unix 秒级时间戳 或 ISO 日期 (如 "2026-03-15" 或 "2026-03-15T10:00:00")',
      'members 格式: JSON 数组 \'[{"id": "ou_xxx", "role": "assignee"}]\'',
      'update_fields: 逗号分隔的字段名 (如 "summary,due,description")',
    ].join('\n'),
    {
      action: z.enum(['create', 'get', 'list', 'update']).describe('操作类型'),
      // create / update 共用
      summary: z.string().optional().describe('任务标题 (create 时必填)'),
      description: z.string().optional().describe('任务描述'),
      due: z.string().optional().describe('截止时间: Unix 秒级时间戳 或 ISO 日期字符串'),
      start: z.string().optional().describe('开始时间: 同 due 格式'),
      is_all_day: z.boolean().optional().describe('是否全天任务 (默认 false)'),
      // get / update
      task_guid: z.string().optional().describe('任务 GUID (get/update 时必填)'),
      // update 专用
      update_fields: z.string().optional().describe('更新的字段名, 逗号分隔 (如 "summary,due")'),
      // create 专用
      members: z.string().optional().describe('成员 JSON 数组 (如 \'[{"id": "ou_xxx", "role": "assignee"}]\')'),
      // list
      page_size: z.number().optional().describe('每页任务数 (list 时可选, 默认 20)'),
      page_token: z.string().optional().describe('分页 token (list 时可选)'),
      completed: z.boolean().optional().describe('筛选已完成/未完成 (list 时可选)'),
      user_id_type: z.string().optional().describe('用户 ID 类型 (默认 open_id)'),
    },
    async (args) => {
      const client = feishuClient.raw;
      try {
        if (args.task_guid) validateToken(args.task_guid, 'task_guid');

        switch (args.action) {
          case 'create': {
            if (!args.summary) throw new Error('create 操作需要 summary (任务标题)');

            const data: Record<string, unknown> = { summary: args.summary };
            if (args.description) data.description = args.description;
            if (args.due) {
              data.due = { timestamp: parseDueDate(args.due), is_all_day: args.is_all_day ?? false };
            }
            if (args.start) {
              data.start = { timestamp: parseDueDate(args.start), is_all_day: args.is_all_day ?? false };
            }
            if (args.members) {
              data.members = validateMembers(args.members);
            }

            const resp = await client.task.v2.task.create({
              data: data as { summary: string },
              params: { user_id_type: args.user_id_type ?? 'open_id' },
            });
            if (resp.code !== 0) throw new Error(`创建任务失败 (${resp.code}): ${resp.msg}`);
            const task = resp.data?.task;
            return {
              content: [{
                type: 'text' as const,
                text: [
                  '任务已创建',
                  `guid: ${task?.guid ?? '(未知)'}`,
                  `summary: ${task?.summary ?? ''}`,
                  task?.due ? `due: ${task.due.timestamp}` : '',
                ].filter(Boolean).join('\n'),
              }],
            };
          }

          case 'get': {
            if (!args.task_guid) throw new Error('get 操作需要 task_guid');
            const resp = await client.task.v2.task.get({
              path: { task_guid: args.task_guid },
              params: { user_id_type: args.user_id_type ?? 'open_id' },
            });
            if (resp.code !== 0) throw new Error(`获取任务失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data?.task ?? {}, null, 2),
              }],
            };
          }

          case 'list': {
            // 优先使用 user_access_token 调用 Task v2 list（支持查看用户个人任务）。
            // 无 user token 时降级为 Task v1 list（仅 bot 创建的任务）。
            const userToken = getUserToken ? await getUserToken() : undefined;

            if (userToken) {
              // ── Task v2 list with user_access_token ──
              const v2Params: Record<string, unknown> = {
                page_size: args.page_size ?? 20,
                user_id_type: args.user_id_type ?? 'open_id',
              };
              if (args.page_token) v2Params.page_token = args.page_token;
              if (args.completed !== undefined) v2Params.completed = args.completed;

              const resp = await client.request<{
                code?: number;
                msg?: string;
                data?: {
                  items?: Array<{
                    guid?: string;
                    summary?: string;
                    due?: { timestamp?: string; is_all_day?: boolean };
                    completed_at?: string;
                    creator?: { id?: string };
                  }>;
                  has_more?: boolean;
                  page_token?: string;
                };
              }>({
                method: 'GET',
                url: '/open-apis/task/v2/tasks',
                params: v2Params,
                headers: { Authorization: `Bearer ${userToken}` },
              });
              if (resp.code !== 0) throw new Error(`查询任务列表失败 (${resp.code}): ${resp.msg}`);

              const items = (resp.data?.items ?? []).map((item) => ({
                guid: item.guid,
                summary: item.summary,
                due: item.due,
                completed_at: item.completed_at,
                creator_id: item.creator?.id,
              }));

              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    items,
                    has_more: resp.data?.has_more ?? false,
                    page_token: resp.data?.page_token,
                    _token_type: 'user',
                  }, null, 2),
                }],
              };
            }

            // ── Fallback: Task v1 list with tenant_access_token ──
            const params: Record<string, unknown> = {
              page_size: args.page_size ?? 20,
              user_id_type: args.user_id_type ?? 'open_id',
            };
            if (args.page_token) params.page_token = args.page_token;
            if (args.completed !== undefined) params.task_completed = args.completed;

            const resp = await client.task.v1.task.list({
              params: params as { page_size?: number; page_token?: string; task_completed?: boolean; user_id_type?: 'open_id' | 'user_id' | 'union_id' },
            });
            if (resp.code !== 0) throw new Error(`查询任务列表失败 (${resp.code}): ${resp.msg}`);

            // 将 v1 响应格式映射为与 v2 一致的结构
            const items = (resp.data?.items ?? []).map((item) => ({
              guid: item.id,
              summary: item.summary,
              due: item.due?.time && item.due.time !== '0'
                ? { timestamp: item.due.time, is_all_day: item.due.is_all_day }
                : undefined,
              completed_at: item.complete_time !== '0' ? item.complete_time : undefined,
              creator_id: item.creator_id,
            }));

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  items,
                  has_more: resp.data?.has_more ?? false,
                  page_token: resp.data?.page_token,
                  _token_type: 'bot',
                }, null, 2),
              }],
            };
          }

          case 'update': {
            if (!args.task_guid) throw new Error('update 操作需要 task_guid');
            if (!args.update_fields) throw new Error('update 操作需要 update_fields (逗号分隔的字段名, 如 "summary,due")');

            const updateFieldsArr = args.update_fields.split(',').map(s => s.trim()).filter(Boolean);
            if (updateFieldsArr.length === 0) throw new Error('update_fields 不能为空');

            const taskData: Record<string, unknown> = {};
            if (args.summary !== undefined) taskData.summary = args.summary;
            if (args.description !== undefined) taskData.description = args.description;
            if (args.due) {
              taskData.due = { timestamp: parseDueDate(args.due), is_all_day: args.is_all_day ?? false };
            }
            if (args.start) {
              taskData.start = { timestamp: parseDueDate(args.start), is_all_day: args.is_all_day ?? false };
            }

            const resp = await client.task.v2.task.patch({
              path: { task_guid: args.task_guid },
              data: {
                task: taskData as { summary?: string },
                update_fields: updateFieldsArr,
              },
              params: { user_id_type: args.user_id_type ?? 'open_id' },
            });
            if (resp.code !== 0) throw new Error(`更新任务失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: '任务已更新',
              }],
            };
          }

          default:
            return { content: [{ type: 'text' as const, text: `未知 action: ${args.action}` }], isError: true };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, action: args.action }, 'feishu_task tool error');
        return { content: [{ type: 'text' as const, text: `错误: ${msg}` }], isError: true };
      }
    },
  );
}
