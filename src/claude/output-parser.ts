/**
 * 将 Claude Code 输出格式化为适合飞书展示的格式
 */

/** 飞书消息长度限制 (字符数) */
const MAX_MESSAGE_LENGTH = 4000;

/**
 * 将 Claude Code 的原始输出格式化为飞书可展示的文本
 */
export function formatOutputForFeishu(output: string): string {
  if (!output) return '(无输出)';

  // 如果输出过长，截断并提示
  if (output.length > MAX_MESSAGE_LENGTH) {
    const truncated = output.slice(0, MAX_MESSAGE_LENGTH - 100);
    return `${truncated}\n\n... (输出过长，已截断，共 ${output.length} 字符)`;
  }

  return output;
}

/**
 * 将输出分割为多段消息（用于超长输出）
 */
export function splitOutput(output: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (output.length <= maxLength) return [output];

  const parts: string[] = [];
  let remaining = output;
  let partIndex = 1;

  while (remaining.length > 0) {
    const chunk = remaining.slice(0, maxLength - 50);
    remaining = remaining.slice(maxLength - 50);

    const header = parts.length > 0 ? `(续 ${partIndex})\n\n` : '';
    parts.push(header + chunk);
    partIndex++;
  }

  return parts;
}

/**
 * 构建任务完成的摘要信息
 */
export function buildCompletionSummary(
  success: boolean,
  output: string,
  durationMs: number,
  timedOut?: boolean,
): string {
  const durationStr = formatDuration(durationMs);
  const icon = timedOut ? '⏱️' : success ? '✅' : '❌';
  const status = timedOut
    ? '执行超时'
    : success
      ? '执行完成'
      : '执行失败';

  return `${icon} ${status}  (耗时 ${durationStr})\n\n${formatOutputForFeishu(output)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m${remainSec}s`;
}
