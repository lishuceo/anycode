/**
 * 飞书消息卡片构建器
 * 用于构建执行状态卡片、结果卡片等
 */

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
