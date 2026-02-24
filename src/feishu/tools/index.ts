import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../config.js';
import { feishuDocTool } from './doc.js';
import { feishuWikiTool } from './wiki.js';
import { feishuDriveTool } from './drive.js';
import { feishuBitableTool } from './bitable.js';

/**
 * 创建飞书工具 MCP 服务器
 *
 * 根据配置子开关组装工具列表。
 * 四个子开关全 false 时返回 undefined（不注入空 MCP 服务器）。
 */
export function createFeishuToolsMcpServer() {
  const tools = [];
  if (config.feishu.tools.doc) tools.push(feishuDocTool());
  if (config.feishu.tools.wiki) tools.push(feishuWikiTool());
  if (config.feishu.tools.drive) tools.push(feishuDriveTool());
  if (config.feishu.tools.bitable) tools.push(feishuBitableTool());

  // 边界条件修复 (review 反馈): 四个子开关全 false 时不注入空 MCP 服务器
  if (tools.length === 0) return undefined;

  return createSdkMcpServer({
    name: 'feishu-tools',
    version: '1.0.0',
    tools,
  });
}
