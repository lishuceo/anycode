/**
 * 飞书消息卡片构建器
 * 用于构建执行状态卡片、结果卡片等
 */

import { PHASE_META, TOTAL_PHASES } from '../pipeline/types.js';
import type { PipelinePhase } from '../pipeline/types.js';
import type { TurnInfo, ToolCallInfo } from '../claude/types.js';

/** 构建 "执行中" 状态卡片 */
export function buildProgressCard(prompt: string, statusText: string = '正在处理...'): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Claude Code' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**指令:** ${escapeMarkdown(truncate(prompt, 200))}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `⏳ ${statusText}`,
        },
      },
    ],
  };
}

/** 构建 "执行完成" 结果卡片 */
export function buildResultCard(
  prompt: string,
  output: string,
  success: boolean,
  durationStr: string,
  timedOut?: boolean,
): Record<string, unknown> {
  const icon = timedOut ? '⏱️' : success ? '✅' : '❌';
  const status = timedOut ? '执行超时' : success ? '执行完成' : '执行失败';
  const headerTemplate = timedOut ? 'orange' : success ? 'green' : 'red';

  const elements: Record<string, unknown>[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**指令:** ${escapeMarkdown(truncate(prompt, 200))}`,
      },
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: formatOutputAsMarkdown(output),
      },
    },
    { tag: 'hr' },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `${icon} ${status} | ⏱️ ${durationStr}`,
        },
      ],
    },
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🤖 Claude Code - ${status}` },
      template: headerTemplate,
    },
    elements,
  };
}

/** 构建 "执行中" 流式更新卡片（显示实时输出） */
export function buildStreamingCard(
  prompt: string,
  content: string,
  elapsedSec: number,
): Record<string, unknown> {
  // 显示输出末尾 2500 字符，让用户看到最新进展
  const maxLen = 2500;
  const displayContent = content.length > maxLen
    ? '...\n' + content.slice(-maxLen)
    : content;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Claude Code - 执行中' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**指令:** ${escapeMarkdown(truncate(prompt, 200))}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: displayContent.trim() || '⏳ 正在处理...',
        },
      },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `⏳ 执行中 | ⏱️ ${elapsedSec}s`,
          },
        ],
      },
    ],
  };
}

/** 管道中的可执行阶段（排除 done/failed） */
const PIPELINE_PHASES: PipelinePhase[] = ['plan', 'plan_review', 'implement', 'code_review', 'push'];

