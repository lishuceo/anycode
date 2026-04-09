/**
 * 飞书消息卡片构建器
 * 用于构建执行状态卡片、结果卡片等
 */

import { PHASE_META } from '../pipeline/types.js';
import type { PipelinePhase } from '../pipeline/types.js';
import type { TurnInfo, ToolCallInfo } from '../claude/types.js';
import type { Memory, MemorySearchResult } from '../memory/types.js';
import { MEMORY_PAGE_SIZE } from '../memory/types.js';

/** 构建新会话问候卡片（初始状态） */
export function buildGreetingCard(): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 新会话已创建' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '⏳ 正在启动...',
        },
      },
    ],
  };
}

/** 构建工作区切换卡片（setup_workspace 成功后显示） */
export function buildWorkspaceSwitchCard(
  repoName: string,
  workingDir: string,
  branch?: string,
  title: string = '📂 工作区已切换',
): Record<string, unknown> {
  const fields: Record<string, unknown>[] = [
    {
      is_short: true,
      text: { tag: 'lark_md', content: `**仓库:**\n${repoName}` },
    },
    {
      is_short: true,
      text: { tag: 'lark_md', content: `**分支:**\n${branch ?? 'default'}` },
    },
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'green',
    },
    elements: [
      { tag: 'div', fields },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: workingDir },
        ],
      },
    ],
  };
}

