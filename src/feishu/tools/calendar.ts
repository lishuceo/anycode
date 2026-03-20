import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as lark from '@larksuiteoapi/node-sdk';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';
import { validateToken } from './validation.js';

// ============================================================
// 飞书日历 (Calendar) MCP 工具
//
// 支持操作: list_calendars / list_events / get_event /
//           create_event / update_event / delete_event / freebusy
// 使用 @larksuiteoapi/node-sdk 的 client.calendar.* API
// ============================================================

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/**
 * 将用户输入的时间字符串解析为秒级 Unix 时间戳字符串。
 *
 * 飞书 Calendar API 的 TimeInfo.timestamp 使用秒级时间戳（10 位字符串）。
 *
 * 与 task.ts 的 parseDueDate 不同之处:
 * - 允许过去时间（查询历史日程）
 * - 返回秒级时间戳（日历 API 用秒级）
 */
export function parseCalendarTime(input: string): string {
  const trimmed = input.trim();
  let ms: number;

  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (num > 1_000_000_000 && num < 10_000_000_000) {
      // 秒级时间戳 → 直接返回
      return trimmed;
    } else if (num > 1_000_000_000_000 && num < 10_000_000_000_000) {
      // 毫秒级时间戳 → 转秒
      return String(Math.floor(num / 1000));
    }
    throw new Error(`无效的时间戳: ${trimmed}（秒级时间戳应在 1e9 ~ 1e10 范围内）`);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    ms = new Date(trimmed + 'T00:00:00+08:00').getTime();
    if (isNaN(ms)) throw new Error(`无效的日期: ${trimmed}`);
  } else {
    let dateStr = trimmed;
    // 无时区的 ISO datetime → 默认 +08:00
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(dateStr)) {
      dateStr += '+08:00';
    }
    ms = new Date(dateStr).getTime();
    if (isNaN(ms)) throw new Error(`无效的日期格式: ${trimmed}`);
  }

  return String(Math.floor(ms / 1000));
}

/**
 * 构建飞书日历 API 的 TimeInfo 对象
 */
function buildTimeInfo(timeStr: string, isAllDay?: boolean): Record<string, string> {
  if (isAllDay) {
    // 全天日程: 使用 date 格式 "YYYY-MM-DD"
    const trimmed = timeStr.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return { date: trimmed };
    }
    // 从时间戳或 ISO 提取日期部分
    const ts = parseCalendarTime(timeStr);
    return { date: new Date(Number(ts) * 1000).toISOString().slice(0, 10) };
  }
  // 非全天: 使用 timestamp + timezone
  return { timestamp: parseCalendarTime(timeStr), timezone: DEFAULT_TIMEZONE };
}

/**
 * 校验 attendees JSON 字符串
 *
 * 格式: [{"type": "user", "user_id": "ou_xxx"}, {"type": "third_party", "user_id": "email@example.com"}]
 */
function validateAttendees(jsonStr: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('attendees 不是有效的 JSON 字符串');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('attendees 必须是 JSON 数组 (如 [{"type": "user", "user_id": "ou_xxx"}])');
  }
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('attendees 数组元素必须是对象');
    }
  }
  return parsed as Array<Record<string, unknown>>;
}

/**
 * 校验 user_ids JSON 字符串 (freebusy 查询用)
 */
function validateUserIds(jsonStr: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('user_ids 不是有效的 JSON 字符串');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('user_ids 必须是 JSON 数组 (如 ["ou_xxx", "ou_yyy"])');
  }
  for (const item of parsed) {
    if (typeof item !== 'string') {
      throw new Error('user_ids 元素必须是字符串 (open_id)');
    }
  }
  return parsed as string[];
}

/**
 * 格式化日程的时间信息为人类可读字符串
 */
function formatTimeInfo(info?: { date?: string; timestamp?: string; timezone?: string }): string {
  if (!info) return '(无)';
  if (info.date) return info.date;
  if (info.timestamp) {
    const ts = Number(info.timestamp);
    return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + (info.timezone ? ` (${info.timezone})` : '');
  }
  return '(未知)';
}

