import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { sessionManager } from '../../session/manager.js';
import { feishuClient } from '../../feishu/client.js';
import { buildGreetingCard } from '../../feishu/message-builder.js';

// ============================================================
// Discussion Thread MCP 工具
//
// 仅在 direct 回复模式下注入。
// 允许 Chat Agent 在运行时判断是否需要创建话题。
// 通过闭包绑定 onThreadCreated 回调，通知调用方切换消息投递目标。
// ============================================================

/** 话题创建回调 */
export interface ThreadCreatedInfo {
  threadRootMsgId: string;
  threadId: string;
}

export interface DiscussionToolParams {
  chatId: string;
  userId: string;
  /** 用户原始消息 ID，用于创建话题的锚点 */
  messageId: string;
  agentId: string;
  /** 话题创建后的回调 — executeDirectTask 通过此回调得知需要切换到话题模式 */
  onThreadCreated: (info: ThreadCreatedInfo) => void;
}

/**
 * 创建 discussion-tools MCP 服务器
 *
 * 提供 start_discussion_thread 工具，允许 Chat Agent 在运行时
 * 从直接回复模式升级为话题模式。
 *
 * 每次 query 创建独立实例，通过闭包绑定 session 回调。
 */
export function createDiscussionMcpServer(params: DiscussionToolParams) {
  let threadCreated = false;

  return createSdkMcpServer({
    name: 'discussion-tools',
    version: '1.0.0',
    tools: [
      tool(
        'start_discussion_thread',
        [
          '创建一个话题（Thread）进行深入的多轮讨论。',
          '',
          '仅在以下情况使用：',
          '1. 话题涉及复杂的多步技术方案，需要来回讨论',
          '2. 分析结果很长（超过 2000 字），不适合直接在群里发',
          '3. 用户明确要求深入讨论',
          '',
          '大多数简单问答、简短分析、快速建议不需要创建话题，直接回复即可。',
          '此工具每次对话只能调用一次。',
        ].join('\n'),
        {
          title: z.string().describe('讨论主题（简短描述，如"架构分析"、"方案讨论"）'),
        },
        async (args) => {
          if (threadCreated) {
            return {
              content: [{
                type: 'text' as const,
                text: '话题已经创建过了，无需重复创建。',
              }],
            };
          }

          logger.info(
            { chatId: params.chatId, userId: params.userId, title: args.title },
            'start_discussion_thread tool invoked',
          );

          try {
            const card = buildGreetingCard();
            const { messageId: botMsgId, threadId } =
              await feishuClient.createThreadWithCard(params.messageId, card);

            if (threadId && botMsgId) {
              threadCreated = true;
              sessionManager.setThread(
                params.chatId, params.userId,
                threadId, params.messageId, params.agentId,
              );
              params.onThreadCreated({
                threadRootMsgId: params.messageId,
                threadId,
              });

              return {
                content: [{
                  type: 'text' as const,
                  text: `话题已创建（主题: ${args.title}）。后续回复将在话题中显示。`,
                }],
              };
            }

            return {
              content: [{
                type: 'text' as const,
                text: '话题创建失败，将继续在当前对话中回复。',
              }],
              isError: true,
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error({ err: errorMsg }, 'start_discussion_thread failed');
            return {
              content: [{
                type: 'text' as const,
                text: `话题创建失败: ${errorMsg}，将继续在当前对话中回复。`,
              }],
              isError: true,
            };
          }
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
          },
        },
      ),
    ],
  });
}