/** 构建 "执行中" 状态卡片 */
export function buildProgressCard(prompt: string, statusText: string = '正在处理...'): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Coding Agent' },
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

  const formattedOutput = formatOutputAsMarkdown(output);
  const outputElement: Record<string, unknown> = {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: formattedOutput,
    },
  };

  const elements: Record<string, unknown>[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**指令:** ${escapeMarkdown(truncate(prompt, 200))}`,
      },
    },
    { tag: 'hr' },
    ...conditionalCollapsible('📋 查看完整回复', [outputElement], formattedOutput),
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
      title: { tag: 'plain_text', content: `🤖 Coding Agent - ${status}` },
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
      title: { tag: 'plain_text', content: '🤖 Coding Agent - 执行中' },
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
const PIPELINE_PHASES: PipelinePhase[] = ['plan', 'plan_review', 'implement', 'code_review', 'push', 'pr_fixup'];

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
  activityStatus?: import('../claude/types.js').ActivityStatus,
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
    ? '🤖 Coding Agent - 管道完成'
    : isFailed
      ? '🤖 Coding Agent - 管道失败'
      : '🤖 Coding Agent - 自动开发管道';

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
  const activityStr = (!isDone && !isFailed && activityStatus)
    ? activityStatus.state === 'thinking'
      ? ' | 🧠 思考中'
      : ` | 🔧 工具调用: ${activityStatus.toolCallCount}`
    : '';
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `${statusIcon}${activityStr} | ⏱️ ${elapsedSec}s${costStr}`,
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
      title: { tag: 'plain_text', content: '🤖 Coding Agent - 会话状态' },
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
      title: { tag: 'plain_text', content: '🤖 Coding Agent - 自动开发管道' },
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
            `**预估查询数:** ~10 次 (最多 18 次，含重试)`,
            `**流程:** 方案设计 → 方案审查 → 代码实现 → 代码审查 → 推送 PR → CI 修复`,
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
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '💡 如按钮不可用，可直接回复「确认」或「取消」',
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
      title: { tag: 'plain_text', content: '🤖 Coding Agent - 已取消' },
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
      title: { tag: 'plain_text', content: '🤖 Coding Agent - 管道中断' },
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
  maxDisplayed: number = 16,
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
    ? '🤖 Coding Agent - 活动记录'
    : '🤖 Coding Agent - 执行中';
  const headerTemplate = completed ? 'indigo' : 'blue';

  const footerParts: string[] = [];
  if (!completed) footerParts.push('⏳ 执行中');
  footerParts.push(`🔄 ${turnCount} 轮`);

  const toolContent = lines.join('\n') || '_(无工具调用)_';
  const contentElement: Record<string, unknown> = {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: toolContent,
    },
  };

  // 完成后根据长度决定是否折叠，执行中展开
  const mainElements = completed
    ? conditionalCollapsible('🔧 查看全部工具调用', [contentElement], toolContent)
    : [contentElement];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template: headerTemplate,
    },
    elements: [
      ...mainElements,
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

/**
 * 将文本截断到指定 UTF-8 字节上限，保留尾部（最新内容）。
 * 超限时从头部截断，保证完整 UTF-8 字符边界。
 */
function truncateToByteLimit(text: string, maxBytes: number): { text: string; truncated: boolean } {
  // 快速路径：byteLength 是 O(n) 扫描但不分配 Buffer
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return { text, truncated: false };

  const buf = Buffer.from(text, 'utf-8');
  // 从尾部保留 maxBytes，找到合法的 UTF-8 字符起始位置
  let start = buf.length - maxBytes;
  // UTF-8 continuation bytes: 10xxxxxx (0x80-0xBF), 跳到下一个 leading byte
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return { text: buf.subarray(start).toString('utf-8'), truncated: true };
}

/** 飞书卡片 content 字节上限（留 2KB 给 JSON 结构开销） */
const CARD_TEXT_MAX_BYTES = 28000;

/** 构建累积文本内容卡片（原地更新，显示 agent 输出文本） */
export function buildTextContentCard(
  text: string,
  turnCount: number,
  completed: boolean = false,
): Record<string, unknown> {
  const { text: displayText, truncated } = truncateToByteLimit(text, CARD_TEXT_MAX_BYTES);

  const content = truncated
    ? `_(前部分内容已省略)_\n\n${displayText}`
    : displayText;

  const headerTitle = completed
    ? '💬 Agent 输出'
    : '💬 Agent 输出 - 生成中';
  const headerTemplate = completed ? 'turquoise' : 'wathet';

  const footerParts: string[] = [];
  if (!completed) footerParts.push('⏳ 生成中');
  footerParts.push(`🔄 ${turnCount} 轮`);

  const displayContent = content || '_(暂无输出)_';
  const contentElement: Record<string, unknown> = {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: displayContent,
    },
  };

  // 完成后根据长度决定是否折叠，生成中展开
  const mainElements = completed
    ? conditionalCollapsible('📋 查看完整内容', [contentElement], displayContent)
    : [contentElement];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template: headerTemplate,
    },
    elements: [
      ...mainElements,
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
      title: { tag: 'plain_text', content: '🤖 Coding Agent' },
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
      const joinedContent = parts.join('\n\n');
      const contentElement: Record<string, unknown> = {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: joinedContent,
        },
      };
      elements.push(...conditionalCollapsible('📋 查看完整回复', [contentElement], joinedContent));
    }
  }

  // 失败时显示错误信息（不折叠，需要直接看到）
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
      title: { tag: 'plain_text', content: `🤖 Coding Agent - ${status}` },
      template: headerTemplate,
    },
    elements,
  };
}

/** 构建审批请求卡片（owner 看到，带允许/拒绝按钮） */
export function buildApprovalCard(
  approvalId: string,
  userName: string,
  messagePreview: string,
  chatType: 'group' | 'p2p',
): Record<string, unknown> {
  const source = chatType === 'group' ? '群聊' : '私聊';
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔐 有人找 Agent 聊天' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `黎叔，**${escapeMarkdown(userName)}** 通过${source}向 Agent 发了条消息：\n> ${escapeMarkdown(truncate(messagePreview, 300))}\n\n要放行吗？`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 放行' },
            type: 'primary',
            value: { action: 'approval_approve', approvalId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 不给用' },
            type: 'danger',
            value: { action: 'approval_reject', approvalId },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '放行后这个话题内 ta 后续的消息就不用再审批了。也可以直接回复「允许」或「拒绝」。',
          },
        ],
      },
    ],
  };
}

/** 构建审批结果卡片（替换审批卡片） */
export function buildApprovalResultCard(
  userName: string,
  approved: boolean,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: approved ? '✅ 已放行' : '❌ 已拒绝' },
      template: approved ? 'green' : 'red',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: approved
            ? `已放行 **${escapeMarkdown(userName)}**，ta 在这个话题里可以自由聊了`
            : `已拒绝 **${escapeMarkdown(userName)}** 的请求`,
        },
      },
    ],
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
  WebSearch: '🌐',
  WebFetch: '🌐',
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
    case 'WebSearch': {
      const query = String(tool.input.query ?? '');
      const display = query.length > 80 ? query.slice(0, 80) + '...' : query;
      return `${icon} **WebSearch** \`${display}\``;
    }
    case 'WebFetch': {
      const url = String(tool.input.url ?? '');
      const display = url.length > 80 ? url.slice(0, 80) + '...' : url;
      return `${icon} **WebFetch** ${display}`;
    }
    default:
      return `${icon} **${tool.name}**`;
  }
}

// === 工具函数 ===

/** 内容折叠阈值（字符数），超过才折叠 */
const COLLAPSIBLE_THRESHOLD = 300;

/**
 * 智能折叠：短内容直接展示，长内容显示摘要 + 折叠面板。
 * 返回元素数组，需 spread 到父 elements 中。
 */
