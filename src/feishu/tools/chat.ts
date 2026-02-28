import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { chatBotRegistry } from '../bot-registry.js';
import { logger } from '../../utils/logger.js';

/**
 * 飞书群成员 MCP 工具
 *
 * 获取当前群聊的成员列表。chatId 通过闭包绑定（与 doc tool 的 chatId 传递模式一致）。
 */
export function feishuChatTool(chatId?: string) {
  return tool(
    'feishu_chat_members',
    [
      '获取当前飞书群聊的成员列表。',
      '',
      '返回群内所有成员的 open_id 和姓名。',
      '同时返回已知的 Bot 列表（通过事件订阅和消息检测发现的 bot）。',
      '适用于需要了解群内有哪些人、哪些 bot、@某人、分配任务等场景。',
      '',
      '无需参数，自动使用当前会话所在群。',
    ].join('\n'),
    {
      // chatId 通过闭包注入，无需用户手动指定
      // 但保留 override 能力，用于跨群查询场景
      chat_id: z.string().optional().describe('群 ID (默认使用当前会话所在群，通常无需指定)'),
    },
    async (args) => {
      const targetChatId = args.chat_id || chatId;
      if (!targetChatId) {
        return {
          content: [{ type: 'text' as const, text: '无法获取群成员：当前不在群聊中，也未指定 chat_id' }],
          isError: true,
        };
      }

      try {
        const members = await feishuClient.getChatMembers(targetChatId);
        logger.info({ chatId: targetChatId, count: members.length }, 'feishu_chat_members tool invoked');

        const lines = members.map((m, i) => `${i + 1}. ${m.name} (${m.memberId})`);

        // 追加已知 Bot 信息
        const knownBots = chatBotRegistry.getBots(targetChatId);
        let botSection = '';
        if (knownBots.length > 0) {
          const botLines = knownBots.map((b, i) =>
            `${i + 1}. ${b.name ?? '[未知名称]'} (${b.openId}) [来源: ${b.source === 'event_added' ? '入群事件' : '消息检测'}]`
          );
          botSection = `\n\n已知 Bot 列表 (共 ${knownBots.length} 个，通过事件订阅和消息检测发现):\n${botLines.join('\n')}`;
        } else {
          botSection = '\n\n已知 Bot 列表: 暂无记录（Bot 发送消息或有新 Bot 入群后会自动发现）';
        }

        return {
          content: [{
            type: 'text' as const,
            text: `群成员列表 (共 ${members.length} 人):\n${lines.join('\n')}${botSection}`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, chatId: targetChatId }, 'feishu_chat_members failed');
        return {
          content: [{ type: 'text' as const, text: `获取群成员失败: ${msg}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnlyHint: true,      // 只读操作
        destructiveHint: false,
        openWorldHint: false,
      },
    },
  );
}