/**
 * 飞书日历 MCP 工具
 *
 * @param getUserToken 可选，返回当前用户的 user_access_token。日历操作需要用户授权。
 */
export function feishuCalendarTool(getUserToken?: () => Promise<string | undefined>, _userId?: string) {
  return tool(
    'feishu_calendar',
    [
      '管理飞书日历和日程 (Calendar)。',
      '',
      'Actions:',
      '- list_calendars: 列出用户可访问的日历列表',
      '- list_events: 列出指定时间范围内的日程 (需要 start_time + end_time)',
      '- get_event: 获取日程详情 (需要 calendar_id + event_id)',
      '- create_event: 创建日程 (需要 summary + start_time + end_time)',
      '- update_event: 更新日程 (需要 calendar_id + event_id)',
      '- delete_event: 删除日程 (需要 calendar_id + event_id)',
      '- freebusy: 查询用户忙闲状态 (需要 start_time + end_time + user_ids)',
      '',
      '⚠️ 日历操作需要用户授权。如未授权，请在聊天中发送 /auth 完成授权。',
      '',
      '时间格式: ISO 日期时间 (如 "2026-03-20T10:00:00" 或 "2026-03-20T10:00:00+08:00") 或 Unix 秒级时间戳。',
      '无时区的时间默认按 Asia/Shanghai 处理。',
      '全天日程: 设置 is_all_day=true，时间使用日期格式 (如 "2026-03-20")。',
      'attendees 格式: JSON 数组 \'[{"type": "user", "user_id": "ou_xxx"}]\'',
      'user_ids 格式 (freebusy): JSON 数组 \'["ou_xxx", "ou_yyy"]\'',
    ].join('\n'),
    {
      action: z.enum([
        'list_calendars', 'list_events', 'get_event',
        'create_event', 'update_event', 'delete_event', 'freebusy',
      ]).describe('操作类型'),
      calendar_id: z.string().optional()
        .describe('日历 ID (list_events/get_event/create_event/update_event/delete_event 可选，默认使用主日历)'),
      event_id: z.string().optional()
        .describe('日程 ID (get_event/update_event/delete_event 时必填)'),
      summary: z.string().optional()
        .describe('日程标题 (create_event 时必填)'),
      description: z.string().optional()
        .describe('日程描述'),
      location: z.string().optional()
        .describe('日程地点'),
      start_time: z.string().optional()
        .describe('开始时间: ISO 日期时间 (如 "2026-03-20T10:00:00") 或 Unix 秒级时间戳'),
      end_time: z.string().optional()
        .describe('结束时间: 同 start_time 格式'),
      is_all_day: z.boolean().optional()
        .describe('是否全天日程 (默认 false)'),
      attendees: z.string().optional()
        .describe('参会人 JSON 数组 (如 \'[{"type": "user", "user_id": "ou_xxx"}]\')'),
      user_ids: z.string().optional()
        .describe('查询忙闲的用户 open_id JSON 数组 (freebusy 时必填)'),
      need_notification: z.boolean().optional()
        .describe('删除日程时是否发送通知 (默认 true)'),
      page_size: z.number().optional()
        .describe('每页数量 (list_events 时可选, 默认 50)'),
      page_token: z.string().optional()
        .describe('分页 token'),
    },
    async (args) => {
      const client = feishuClient.raw;
      try {
        if (args.calendar_id) validateToken(args.calendar_id, 'calendar_id');
        if (args.event_id) validateToken(args.event_id, 'event_id');

        // 获取 user_access_token（日历操作需要用户授权）
        const userToken = getUserToken ? await getUserToken() : undefined;
        if (!userToken) {
          return {
            content: [{
              type: 'text' as const,
              text: '日历操作需要用户授权。请在聊天中发送 /auth 完成飞书授权后重试。',
            }],
          };
        }
        const userTokenOpt = lark.withUserAccessToken(userToken);

        /**
         * 获取主日历 ID（当 calendar_id 未指定时使用）
         */
        async function getPrimaryCalendarId(): Promise<string> {
          const resp = await client.calendar.calendar.primary({}, userTokenOpt);
          if (resp.code !== 0) throw new Error(`获取主日历失败 (${resp.code}): ${resp.msg}`);
          const calendarList = (resp.data as { calendars?: Array<{ calendar?: { calendar_id?: string } }> })?.calendars;
          const id = calendarList?.[0]?.calendar?.calendar_id;
          if (!id) throw new Error('未找到主日历');
          return id;
        }

        switch (args.action) {
          case 'list_calendars': {
            const resp = await client.calendar.calendar.list({
              params: {
                page_size: args.page_size ?? 50,
                ...(args.page_token ? { page_token: args.page_token } : {}),
              },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`查询日历列表失败 (${resp.code}): ${resp.msg}`);
            const calendars = (resp.data?.calendar_list ?? []).map((cal) => ({
              calendar_id: cal.calendar_id,
              summary: cal.summary,
              description: cal.description,
              type: cal.type,
              role: cal.role,
              is_primary: cal.type === 'primary',
            }));
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  items: calendars,
                  has_more: resp.data?.has_more ?? false,
                  page_token: resp.data?.page_token,
                }, null, 2),
              }],
            };
          }

          case 'list_events': {
            if (!args.start_time) throw new Error('list_events 需要 start_time');
            if (!args.end_time) throw new Error('list_events 需要 end_time');
            const calId = args.calendar_id || await getPrimaryCalendarId();
            const resp = await client.calendar.calendarEvent.list({
              path: { calendar_id: calId },
              params: {
                start_time: parseCalendarTime(args.start_time),
                end_time: parseCalendarTime(args.end_time),
                page_size: args.page_size ?? 50,
                ...(args.page_token ? { page_token: args.page_token } : {}),
              },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`查询日程列表失败 (${resp.code}): ${resp.msg}`);

            const events = (resp.data?.items ?? []).map((ev) => ({
              event_id: ev.event_id,
              summary: ev.summary,
              start: formatTimeInfo(ev.start_time),
              end: formatTimeInfo(ev.end_time),
              status: ev.status,
              location: ev.location?.name,
            }));
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  calendar_id: calId,
                  items: events,
                  has_more: resp.data?.has_more ?? false,
                  page_token: resp.data?.page_token,
                }, null, 2),
              }],
            };
          }

          case 'get_event': {
            if (!args.event_id) throw new Error('get_event 需要 event_id');
            const calId = args.calendar_id || await getPrimaryCalendarId();
            const resp = await client.calendar.calendarEvent.get({
              path: { calendar_id: calId, event_id: args.event_id },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`获取日程失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data?.event ?? {}, null, 2),
              }],
            };
          }

          case 'create_event': {
            if (!args.summary) throw new Error('create_event 需要 summary (日程标题)');
            if (!args.start_time) throw new Error('create_event 需要 start_time');
            if (!args.end_time) throw new Error('create_event 需要 end_time');
            const calId = args.calendar_id || await getPrimaryCalendarId();

            const data: Record<string, unknown> = {
              summary: args.summary,
              start_time: buildTimeInfo(args.start_time, args.is_all_day),
              end_time: buildTimeInfo(args.end_time, args.is_all_day),
            };
            if (args.description) data.description = args.description;
            if (args.location) data.location = { name: args.location };
            if (args.attendees) data.attendee_ability = 'can_modify_event';

            const resp = await client.calendar.calendarEvent.create({
              path: { calendar_id: calId },
              data: data as { summary: string },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`创建日程失败 (${resp.code}): ${resp.msg}`);

            const event = resp.data?.event;
            const eventId = event?.event_id ?? '(未知)';

            // 添加参会人（需要单独 API 调用）
            if (args.attendees) {
              const attendeeList = validateAttendees(args.attendees);
              try {
                await client.calendar.calendarEventAttendee.create({
                  path: { calendar_id: calId, event_id: eventId },
                  data: { attendees: attendeeList as Array<{ type?: 'user' | 'chat' | 'resource' | 'third_party' }> },
                  params: { user_id_type: 'open_id' },
                }, userTokenOpt);
              } catch (attendeeErr) {
                logger.warn({ err: attendeeErr instanceof Error ? attendeeErr.message : String(attendeeErr) }, 'Failed to add attendees');
              }
            }

            return {
              content: [{
                type: 'text' as const,
                text: [
                  '日程已创建',
                  `event_id: ${eventId}`,
                  `summary: ${event?.summary ?? ''}`,
                  `start: ${formatTimeInfo(event?.start_time)}`,
                  `end: ${formatTimeInfo(event?.end_time)}`,
                  `calendar_id: ${calId}`,
                ].join('\n'),
              }],
            };
          }

          case 'update_event': {
            if (!args.event_id) throw new Error('update_event 需要 event_id');
            const calId = args.calendar_id || await getPrimaryCalendarId();

            const data: Record<string, unknown> = {};
            if (args.summary !== undefined) data.summary = args.summary;
            if (args.description !== undefined) data.description = args.description;
            if (args.location !== undefined) data.location = { name: args.location };
            if (args.start_time) data.start_time = buildTimeInfo(args.start_time, args.is_all_day);
            if (args.end_time) data.end_time = buildTimeInfo(args.end_time, args.is_all_day);

            const resp = await client.calendar.calendarEvent.patch({
              path: { calendar_id: calId, event_id: args.event_id },
              data: data as { summary?: string },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`更新日程失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: '日程已更新',
              }],
            };
          }

          case 'delete_event': {
            if (!args.event_id) throw new Error('delete_event 需要 event_id');
            const calId = args.calendar_id || await getPrimaryCalendarId();
            const resp = await client.calendar.calendarEvent.delete({
              path: { calendar_id: calId, event_id: args.event_id },
              params: { need_notification: args.need_notification ?? true },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`删除日程失败 (${resp.code}): ${resp.msg}`);
            return {
              content: [{
                type: 'text' as const,
                text: '日程已删除',
              }],
            };
          }

          case 'freebusy': {
            if (!args.start_time) throw new Error('freebusy 需要 start_time');
            if (!args.end_time) throw new Error('freebusy 需要 end_time');
            if (!args.user_ids) throw new Error('freebusy 需要 user_ids (JSON 数组)');
            const userIds = validateUserIds(args.user_ids);

            const resp = await client.calendar.freebusy.list({
              data: {
                time_min: parseCalendarTime(args.start_time),
                time_max: parseCalendarTime(args.end_time),
                user_id: userIds[0],
              },
              params: { user_id_type: 'open_id' },
            }, userTokenOpt);
            if (resp.code !== 0) throw new Error(`查询忙闲失败 (${resp.code}): ${resp.msg}`);

            // 多用户查询: 并发请求
            if (userIds.length > 1) {
              const results: Record<string, unknown> = {};
              const responses = await Promise.allSettled(
                userIds.map(async (uid) => {
                  const r = await client.calendar.freebusy.list({
                    data: { time_min: parseCalendarTime(args.start_time!), time_max: parseCalendarTime(args.end_time!), user_id: uid },
                    params: { user_id_type: 'open_id' },
                  }, userTokenOpt);
                  return { uid, data: r.code === 0 ? r.data : { error: r.msg } };
                }),
              );
              for (const r of responses) {
                if (r.status === 'fulfilled') {
                  results[r.value.uid] = r.value.data;
                }
              }
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify(results, null, 2),
                }],
              };
            }

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(resp.data ?? {}, null, 2),
              }],
            };
          }

          default:
            return { content: [{ type: 'text' as const, text: `未知 action: ${args.action}` }], isError: true };
        }
      } catch (err: unknown) {
        let msg = err instanceof Error ? err.message : String(err);
        const axiosData = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
        if (axiosData?.msg) {
          msg = `飞书 API 错误 (${axiosData.code}): ${axiosData.msg}`;
        }
        logger.error({ err: msg, action: args.action }, 'feishu_calendar tool error');
        return { content: [{ type: 'text' as const, text: `错误: ${msg}` }], isError: true };
      }
    },
  );
}
