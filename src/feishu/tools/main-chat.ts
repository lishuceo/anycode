import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { feishuClient } from '../client.js';
import { logger } from '../../utils/logger.js';

/**
 * 发送消息到群主聊天的 MCP 工具
 *
 * 当 agent 在话题中工作时，默认回复只在话题内可见。
 * 此工具让 agent 自主决定是否将重要结果同步发送到群主聊天。
 *
 * 当 threadRootMessageId 可用时，使用 replyText 回复话题根消息，
 * 这样主聊天中的消息会保留对话题的引用（类似飞书"同时发送到群"）。
 */
export function feishuMainChatTool(chatId?: string, threadRootMessageId?: string) {
  return tool(
    'feishu_send_to_chat',
    [
      '将消息发送到群的主聊天（非话题）。',
      '',
      '当你在话题中回复时，消息默认只在话题内可见。',
      '如果你认为某条回复对群内其他成员也有价值（如总结、结论、重要通知），',
      '可以调用此工具将内容同时发送到群主聊天，让所有群成员都能看到。',
      '',
      '使用场景：',
      '- 用户明确要求"发到群里"/"发到主聊天"',
      '- 任务完成的最终总结（面试总结、调研结论等）',
      '- 需要群内其他人看到的重要通知',
      '',
      '不要用于：日常对话、调试信息、中间过程。',
    ].join('\n'),
    {
      text: z.string().describe('要发送到群主聊天的文本内容'),
    },
    async (args) => {
      if (!chatId) {
        return {
          content: [{ type: 'text' as const, text: '无法发送：当前不在群聊中' }],
          isError: true,
        };
      }

      try {
        // 有话题根消息时用 replyText，保留话题关联（类似飞书"同时发送到群"）
        if (threadRootMessageId) {
          await feishuClient.replyText(threadRootMessageId, args.text);
        } else {
          await feishuClient.sendText(chatId, args.text);
        }
        logger.info({ chatId, threadRootMessageId, textLen: args.text.length }, 'feishu_send_to_chat tool invoked');
        return {
          content: [{ type: 'text' as const, text: '已发送到群主聊天' }],
        };
      } catch (err) {
        logger.error({ err, chatId }, 'feishu_send_to_chat failed');
        return {
          content: [{ type: 'text' as const, text: `发送失败: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
