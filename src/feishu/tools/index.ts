import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../config.js';
import { feishuDocTool } from './doc.js';
import { feishuWikiTool } from './wiki.js';
import { feishuDriveTool } from './drive.js';
import { feishuBitableTool } from './bitable.js';
import { feishuChatTool } from './chat.js';
import { feishuTaskTool } from './task.js';
import { feishuContactTool } from './contact.js';
import { feishuCalendarTool } from './calendar.js';
import { feishuMainChatTool } from './main-chat.js';
import { feishuMessageFileTool } from './message.js';
import { getValidUserToken } from '../oauth.js';

/**
 * 创建飞书工具 MCP 服务器
 *
 * 根据配置子开关组装工具列表，始终包含消息文件按需下载工具。
 *
 * @param chatId  当前会话的群 chat_id，用于创建文档后自动授权群成员
 * @param userId  当前用户的 open_id，用于获取 user_access_token
 */
export function createFeishuToolsMcpServer(chatId?: string, userId?: string) {
  const tools = [];
  if (config.feishu.tools.doc) tools.push(feishuDocTool(chatId));
  if (config.feishu.tools.wiki) tools.push(feishuWikiTool());
  if (config.feishu.tools.drive) tools.push(feishuDriveTool(chatId));
  if (config.feishu.tools.bitable) tools.push(feishuBitableTool());
  if (config.feishu.tools.chat) tools.push(feishuChatTool(chatId));
  // 通过闭包绑定当前用户的 token 获取函数，contact/task/calendar 工具可透明使用 user_access_token
  // 同时传入 userId，用于创建任务时自动将发起人加为关注者
  const getUserToken = userId ? () => getValidUserToken(userId) : undefined;
  if (config.feishu.tools.contact) tools.push(feishuContactTool(getUserToken));
  if (config.feishu.tools.task) tools.push(feishuTaskTool(getUserToken, userId));
  if (config.feishu.tools.calendar) tools.push(feishuCalendarTool(getUserToken, userId));

  // 主聊天发送工具：agent 在话题内时可自主决定将重要结果发到群主聊天
  if (chatId) tools.push(feishuMainChatTool(chatId));

  // 消息文件按需下载工具：配合 lazy loading，agent 可按需获取历史消息中的文件
  tools.push(feishuMessageFileTool());

  return createSdkMcpServer({
    name: 'feishu-tools',
    version: '1.0.0',
    tools,
  });
}
