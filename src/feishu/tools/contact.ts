import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';

/**
 * 飞书通讯录 MCP 工具
 *
 * 根据 open_id 查询用户基本信息（姓名、头像、部门、职位等）。
 * 不依赖群聊上下文，可查询任意用户。
 *
 * 权限要求：飞书后台需授予 contact:user.base:readonly，通讯录范围覆盖目标用户。
 */
export function feishuContactTool() {
  return tool(
    'feishu_contact',
    [
      '查询飞书用户信息（通讯录）。',
      '',
      'Actions:',
      '- get_user: 根据 open_id 获取用户详细信息（姓名、头像、部门、职位等）',
      '',
      '权限要求: 飞书后台需授予 contact:user.base:readonly 权限，通讯录范围需覆盖目标用户。',
    ].join('\n'),
    {
      action: z.enum(['get_user']).describe('操作类型'),
      open_id: z.string().optional().describe('用户的 open_id (get_user 时必填)'),
    },
    async (args) => {
      const { action, open_id } = args;

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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err: msg, open_id }, 'feishu_contact get_user failed');
          return {
            content: [{ type: 'text' as const, text: `查询用户失败: ${msg}` }],
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
