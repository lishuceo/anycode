/**
 * 自配置 MCP 工具 — manage_config
 *
 * 让 anycode 在 owner 授权下编辑「自己的」运行配置：agents.json（模型/工具策略/
 * bindings/预算）、人设、知识、.env、以及 ~/.claude.json 里的 MCP server。
 *
 * 安全边界：
 * - owner 门禁：整只工具仅 OWNER_USER_ID 可用（配置含 appSecret / API key 等机密）
 * - 白名单：只能改固定几类配置文件，杜绝路径穿越与源码改动
 * - 写前校验：agents.json 走 Zod，.env 走行格式校验，非法内容不落盘
 * - 自动备份：每次写入前备份到 data/config-backups/，可回滚
 *
 * 生效方式：agents.json / 人设 / 知识 热加载即时生效；.env / MCP 需重启服务。
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { isOwner } from '../utils/security.js';
import {
  listTargets,
  readConfig,
  writeConfig,
  getMcpServer,
  setMcpServer,
  removeMcpServer,
  type WriteResult,
} from './manager.js';

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}
function error(message: string) {
  return { content: [{ type: 'text' as const, text: `错误: ${message}` }], isError: true };
}

/** 写入成功后的统一回执（含生效提示） */
function writeReceipt(r: WriteResult): string {
  const lines = [`✅ 已写入 ${r.label}`, `   路径: ${r.absPath}`];
  if (r.backup) lines.push(`   备份: ${r.backup}`);
  if (r.effect === 'hot-reload') {
    if (r.reloaded === false) {
      lines.push(`⚠️ 已落盘但热加载失败(已保留旧配置生效): ${r.reloadError ?? '未知错误'}`);
      lines.push('   请修正后重新写入。');
    } else {
      lines.push('🔄 热加载已生效，无需重启。');
    }
  } else {
    lines.push('⚠️ 此改动需重启服务才能生效（.env / MCP 仅在启动时加载）。');
    lines.push('   完成后我会在最后一步执行 pm2 restart feishu-claude 让它生效。');
  }
  return lines.join('\n');
}

/**
 * 创建自配置 MCP 服务器。通过闭包绑定当前 userId 做 owner 门禁。
 * 调用方（executor）应仅在 isOwner(userId) 时创建本服务器。
 */
export function createConfigAdminMcpServer(params: { userId: string }) {
  const { userId } = params;

  return createSdkMcpServer({
    name: 'self-config',
    version: '1.0.0',
    tools: [
      tool(
        'manage_config',
        [
          '编辑 anycode 服务自身的运行配置（自改自）。改的是运行实例真实读取的 LIVE 配置。',
          '',
          '⚠️ 仅管理员(owner)可用。',
          '',
          'Actions:',
          '- list: 列出所有可编辑目标（配置文件 + 已配置的 MCP server）',
          '- read: 读取某个配置文件内容（target 必填）',
          '- write: 覆盖写入某个配置文件（target + content 必填，先读后改再整份写回）',
          '- set_mcp: 新增/更新一个 MCP server（mcp_name + mcp_config 必填）',
          '- remove_mcp: 删除一个 MCP server（mcp_name 必填）',
          '',
          '可写 target（白名单）:',
          '- agents.json     → 模型/工具策略/bindings/预算等（写前 Zod 校验，热加载即时生效）',
          '- personas/<f>.md → 人设提示词（热加载，每次 query 重读）',
          '- knowledge/<f>.md→ 知识文件（热加载，每次 query 重读）',
          '- .env            → 环境变量（KEY=VALUE，⚠️ 需重启生效）',
          '',
          'MCP server（~/.claude.json 的 mcpServers 段，⚠️ 需重启生效）:',
          '- set_mcp 只改指定 server，保留其它 server 与顶层其它键；mcp_config 为该 server 的 JSON 对象',
          '  （如 {"type":"http","url":"https://...","headers":{"Authorization":"Bearer xxx"}}）',
          '',
          '用法建议：write 前先 read 拿到当前完整内容，本地改好再整份写回（write 是覆盖语义）。',
          '所有写入自动备份到 data/config-backups/，可回滚。',
        ].join('\n'),
        {
          action: z.enum(['list', 'read', 'write', 'set_mcp', 'remove_mcp']).describe('操作类型'),
          target: z.string().optional().describe('配置文件目标（read/write 必填）: agents.json | personas/<f>.md | knowledge/<f>.md | .env'),
          content: z.string().optional().describe('write 时的完整新内容（覆盖写入）'),
          mcp_name: z.string().optional().describe('MCP server 名称（set_mcp/remove_mcp 必填）'),
          mcp_config: z.record(z.string(), z.unknown()).optional().describe('MCP server 配置 JSON 对象（set_mcp 必填）'),
        },
        async (args) => {
          // ── owner 门禁（防御性二次校验，创建时已 gate） ──
          if (!isOwner(userId)) {
            logger.warn({ userId, action: args.action }, 'manage_config denied — not owner');
            return error('仅管理员可以编辑服务配置。');
          }

          logger.info({ action: args.action, target: args.target, mcp_name: args.mcp_name }, 'manage_config invoked');

          try {
            switch (args.action) {
              case 'list': {
                const targets = listTargets();
                const files = targets.filter((t) => t.kind === 'file');
                const mcps = targets.filter((t) => t.kind === 'mcp');
                const fmt = (label: string, effect: string, exists: boolean) =>
                  `${exists ? '•' : '○'} ${label}  [${effect === 'hot-reload' ? '热加载' : '需重启'}]${exists ? '' : ' (不存在)'}`;
                const lines = ['可编辑配置文件:'];
                for (const t of files) lines.push('  ' + fmt(t.label, t.effect, t.exists));
                lines.push('', `已配置 MCP server (${mcps.length}):`);
                if (mcps.length === 0) lines.push('  (无)');
                for (const t of mcps) lines.push('  ' + fmt(t.label, t.effect, t.exists));
                return text(lines.join('\n'));
              }

              case 'read': {
                if (!args.target) return error('read 需要 target 参数');
                const reason: { msg?: string } = {};
                const content = readConfig(args.target, reason);
                if (content === null) return error(reason.msg ?? '无法读取');
                return text(`# ${args.target}\n\n${content}`);
              }

              case 'write': {
                if (!args.target) return error('write 需要 target 参数');
                if (typeof args.content !== 'string') return error('write 需要 content 参数（完整新内容）');
                const outcome = writeConfig(args.target, args.content);
                if (!outcome.ok) return error(outcome.error);
                return text(writeReceipt(outcome.result));
              }

              case 'set_mcp': {
                if (!args.mcp_name) return error('set_mcp 需要 mcp_name 参数');
                if (!args.mcp_config) return error('set_mcp 需要 mcp_config 参数（该 server 的 JSON 对象）');
                const outcome = setMcpServer(args.mcp_name, args.mcp_config);
                if (!outcome.ok) return error(outcome.error);
                return text(writeReceipt(outcome.result));
              }

              case 'remove_mcp': {
                if (!args.mcp_name) return error('remove_mcp 需要 mcp_name 参数');
                if (!getMcpServer(args.mcp_name)) return error(`MCP server 不存在: ${args.mcp_name}`);
                const outcome = removeMcpServer(args.mcp_name);
                if (!outcome.ok) return error(outcome.error);
                return text(writeReceipt(outcome.result));
              }

              default:
                return error(`未知操作: ${args.action}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ err: msg, action: args.action }, 'manage_config failed');
            return error(msg);
          }
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
      ),
    ],
  });
}
