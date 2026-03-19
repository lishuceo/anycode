import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import type { CronScheduler } from './scheduler.js';
import type { CronSchedule } from './types.js';

/**
 * 创建 Cron 管理 MCP 服务器
 *
 * 通过闭包绑定当前 chat 的 chatId/userId，确保任务归属正确。
 */
export function createCronMcpServer(params: {
  scheduler: CronScheduler;
  chatId: string;
  userId: string;
  agentId?: string;
  accountId?: string;
  threadId?: string;
  threadRootMessageId?: string;
}) {
  const { scheduler, chatId, userId, agentId, accountId, threadId, threadRootMessageId } = params;

  return createSdkMcpServer({
    name: 'cron-scheduler',
    version: '1.0.0',
    tools: [
      tool(
        'manage_cron',
        [
          '管理定时任务（cron jobs）。支持创建、列出、更新、删除定时任务。',
          '',
          'Actions:',
          '- list: 列出当前群聊的所有定时任务',
          '- add: 创建新的定时任务',
          '- update: 更新已有任务（需要 id）',
          '- remove: 删除任务（需要 id）',
          '- trigger: 立即执行一次任务（需要 id）',
          '',
          'Schedule 格式:',
          '- cron 表达式: schedule="0 9 * * *" (每天9点)',
          '- 固定间隔: schedule_kind="every", every_ms=3600000 (每小时)',
          '- 一次性: schedule_kind="at", at="2026-03-18T10:00:00" (指定时间)',
          '',
          '默认时区为 Asia/Shanghai。',
        ].join('\n'),
        {
          action: z.enum(['list', 'add', 'update', 'remove', 'trigger']).describe('操作类型'),
          id: z.string().optional().describe('任务 ID（update/remove/trigger 必填）'),
          name: z.string().optional().describe('任务名称（add 必填）'),
          prompt: z.string().optional().describe('agent 执行的指令（add 必填）'),
          schedule: z.string().optional().describe('cron 表达式（如 "0 9 * * *"，add 时默认方式）'),
          schedule_kind: z.enum(['cron', 'every', 'at']).optional().describe('调度类型（默认 cron）'),
          every_ms: z.number().optional().describe('固定间隔毫秒数（kind=every 时使用）'),
          at: z.string().optional().describe('一次性执行的 ISO 时间（kind=at 时使用）'),
          timezone: z.string().optional().describe('时区（默认 Asia/Shanghai）'),
          enabled: z.boolean().optional().describe('是否启用（默认 true）'),
          bind_thread: z.boolean().optional().describe('是否绑定到当前话题（默认 true，执行结果发到当前话题）'),
          context_snapshot: z.string().optional().describe('上下文快照（创建时记录关键信息，如 repo、PR 号等）'),
        },
        async (args) => {
          logger.info({ action: args.action, id: args.id, name: args.name }, 'manage_cron tool invoked');

          try {
            switch (args.action) {
              case 'list': {
                const jobs = scheduler.listJobs({ chatId });
                if (jobs.length === 0) {
                  return text('当前群聊没有定时任务。');
                }
                const lines = jobs.map((job) => {
                  const status = job.enabled ? '✅' : '⏸️';
                  const schedule = formatSchedule(job.schedule);
                  const lastRun = job.state.lastRunAtMs
                    ? `上次: ${new Date(job.state.lastRunAtMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
                    : '从未执行';
                  const nextRun = job.state.nextRunAtMs
                    ? `下次: ${new Date(job.state.nextRunAtMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
                    : '';
                  return `${status} **${job.name}** (${job.id})\n   ${schedule} | ${lastRun} | ${nextRun}\n   指令: ${job.prompt.slice(0, 80)}${job.prompt.length > 80 ? '...' : ''}`;
                });
                return text(`当前群聊有 ${jobs.length} 个定时任务:\n\n${lines.join('\n\n')}`);
              }

              case 'add': {
                if (!args.name) return error('name 参数必填');
                if (!args.prompt) return error('prompt 参数必填');

                const schedule = buildSchedule(args);
                if (!schedule) return error('无法解析调度配置。需要 schedule (cron 表达式)、every_ms (间隔) 或 at (时间)');

                const bindThread = args.bind_thread !== false;

                const job = await scheduler.addJob({
                  name: args.name,
                  chatId,
                  userId,
                  agentId,
                  accountId,
                  prompt: args.prompt,
                  schedule,
                  enabled: args.enabled,
                  threadId: bindThread ? threadId : undefined,
                  threadRootMessageId: bindThread ? threadRootMessageId : undefined,
                  contextSnapshot: args.context_snapshot,
                });

                const nextRun = job.state.nextRunAtMs
                  ? new Date(job.state.nextRunAtMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
                  : '未计算';

                return text([
                  `定时任务已创建`,
                  `ID: ${job.id}`,
                  `名称: ${job.name}`,
                  `调度: ${formatSchedule(job.schedule)}`,
                  `下次执行: ${nextRun}`,
                  bindThread && threadId ? `绑定话题: 是` : `绑定话题: 否（结果发到群顶层）`,
                ].join('\n'));
              }

              case 'update': {
                if (!args.id) return error('id 参数必填');

                // Ownership check: only the job creator or same-chat users can modify
                const updateTarget = scheduler.listJobs({ chatId }).find((j) => j.id === args.id);
                if (!updateTarget) return error(`任务不存在: ${args.id}`);
                if (updateTarget.userId !== userId) return error('只有任务创建者才能修改此任务');

                const patch: Record<string, unknown> = {};
                if (args.name) patch.name = args.name;
                if (args.prompt) patch.prompt = args.prompt;
                if (args.enabled !== undefined) patch.enabled = args.enabled;
                if (args.context_snapshot) patch.contextSnapshot = args.context_snapshot;

                const schedule = buildSchedule(args);
                if (schedule) patch.schedule = schedule;

                const job = await scheduler.updateJob(args.id, patch);
                if (!job) return error(`任务不存在: ${args.id}`);

                return text(`任务已更新: ${job.name} (${job.id})`);
              }

              case 'remove': {
                if (!args.id) return error('id 参数必填');
                const removeTarget = scheduler.listJobs({ chatId }).find((j) => j.id === args.id);
                if (!removeTarget) return error(`任务不存在: ${args.id}`);
                if (removeTarget.userId !== userId) return error('只有任务创建者才能删除此任务');
                const removed = await scheduler.removeJob(args.id);
                return removed
                  ? text(`任务已删除: ${args.id}`)
                  : error(`任务不存在: ${args.id}`);
              }

              case 'trigger': {
                if (!args.id) return error('id 参数必填');
                const triggerTarget = scheduler.listJobs({ chatId }).find((j) => j.id === args.id);
                if (!triggerTarget) return error(`任务不存在: ${args.id}`);
                if (triggerTarget.userId !== userId) return error('只有任务创建者才能触发此任务');
                await scheduler.triggerJob(args.id);
                return text(`任务已触发执行: ${args.id}`);
              }

              default:
                return error(`未知操作: ${args.action}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ err: msg, action: args.action }, 'manage_cron failed');
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

// ── Helpers ──

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

function error(message: string) {
  return { content: [{ type: 'text' as const, text: `错误: ${message}` }], isError: true };
}

function buildSchedule(args: {
  schedule?: string;
  schedule_kind?: 'cron' | 'every' | 'at';
  every_ms?: number;
  at?: string;
  timezone?: string;
}): CronSchedule | null {
  const kind = args.schedule_kind || (args.schedule ? 'cron' : args.every_ms ? 'every' : args.at ? 'at' : null);
  if (!kind) return null;

  switch (kind) {
    case 'cron':
      return args.schedule
        ? { kind: 'cron', expr: args.schedule, tz: args.timezone || 'Asia/Shanghai' }
        : null;
    case 'every': {
      if (!args.every_ms) return null;
      const MIN_INTERVAL_MS = 30_000; // 30s floor to prevent abuse
      const everyMs = Math.max(args.every_ms, MIN_INTERVAL_MS);
      return { kind: 'every', everyMs };
    }
    case 'at':
      return args.at
        ? { kind: 'at', atTime: args.at }
        : null;
    default:
      return null;
  }
}

function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'cron':
      return `cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
    case 'every': {
      const ms = schedule.everyMs ?? 0;
      if (ms >= 3600_000) return `每 ${ms / 3600_000} 小时`;
      if (ms >= 60_000) return `每 ${ms / 60_000} 分钟`;
      return `每 ${ms / 1000} 秒`;
    }
    case 'at':
      return `一次性: ${schedule.atTime}`;
    default:
      return '未知';
  }
}