/** 构建管道进度卡片 */
export function buildPipelineCard(
  prompt: string,
  phase: string,
  phaseIndex: number,
  totalPhases: number,
  elapsedSec: number,
  costUsd?: number,
  detail?: string,
  pipelineId?: string,
): Record<string, unknown> {

  const isDone = phase === 'done';
  const isFailed = phase === 'failed';

  const phaseLines = PIPELINE_PHASES.map((key) => {
    const meta = PHASE_META[key];
    const idx = meta.index;
    if (isDone) return `✅ ${idx}. ${meta.label}`;
    if (isFailed && idx >= phaseIndex) {
      return idx === phaseIndex ? `❌ ${idx}. ${meta.label}` : `⬚ ${idx}. ${meta.label}`;
    }
    if (idx < phaseIndex) return `✅ ${idx}. ${meta.label}`;
    if (idx === phaseIndex) return `🔄 ${idx}. ${meta.label} ← 当前`;
    return `⬚ ${idx}. ${meta.label}`;
  });

  const headerTemplate = isDone ? 'green' : isFailed ? 'red' : 'blue';
  const headerTitle = isDone
    ? '🤖 Claude Code - 管道完成'
    : isFailed
      ? '🤖 Claude Code - 管道失败'
      : '🤖 Claude Code - 自动开发管道';

  const elements: Record<string, unknown>[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**指令:** ${escapeMarkdown(truncate(prompt, 200))}`,
      },
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: phaseLines.join('\n'),
      },
    },
  ];

  if (detail) {
    elements.push({ tag: 'hr' });
    const maxLen = 2000;
    const displayDetail = detail.length > maxLen
      ? '...\n' + detail.slice(-maxLen)
      : detail;
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: displayDetail.trim(),
      },
    });
  }

  // 交互按钮
  if (pipelineId) {
    if (!isDone && !isFailed) {
      // 执行中：添加「中止」按钮
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🛑 中止' },
            type: 'danger',
            confirm: {
              title: { tag: 'plain_text', content: '确认中止' },
              text: { tag: 'plain_text', content: '中止后当前阶段将运行至结束，但不会进入下一阶段。确定要中止吗？' },
            },
            value: { action: 'pipeline_abort', pipelineId },
          },
        ],
      });
    } else if (isFailed) {
      // 失败：添加「重试」按钮
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 重试' },
            type: 'primary',
            value: { action: 'pipeline_retry', pipelineId },
          },
        ],
      });
    }
  }

  elements.push({ tag: 'hr' });

  const costStr = costUsd ? ` | 💰 $${costUsd.toFixed(4)}` : '';
  const statusIcon = isDone ? '✅ 完成' : isFailed ? '❌ 失败' : `⏳ 阶段 ${phaseIndex}/${totalPhases}`;
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `${statusIcon} | ⏱️ ${elapsedSec}s${costStr}`,
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template: headerTemplate,
    },
    elements,
  };
}

/** 构建状态查询结果卡片 */
export function buildStatusCard(
  workingDir: string,
  sessionStatus: string,
  pendingTasks: number,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Claude Code - 会话状态' },
      template: 'indigo',
    },
    elements: [
      {
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: { tag: 'lark_md', content: `**工作目录:**\n${workingDir}` },
          },
          {
            is_short: true,
            text: { tag: 'lark_md', content: `**状态:**\n${sessionStatus}` },
          },
          {
            is_short: true,
            text: { tag: 'lark_md', content: `**排队任务:**\n${pendingTasks}` },
          },
        ],
      },
    ],
  };
}

/** 构建管道确认卡片（/dev 命令后等待用户确认） */
export function buildPipelineConfirmCard(
  prompt: string,
  pipelineId: string,
  workingDir: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Claude Code - 自动开发管道' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**任务:** ${escapeMarkdown(truncate(prompt, 300))}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**工作目录:** ${workingDir}`,
            `**预估查询数:** ~9 次 (最多 17 次，含重试)`,
            `**流程:** 方案设计 → 方案审查 → 代码实现 → 代码审查 → 推送 PR`,
          ].join('\n'),
        },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认执行' },
            type: 'primary',
            value: { action: 'pipeline_confirm', pipelineId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 取消' },
            type: 'default',
            value: { action: 'pipeline_cancel', pipelineId },
          },
        ],
      },
    ],
  };
}

/** 构建管道已取消卡片 */
export function buildCancelledCard(prompt: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Claude Code - 已取消' },
      template: 'grey',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**指令:** ${escapeMarkdown(truncate(prompt, 200))}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: '❌ 用户已取消' },
        ],
      },
    ],
  };
}

/** 构建管道中断卡片（服务重启导致中断） */
export function buildInterruptedCard(
  prompt: string,
  pipelineId: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Claude Code - 管道中断' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**指令:** ${escapeMarkdown(truncate(prompt, 200))}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '⚠️ 服务重启，管道已中断',
        },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 重试' },
            type: 'primary',
            value: { action: 'pipeline_retry', pipelineId },
          },
        ],
      },
    ],
  };
}

/** 构建累积 tool call 进度卡片（原地更新） */
export function buildToolProgressCard(
  toolCalls: ToolCallInfo[],
  turnCount: number,
  maxDisplayed: number = 40,
  completed: boolean = false,
): Record<string, unknown> {
  const truncated = toolCalls.length > maxDisplayed;
  const displayed = truncated ? toolCalls.slice(-maxDisplayed) : toolCalls;

  const lines: string[] = [];
  if (truncated) {
    lines.push(`_(前 ${toolCalls.length - maxDisplayed} 条已省略)_`);
  }
  lines.push(...displayed.map(formatToolCall));

  const headerTitle = completed
    ? '🤖 Claude Code - 活动记录'
    : '🤖 Claude Code - 执行中';
  const headerTemplate = completed ? 'indigo' : 'blue';

  const footerParts: string[] = [];
  if (!completed) footerParts.push('⏳ 执行中');
  footerParts.push(`🔄 ${turnCount} 轮`);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template: headerTemplate,
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: lines.join('\n') || '_(无工具调用)_',
        },
      },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: footerParts.join(' | '),
          },
        ],
      },
    ],
  };
}

/** 构建单轮 turn 消息卡片（逐条展示） */
export function buildTurnCard(turn: TurnInfo): Record<string, unknown> {
  const parts: string[] = [];

  // 文字内容（截断 3000 字符）
  if (turn.textContent) {
    const maxLen = 3000;
    const text = turn.textContent.length > maxLen
      ? turn.textContent.slice(0, maxLen) + '\n\n_(内容过长，已截断)_'
      : turn.textContent;
    parts.push(text.trim());
  }

  // 工具调用列表
  if (turn.toolCalls.length > 0) {
    const toolLines = turn.toolCalls.map(formatToolCall);
    parts.push(toolLines.join('\n'));
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `Turn ${turn.turnIndex}` },
      template: 'default',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: parts.join('\n\n') || '_(无内容)_',
        },
      },
    ],
  };
}

