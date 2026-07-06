/**
 * 本会话强制模型（/fable 命令）。
 *
 * `/fable` 让 owner 把当前会话强制切到 claude-fable-5 模型，可选 `1m` 参数开启 1M 上下文。
 * 1M 上下文沿用 Claude Code CLI 的 `[1m]` 模型后缀约定（如 `claude-opus-4-8[1m]`），
 * 该后缀由 SDK 透传给 CLI 解析，本层只负责拼接正确的模型字符串。
 *
 * 作用域语义：thread 内设置 → 绑定该 thread；主面板/direct 设置 → 绑定 chat 级 session，
 * 作为无 thread override 时的默认（见 resolveForcedModel）。
 */

/** /fable 强制的模型名称 */
export const FABLE_MODEL = 'claude-fable-5';

/** 开启 1M 上下文的模型字符串（CLI `[1m]` 后缀约定） */
export const FABLE_MODEL_1M = `${FABLE_MODEL}[1m]`;

/** /fable 用法说明 */
export const FABLE_USAGE = [
  '用法: `/fable [1m|off]`',
  '`/fable` — 强制本会话使用 claude-fable-5（默认上下文）',
  '`/fable 1m` — 强制 claude-fable-5 并开启 1M 上下文',
  '`/fable off` — 取消强制，恢复默认模型',
].join('\n');

/** parseFableCommand 的解析结果 */
export interface FableParseResult {
  /** 是否解析成功 */
  ok: boolean;
  /** ok=false 时的用法/错误提示 */
  error?: string;
  /** true 表示取消强制（/fable off） */
  clear?: boolean;
  /** 解析出的模型字符串（含 [1m] 后缀，clear=true 时为 undefined） */
  model?: string;
  /** 是否开启 1M 上下文 */
  context1m?: boolean;
}

/**
 * 解析 `/fable` 命令参数。
 * - 空参数 → claude-fable-5（默认上下文）
 * - `1m`（大小写不敏感）→ claude-fable-5[1m]
 * - `off`/`default`/`reset`（大小写不敏感）→ 清除强制
 * - 其它 → 用法错误
 */
export function parseFableCommand(rawArgs: string): FableParseResult {
  const arg = rawArgs.trim().toLowerCase();

  if (arg === '') {
    return { ok: true, model: FABLE_MODEL, context1m: false };
  }
  if (arg === '1m') {
    return { ok: true, model: FABLE_MODEL_1M, context1m: true };
  }
  if (arg === 'off' || arg === 'default' || arg === 'reset') {
    return { ok: true, clear: true };
  }
  return { ok: false, error: `⚠️ 无法识别参数 "${rawArgs.trim()}"。\n${FABLE_USAGE}` };
}

/**
 * 解析本次执行应使用的强制模型。
 * thread 级 override 优先，其次回退到 chat 级 session 默认；两者都没有则返回 undefined
 * （调用方回退到 agent 配置模型）。
 */
export function resolveForcedModel(
  threadForcedModel: string | undefined,
  sessionForcedModel: string | undefined,
): string | undefined {
  return threadForcedModel ?? sessionForcedModel;
}
