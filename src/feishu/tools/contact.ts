import { tool } from '@anthropic-ai/claude-agent-sdk';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';

/**
 * 飞书通讯录 MCP 工具
 *
 * 根据 open_id 查询用户基本信息，或按姓名搜索用户获取 open_id。
 *
 * 权限要求：
 * - get_user: contact:user.base:readonly，通讯录范围覆盖目标用户
 * - search_user: search:user (需用户 OAuth 授权)
 *
 * @param getUserToken 可选，返回当前用户的 user_access_token（search_user 需要）
 */
export function feishuContactTool(getUserToken?: () => Promise<string | undefined>) {
  return tool(
    'feishu_contact',
    [
      '查询飞书用户信息（通讯录）。',
      '',
      'Actions:',
      '- get_user: 根据 open_id 获取用户详细信息（姓名、头像、部门、职位等）',
      '- search_user: 按姓名搜索用户（返回匹配的用户列表及 open_id）',
      '',
      '权限要求: 飞书后台需授予 contact:user.base:readonly 权限，通讯录范围需覆盖目标用户。',
      'search_user 需要用户 OAuth 授权（search:user 权限）。如未授权，请在聊天中发送 /auth 完成授权。',
    ].join('\n'),
    {
      action: z.enum(['get_user', 'search_user']).describe('操作类型'),
      open_id: z.string().optional().describe('用户的 open_id (get_user 时必填)'),
      query: z.string().optional().describe('搜索关键词，如用户姓名 (search_user 时必填)'),
      page_size: z.number().optional().describe('每页结果数 (search_user，默认 20，最大 200)'),
    },
    async (args) => {
      const { action, open_id, query, page_size } = args;

      if (action === 'get_user') {
        if (!open_id) {
          return {
            content: [{ type: 'text' as const, text: '缺少参数: open_id' }],
            isError: true,
          };
        }

        try {
          const resp = await feishuClient.raw.contact.user.get({
            path: { user_id: open_id },
            params: { user_id_type: 'open_id' },
          });

          if (resp.code !== 0) {
            logger.warn({ code: resp.code, msg: resp.msg, open_id }, 'feishu_contact get_user API error');
            return {
              content: [{ type: 'text' as const, text: `查询失败 (code ${resp.code}): ${resp.msg}` }],
              isError: true,
            };
          }

          const user = resp.data?.user;
          if (!user) {
            return {
              content: [{ type: 'text' as const, text: `未找到用户: ${open_id}` }],
              isError: true,
            };
          }

          // 组装可读输出
          const lines: string[] = [];
          lines.push(`姓名: ${user.name ?? '—'}`);
          if (user.en_name) lines.push(`英文名: ${user.en_name}`);
          if (user.avatar?.avatar_origin || user.avatar?.avatar_240) {
            lines.push(`头像: ${user.avatar.avatar_origin || user.avatar.avatar_240}`);
          }
          if (user.department_ids?.length) {
            lines.push(`部门 ID: ${user.department_ids.join(', ')}`);
          }
          if (user.job_title) lines.push(`职位: ${user.job_title}`);
          if (user.city) lines.push(`城市: ${user.city}`);
          if (user.employee_no) lines.push(`工号: ${user.employee_no}`);
          lines.push(`open_id: ${user.open_id ?? open_id}`);
          if (user.union_id) lines.push(`union_id: ${user.union_id}`);
          if (user.user_id) lines.push(`user_id: ${user.user_id}`);

          logger.info({ open_id, name: user.name }, 'feishu_contact get_user success');

          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
          };
        } catch (err: unknown) {
          // 飞书 SDK 在 HTTP 4xx 时抛 axios 异常，响应体在 err.response.data
          const axiosData = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
          const detail = axiosData?.code
            ? `飞书 API 错误 (code ${axiosData.code}): ${axiosData.msg ?? '未知'}`
            : (err instanceof Error ? err.message : String(err));
          logger.error({ err: detail, open_id, feishuCode: axiosData?.code }, 'feishu_contact get_user failed');
          return {
            content: [{ type: 'text' as const, text: `查询用户失败: ${detail}` }],
            isError: true,
          };
        }
      }

      if (action === 'search_user') {
        if (!query) {
          return {
            content: [{ type: 'text' as const, text: '缺少参数: query (搜索关键词)' }],
            isError: true,
          };
        }

        const userToken = getUserToken ? await getUserToken() : undefined;
        if (!userToken) {
          return {
            content: [{ type: 'text' as const, text: '搜索用户需要用户授权。请在聊天中发送 /auth 完成 OAuth 授权后重试。' }],
            isError: true,
          };
        }

        try {
          const resp = await feishuClient.raw.request<{
            code?: number;
            msg?: string;
            data?: {
              users?: Array<{
                open_id?: string;
                name?: string;
                en_name?: string;
                department_ids?: string[];
                avatar?: { avatar_72?: string };
              }>;
              has_more?: boolean;
              page_token?: string;
            };
          }>({
            method: 'POST',
            url: '/open-apis/search/v2/user',
            data: {
              query,
              page_size: Math.min(page_size ?? 20, 200),
            },
          }, lark.withUserAccessToken(userToken));

          if (resp.code !== 0) {
            logger.warn({ code: resp.code, msg: resp.msg, query }, 'feishu_contact search_user API error');
            return {
              content: [{ type: 'text' as const, text: `搜索失败 (code ${resp.code}): ${resp.msg}` }],
              isError: true,
            };
          }

          const users = resp.data?.users ?? [];
          if (users.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `未找到匹配 "${query}" 的用户` }],
            };
          }

          const lines: string[] = [`搜索 "${query}" 找到 ${users.length} 个用户:`, ''];
          for (const u of users) {
            const parts = [`${u.name ?? '—'}`];
            if (u.en_name) parts.push(`(${u.en_name})`);
            parts.push(`— open_id: ${u.open_id ?? '—'}`);
            lines.push(parts.join(' '));
          }
          if (resp.data?.has_more) {
            lines.push('', '(还有更多结果，可增大 page_size 获取)');
          }

          logger.info({ query, resultCount: users.length }, 'feishu_contact search_user success');

          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
          };
        } catch (err: unknown) {
          const axiosData = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
          const detail = axiosData?.code
            ? `飞书 API 错误 (code ${axiosData.code}): ${axiosData.msg ?? '未知'}`
            : (err instanceof Error ? err.message : String(err));
          logger.error({ err: detail, query, feishuCode: axiosData?.code }, 'feishu_contact search_user failed');
          return {
            content: [{ type: 'text' as const, text: `搜索用户失败: ${detail}` }],
            isError: true,
          };
        }
      }

      return {
        content: [{ type: 'text' as const, text: `未知操作: ${action}` }],
        isError: true,
      };
    },
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
  );
}