function conditionalCollapsible(
  foldTitle: string,
  contentElements: Record<string, unknown>[],
  rawText: string,
  threshold: number = COLLAPSIBLE_THRESHOLD,
): Record<string, unknown>[] {
  if (rawText.length <= threshold) {
    return contentElements;
  }

  // 提取摘要：前 5 行作为预览直接显示，剩余内容折叠
  const lines = rawText.split('\n');
  const SUMMARY_LINES = 5;
  const summaryText = lines.slice(0, SUMMARY_LINES).join('\n').trim();
  const remainingText = lines.slice(SUMMARY_LINES).join('\n').trim();
  const remainingCount = lines.length - SUMMARY_LINES;

  // 摘要标题 + 预览内容
  const summaryHeader: Record<string, unknown> = {
    tag: 'div',
    text: { tag: 'lark_md', content: '**💬 回复预览**' },
  };
  const summaryElement: Record<string, unknown> = {
    tag: 'div',
    text: { tag: 'lark_md', content: summaryText },
  };

  // 剩余部分放入折叠面板
  const foldElement: Record<string, unknown> = {
    tag: 'collapsible_panel',
    expanded: false,
    background_color: 'grey',
    border: { color: 'grey', corner_radius: '5px' },
    header: {
      title: { tag: 'plain_text', content: foldTitle + ' (' + remainingCount + ' 行)' },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: [{
      tag: 'div',
      text: { tag: 'lark_md', content: remainingText },
    }],
  };

  return [summaryHeader, summaryElement, foldElement];
}

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

// ============================================================
// 记忆管理卡片
// ============================================================

const MEMORY_TYPE_LABELS: Record<string, string> = {
  preference: '偏好',
  fact: '事实',
  state: '状态',
  decision: '决策',
  relation: '关系',
};

function formatMemoryDate(iso: string): string {
  return iso.split('T')[0];
}

/**
 * 记忆列表卡片（含统计摘要 + 分页 + 删除按钮）
 */
export function buildMemoryListCard(
  memories: Memory[],
  page: number,
  totalPages: number,
  stats: Record<string, number>,
  agentId: string,
  userId: string,
  typeFilter?: string,
): Record<string, unknown> {
  const totalCount = Object.values(stats).reduce((a, b) => a + b, 0);

  // 统计摘要行
  const statParts = (['preference', 'fact', 'state', 'decision', 'relation'] as const)
    .map((t) => `${MEMORY_TYPE_LABELS[t]} ${stats[t] ?? 0}`)
    .join(' | ');
  const statsLine = `${statParts}  共 ${totalCount} 条`;

  const elements: Record<string, unknown>[] = [
    { tag: 'div', text: { tag: 'lark_md', content: statsLine } },
    { tag: 'hr' },
  ];

  // 记忆条目
  if (memories.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '暂无记忆记录' },
    });
  } else {
    for (let i = 0; i < memories.length; i++) {
      const mem = memories[i];
      const idx = (page - 1) * MEMORY_PAGE_SIZE + i + 1;
      const typeLabel = MEMORY_TYPE_LABELS[mem.type] ?? mem.type;
      const meta = [
        `置信度: ${mem.confidence.toFixed(2)}`,
        `证据: ${mem.evidenceCount} 次`,
        `更新: ${formatMemoryDate(mem.updatedAt)}`,
      ].join(' | ');

      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${idx}. [${typeLabel}]** ${escapeMarkdown(mem.content)}\n${meta}`,
        },
        extra: {
          tag: 'button',
          text: { tag: 'plain_text', content: '删除' },
          type: 'danger',
          value: { action: 'memory_delete', memoryId: mem.id, userId },
          confirm: {
            title: { tag: 'plain_text', content: '确认删除' },
            text: { tag: 'plain_text', content: `删除记忆: "${truncate(mem.content, 50)}"？` },
          },
        },
      });
    }
  }

  // 底部操作栏
  elements.push({ tag: 'hr' });
  const actions: Record<string, unknown>[] = [];

  if (page > 1) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '上一页' },
      type: 'default',
      value: { action: 'memory_page', page: page - 1, agentId, userId, ...(typeFilter ? { type: typeFilter } : {}) },
    });
  }
  if (page < totalPages) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '下一页' },
      type: 'default',
      value: { action: 'memory_page', page: page + 1, agentId, userId, ...(typeFilter ? { type: typeFilter } : {}) },
    });
  }
  if (totalCount > 0) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '清除全部' },
      type: 'danger',
      value: { action: 'memory_clear_request', agentId, userId },
    });
  }

  if (actions.length > 0) {
    elements.push({ tag: 'action', actions });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `记忆管理 — 第 ${page}/${totalPages} 页` },
      template: 'turquoise',
    },
    elements,
  };
}

/**
 * 记忆搜索结果卡片
 */
export function buildMemorySearchCard(
  results: MemorySearchResult[],
  query: string,
  userId: string,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `搜索关键词: **${escapeMarkdown(query)}**  共 ${results.length} 条结果` } },
    { tag: 'hr' },
  ];

  if (results.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '未找到匹配的记忆' },
    });
  } else {
    for (let i = 0; i < results.length; i++) {
      const { memory: mem, finalScore } = results[i];
      const typeLabel = MEMORY_TYPE_LABELS[mem.type] ?? mem.type;
      const meta = [
        `相关度: ${finalScore.toFixed(2)}`,
        `置信度: ${mem.confidence.toFixed(2)}`,
        `更新: ${formatMemoryDate(mem.updatedAt)}`,
      ].join(' | ');

      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${i + 1}. [${typeLabel}]** ${escapeMarkdown(mem.content)}\n${meta}`,
        },
        extra: {
          tag: 'button',
          text: { tag: 'plain_text', content: '删除' },
          type: 'danger',
          value: { action: 'memory_delete', memoryId: mem.id, userId },
          confirm: {
            title: { tag: 'plain_text', content: '确认删除' },
            text: { tag: 'plain_text', content: `删除记忆: "${truncate(mem.content, 50)}"？` },
          },
        },
      });
    }
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '记忆搜索结果' },
      template: 'turquoise',
    },
    elements,
  };
}