/** 话题概览卡片状态 */
export type OverviewState = 'processing' | 'success' | 'error';

/** 构建话题概览卡片（置顶，随查询状态更新） */
export function buildOverviewCard(
  prompt: string,
  state: OverviewState,
  turnCount: number,
  elapsedSec: number,
  costUsd?: number,
): Record<string, unknown> {
  const stateConfig = {
    processing: { template: 'blue',  icon: '⏳', label: '处理中' },
    success:    { template: 'green', icon: '✅', label: '完成' },
    error:      { template: 'red',   icon: '❌', label: '失败' },
  }[state];
  const costStr = costUsd ? ` | 💰 $${costUsd.toFixed(4)}` : '';

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Claude Code' },
      template: stateConfig.template,
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**指令:** ${escapeMarkdown(truncate(prompt, 200))}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `${stateConfig.icon} ${stateConfig.label} | 🔄 ${turnCount} 轮 | ⏱️ ${elapsedSec}s${costStr}`,
          },
        ],
      },
    ],
  };
}

/** 构建底部结果卡片（逐条模式用，最后一轮内容合并进来，指令已在顶部概览中） */
export function buildSimpleResultCard(
  _prompt: string,
  success: boolean,
  durationStr: string,
  error?: string,
  lastTurn?: TurnInfo,
): Record<string, unknown> {
  const icon = success ? '✅' : '❌';
  const status = success ? '执行完成' : '执行失败';
  const headerTemplate = success ? 'green' : 'red';

  const elements: Record<string, unknown>[] = [];

  // 合并最后一轮 turn 的内容
  if (lastTurn) {
    const parts: string[] = [];
    if (lastTurn.textContent) {
      const maxLen = 3000;
      const text = lastTurn.textContent.length > maxLen
        ? lastTurn.textContent.slice(0, maxLen) + '\n\n_(内容过长，已截断)_'
        : lastTurn.textContent;
      parts.push(text.trim());
    }
    if (lastTurn.toolCalls.length > 0) {
      parts.push(lastTurn.toolCalls.map(formatToolCall).join('\n'));
    }
    if (parts.length > 0) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: parts.join('\n\n'),
        },
      });
    }
  }

  // 失败时显示错误信息
  if (!success && error) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: truncate(error, 1000),
      },
    });
  }

  if (elements.length > 0) elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `${icon} ${status} | ⏱️ ${durationStr}`,
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🤖 Claude Code - ${status}` },
      template: headerTemplate,
    },
    elements,
  };
}

/** 工具调用 → 图标 + 摘要 */
const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Bash: '💻',
  Glob: '🔍',
  Grep: '🔍',
  setup_workspace: '📦',
};

function formatToolCall(tool: ToolCallInfo): string {
  const icon = TOOL_ICONS[tool.name] ?? '🔧';

  switch (tool.name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${icon} **${tool.name}** ${(tool.input.file_path as string) ?? ''}`;
    case 'Bash': {
      const cmd = String(tool.input.command ?? '');
      const display = cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
      return `${icon} \`${display}\``;
    }
    case 'Glob':
      return `${icon} **Glob** ${(tool.input.pattern as string) ?? ''}`;
    case 'Grep':
      return `${icon} **Grep** ${(tool.input.pattern as string) ?? ''}`;
    case 'setup_workspace':
      return `${icon} **setup_workspace** ${(tool.input.repo_url as string) ?? (tool.input.local_path as string) ?? ''}`;
    default:
      return `${icon} **${tool.name}**`;
  }
}

// === 工具函数 ===

function escapeMarkdown(text: string): string {
  // 飞书 lark_md 中需要转义的字符较少
  return text.replace(/\*/g, '\\*').replace(/_/g, '\\_');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

/** 将 Claude Code 输出格式化为飞书 lark_md 格式 */
function formatOutputAsMarkdown(output: string): string {
  if (!output) return '_(无输出)_';

  // 飞书卡片内容长度限制约 30000 字符，但太长影响阅读
  const maxLen = 3000;
  const truncated = output.length > maxLen;
  const text = truncated ? output.slice(0, maxLen) : output;

  const result = text
    // 不需要额外处理，lark_md 支持基本 markdown
    .trim();

  return truncated ? result + '\n\n_(输出过长，已截断)_' : result;
}
