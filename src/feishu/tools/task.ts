import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as lark from '@larksuiteoapi/node-sdk';
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
 * 将用户输入的时间字符串解析为飞书 API 需要的毫秒级 Unix 时间戳字符串。
 *
 * 飞书 Task v2 API 的 due/start/completed_at 等时间字段均使用毫秒级时间戳
 * （与 created_at / updated_at 一致，均为 13 位数字）。
 *
 * 支持格式:
 * - Unix 秒级时间戳: "1773532800" → 自动转毫秒
 * - Unix 毫秒级时间戳: "1773532800000" → 直接使用
 * - ISO date-only: "2026-03-15" → 追加 T00:00:00Z 按 UTC 解析
 * - ISO datetime 无时区: "2026-03-15T10:00:00" → 追加 Z 按 UTC 解析
 * - ISO datetime 带时区: "2026-03-15T10:00:00+08:00" → 按指定时区解析
 */
export function parseDueDate(input: string): string {
  const trimmed = input.trim();
  let ms: number;

  // 1. 纯数字 → 可能是 Unix 时间戳
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    // 合理的秒级时间戳范围: >1e9 (2001-09-09) 且 <1e10 (2286-11-20)
    // 排除 "20260315" 等被误判为时间戳的类日期数字串
    if (num > 1_000_000_000 && num < 10_000_000_000) {
      // 秒级时间戳 → 转毫秒
      ms = num * 1000;
    } else if (num > 1_000_000_000_000 && num < 10_000_000_000_000) {
      // 毫秒级时间戳 → 直接使用
      ms = num;
    } else {
      // 不在合理范围的纯数字，当作无效输入
      throw new Error(`无效的时间戳: ${trimmed}（秒级时间戳应在 1e9 ~ 1e10 范围内）`);
    }
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    // 2. date-only 格式 (如 "2026-03-15") → 显式追加 T00:00:00Z 避免时区歧义
    ms = new Date(trimmed + 'T00:00:00Z').getTime();
    if (isNaN(ms)) throw new Error(`无效的日期: ${trimmed}`);
  } else {
    // 3. ISO datetime (带或不带时区)
    let dateStr = trimmed;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(dateStr)) {
      dateStr += 'Z';
    }
    ms = new Date(dateStr).getTime();
    if (isNaN(ms)) throw new Error(`无效的日期格式: ${trimmed}`);
  }

  // 4. 合理性校验: 不能是过去，不能超过 1 年后
  const nowMs = Date.now();
  const oneYearLaterMs = nowMs + 365 * 86400_000;
  const humanDate = new Date(ms).toISOString().slice(0, 10);
  // 允许"今天"的日期通过: 将 now 对齐到当天 UTC 午夜
  const todayMidnightMs = nowMs - (nowMs % 86400_000);

  if (ms < todayMidnightMs) {
    throw new Error(
      `日期 ${humanDate} 已过期（输入: "${trimmed}"）。截止/开始时间不能是过去`,
    );
  }
  if (ms > oneYearLaterMs) {
    throw new Error(
      `日期 ${humanDate} 超过 1 年后（输入: "${trimmed}"）。截止/开始时间最长不超过 1 年`,
    );
  }

  return String(ms);
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
 * 校验 tasklists JSON 字符串，解析为飞书任务 API 要求的清单数组
 *
 * 格式: [{"tasklist_guid": "xxx", "section_guid": "yyy"}]
 * - tasklist_guid: 必填，清单 ID（通过 list_tasklists 获取）
 * - section_guid: 可选，清单中的分组 ID
 */