/**
 * 清除全部记忆确认卡片
 */
export function buildMemoryClearConfirmCard(
  count: number,
  agentId: string,
  userId: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '确认清除全部记忆' },
      template: 'red',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `即将清除 **${count}** 条记忆，此操作不可撤销。` },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '确认清除' },
            type: 'danger',
            value: { action: 'memory_clear_confirm', agentId, userId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '取消' },
            type: 'default',
            value: { action: 'memory_cancel' },
          },
        ],
      },
    ],
  };
}

// ============================================================
// AskUserQuestion 交互卡片
// ============================================================

/** AskUserQuestion 的选项 */
export interface AskUserOption {
  label: string;
  description?: string;
}

/** AskUserQuestion 的单个问题 */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options: AskUserOption[];
  multiSelect?: boolean;
}

/**
 * 构建 AskUserQuestion 交互卡片
 * 每个问题渲染为一组按钮，用户点击后触发 card action
 */
export function buildAskUserQuestionCard(
  questionId: string,
  questions: AskUserQuestionItem[],
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;

    // 问题标题
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: q.header
          ? `**${escapeMarkdown(q.header)}** — ${escapeMarkdown(q.question)}`
          : `**${escapeMarkdown(q.question)}**`,
      },
    });

    // 选项按钮
    const buttons = q.options.map((opt, oi) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: opt.label },
      type: oi === 0 ? 'primary' : 'default',
      value: {
        action: 'ask_user_answer',
        questionId,
        questionIndex: qi,
        optionIndex: oi,
        optionLabel: opt.label,
      },
    }));

    elements.push({ tag: 'action', actions: buttons });

    // 选项描述（如果有）
    const descriptions = q.options
      .filter(opt => opt.description)
      .map(opt => `• **${escapeMarkdown(opt.label)}**: ${escapeMarkdown(opt.description!)}`)
      .join('\n');
    if (descriptions) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: descriptions },
      });
    }

    // 分隔线（多个问题时）
    if (qi < questions.length - 1) {
      elements.push({ tag: 'hr' });
    }
  }

  // 底部「自定义回答」提示
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'plain_text', content: '也可以直接回复文字作为自定义答案' },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤔 需要你的输入' },
      template: 'purple',
    },
    elements,
  };
}

/**
 * 构建 AskUserQuestion 已回答卡片（替换原卡片）
 */
export function buildAskUserAnsweredCard(
  questions: AskUserQuestionItem[],
  answers: Record<string, string>,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  for (const q of questions) {
    const answer = answers[q.question] ?? '—';
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: q.header
          ? `**${escapeMarkdown(q.header)}** — ${escapeMarkdown(q.question)}\n✅ ${escapeMarkdown(answer)}`
          : `**${escapeMarkdown(q.question)}**\n✅ ${escapeMarkdown(answer)}`,
      },
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '✅ 已回答' },
      template: 'green',
    },
    elements,
  };
}

/**
 * 记忆操作结果卡片（删除/清除后的反馈）
 */
export function buildMemoryResultCard(
  message: string,
  success: boolean,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: success ? '操作成功' : '操作失败' },
      template: success ? 'green' : 'red',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: message } },
    ],
  };
}