function validateTasklists(jsonStr: string): Array<{ tasklist_guid: string; section_guid?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('tasklists 不是有效的 JSON 字符串');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('tasklists 必须是 JSON 数组 (如 [{"tasklist_guid": "xxx"}])');
  }
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('tasklists 数组元素必须是对象');
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.tasklist_guid !== 'string' || !obj.tasklist_guid) {
      throw new Error('tasklists 元素需要 tasklist_guid 字段');
    }
  }
  return parsed as Array<{ tasklist_guid: string; section_guid?: string }>;
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
export function feishuTaskTool(getUserToken?: () => Promise<string | undefined>, requesterId?: string) {
  return tool(
    'feishu_task',
    [
      '创建和管理飞书任务 (Task v2)。',
      '',
      'Actions:',
      '- create: 创建任务 (需要 summary, 必须通过 tasklists 指定归属清单)',
      '- get: 获取任务详情 (需要 task_guid)',
      '- list: 查询任务列表 (支持 completed/page_size 过滤)',
      '- list_tasklists: 列出可用的任务清单 (返回 guid + name)',
      '- update: 编辑任务 (需要 task_guid + update_fields)',
      '- delete: 删除任务 (需要 task_guid)',
      '- add_members: 添加任务成员 (需要 task_guid + members)',
      '- remove_members: 移除任务成员 (需要 task_guid + members)',
      '',
      '⚠️ 创建任务前先调用 list_tasklists 查询可用清单，优先使用以下清单:',
      '  - Web: taptap/maker 仓库的前后端任务',
      '  - Agent: taptap/maker 仓库的 agent server 任务',
      '  - MCP: taptap/maker 仓库的 MCP 工具任务',
      '  - UrhoX: 游戏引擎 (taptap/urhox) 任务',
      '  - Maker: 通用清单，不确定归属时放这里',
      '  创建时通过 list_tasklists 获取清单 guid，示例: tasklists=\'[{"tasklist_guid": "xxx"}]\'',
      '',
      '📋 任务标题 (summary) 使用结构化前缀:',
      '  feat: 新功能 | fix: 修复 | refactor: 重构 | docs: 文档 | chore: 杂务',
      '  示例: "feat: 添加用户认证" / "fix: 修复登录超时"',
      '',
      '⏰ 创建任务时必须设置 due 截止时间。如用户未指定，默认设为 7 天后。',
      '',
      '时间格式 (due/start): Unix 秒级时间戳 或 ISO 日期 (如 "2026-03-15" 或 "2026-03-15T10:00:00")',
      'members 格式: JSON 数组 \'[{"id": "ou_xxx", "role": "assignee"}]\'',
      'tasklists 格式: JSON 数组 \'[{"tasklist_guid": "xxx"}]\'',
      'update_fields: 逗号分隔的字段名 (如 "summary,due,description,completed_at")',
      '  - completed_at: 设为当前时间表示完成任务，设为空字符串表示取消完成',
    ].join('\n'),
    {
      action: z.enum(['create', 'get', 'list', 'list_tasklists', 'update', 'delete', 'add_members', 'remove_members']).describe('操作类型'),
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
      tasklists: z.string().optional().describe('归属清单 JSON 数组 (如 \'[{"tasklist_guid": "xxx"}]\', 通过 list_tasklists 获取)'),
      // list
      page_size: z.number().optional().describe('每页数量 (list/list_tasklists 时可选, 默认 20)'),
      page_token: z.string().optional().describe('分页 token (list/list_tasklists 时可选)'),
      completed: z.boolean().optional().describe('筛选已完成/未完成 (list 时可选)'),
      user_id_type: z.string().optional().describe('用户 ID 类型 (默认 open_id)'),
    },
    async (args) => {
      const client = feishuClient.raw;
      try {
        if (args.task_guid) validateToken(args.task_guid, 'task_guid');

        // 获取 user_access_token（所有 Task v2 操作都需要用户授权）
        const userToken = getUserToken ? await getUserToken() : undefined;
        const userTokenOpt = userToken ? lark.withUserAccessToken(userToken) : undefined;

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
            // 自动将发起请求的用户加为关注者（如果尚未在 members 中）
            if (requesterId) {
              const members = (data.members ?? []) as Array<{ id: string; role: string; type?: string }>;
              const alreadyIncluded = members.some((m) => m.id === requesterId);
              if (!alreadyIncluded) {
                members.push({ id: requesterId, role: 'follower' });
                data.members = members;
              }
            }
            if (args.tasklists) {
              data.tasklists = validateTasklists(args.tasklists);
            }

            const resp = await client.task.v2.task.create({
              data: data as { summary: string },
              params: { user_id_type: args.user_id_type ?? 'open_id' },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`创建任务失败 (${resp.code}): ${resp.msg}`);
            const task = resp.data?.task;
            const guid = task?.guid ?? '(未知)';
            return {
              content: [{
                type: 'text' as const,
                text: [
                  '任务已创建',
                  `guid: ${guid}`,
                  `summary: ${task?.summary ?? ''}`,
                  task?.due ? `due: ${task.due.timestamp} (${new Date(Number(task.due.timestamp)).toISOString().slice(0, 10)})` : '',
                  guid !== '(未知)' ? `link: https://applink.feishu.cn/client/todo/detail?guid=${guid}` : '',
                ].filter(Boolean).join('\n'),
              }],
            };
          }

          case 'get': {
            if (!args.task_guid) throw new Error('get 操作需要 task_guid');
            const resp = await client.task.v2.task.get({
              path: { task_guid: args.task_guid },
              params: { user_id_type: args.user_id_type ?? 'open_id' },
            }, userTokenOpt);
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
            if (userToken) {
              // ── Task v2 list with user_access_token ──
              // 权限不足 (99991679) 时自动降级到 v1 API，而不是直接报错。
              // 常见原因：user token 缺少 task:task:read scope（需用户重新授权）。
              const v2Params: Record<string, unknown> = {
                page_size: args.page_size ?? 20,
                user_id_type: args.user_id_type ?? 'open_id',
              };
              if (args.page_token) v2Params.page_token = args.page_token;
              if (args.completed !== undefined) v2Params.completed = args.completed;

              try {
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
                }, lark.withUserAccessToken(userToken));

                if (resp.code === 0) {
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

                // 权限/授权错误 → 降级到 v1
                logger.warn({ code: resp.code, msg: resp.msg }, 'Task v2 list failed, falling back to v1');
              } catch (v2Err) {
                // 网络/SDK 错误也降级
                const axiosCode = (v2Err as { response?: { data?: { code?: number } } })?.response?.data?.code;
                logger.warn({ err: v2Err instanceof Error ? v2Err.message : String(v2Err), axiosCode }, 'Task v2 list error, falling back to v1');
              }
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

          case 'list_tasklists': {
            const tlResp = await client.task.v2.tasklist.list({
              params: {
                page_size: args.page_size ?? 20,
                ...(args.page_token ? { page_token: args.page_token } : {}),
                user_id_type: args.user_id_type ?? 'open_id',
              },
            }, userTokenOpt);
            if (tlResp.code !== 0) throw new Error(`查询任务清单失败 (${tlResp.code}): ${tlResp.msg}`);

            const tasklists = (tlResp.data?.items ?? []).map((tl) => ({
              guid: tl.guid,
              name: tl.name,
              creator_id: tl.creator?.id,
              url: tl.url,
            }));

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  items: tasklists,
                  has_more: tlResp.data?.has_more ?? false,
                  page_token: tlResp.data?.page_token,
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
            // completed_at: 设为当前时间戳 → 标记完成；设为 "0" 或空 → 取消完成
            if (updateFieldsArr.includes('completed_at')) {
              taskData.completed_at = String(Date.now());
            }

            const resp = await client.task.v2.task.patch({
              path: { task_guid: args.task_guid },
              data: {
                task: taskData as { summary?: string },
                update_fields: updateFieldsArr,
              },
              params: { user_id_type: args.user_id_type ?? 'open_id' },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`更新任务失败 (${resp.code}): ${resp.msg}`);
            const updatedParts = ['任务已更新'];
            if (taskData.due) {
              const ts = (taskData.due as { timestamp: string }).timestamp;
              updatedParts.push(`due: ${ts} (${new Date(Number(ts)).toISOString().slice(0, 10)})`);
            }
            if (taskData.start) {
              const ts = (taskData.start as { timestamp: string }).timestamp;
              updatedParts.push(`start: ${ts} (${new Date(Number(ts)).toISOString().slice(0, 10)})`);
            }
            return {
              content: [{
                type: 'text' as const,
                text: updatedParts.join('\n'),
              }],
            };
          }

          case 'delete': {
            if (!args.task_guid) throw new Error('delete 操作需要 task_guid');
            const resp = await client.task.v2.task.delete({
              path: { task_guid: args.task_guid },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`删除任务失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: '任务已删除',
              }],
            };
          }

          case 'add_members': {
            if (!args.task_guid) throw new Error('add_members 操作需要 task_guid');
            if (!args.members) throw new Error('add_members 操作需要 members (JSON 数组)');
            const addMembers = validateMembers(args.members);
            const addResp = await client.task.v2.task.addMembers({
              path: { task_guid: args.task_guid },
              data: { members: addMembers },
              params: { user_id_type: args.user_id_type ?? 'open_id' },
            }, userTokenOpt);
            if (addResp.code !== 0) throw new Error(`添加成员失败 (${addResp.code}): ${addResp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: '成员已添加',
              }],
            };
          }

          case 'remove_members': {
            if (!args.task_guid) throw new Error('remove_members 操作需要 task_guid');
            if (!args.members) throw new Error('remove_members 操作需要 members (JSON 数组)');
            const rmMembers = validateMembers(args.members);
            const rmResp = await client.task.v2.task.removeMembers({
              path: { task_guid: args.task_guid },
              data: { members: rmMembers },
              params: { user_id_type: args.user_id_type ?? 'open_id' },
            }, userTokenOpt);
            if (rmResp.code !== 0) throw new Error(`移除成员失败 (${rmResp.code}): ${rmResp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: '成员已移除',
              }],
            };
          }

          default:
            return { content: [{ type: 'text' as const, text: `未知 action: ${args.action}` }], isError: true };
        }
      } catch (err: unknown) {
        // Extract Feishu API error details from AxiosError response body
        let msg = err instanceof Error ? err.message : String(err);
        const axiosData = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
        if (axiosData?.msg) {
          msg = `飞书 API 错误 (${axiosData.code}): ${axiosData.msg}`;
        }
        logger.error({ err: msg, action: args.action }, 'feishu_task tool error');
        return { content: [{ type: 'text' as const, text: `错误: ${msg}` }], isError: true };
      }
    },
  );
}
