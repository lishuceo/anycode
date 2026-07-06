import { existsSync, mkdirSync, copyFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Claude Agent SDK 把每个 conversation 的 JSONL 存在
 *   ~/.claude/projects/<encoded-cwd>/<conversationId>.jsonl
 * 编码规则：path.replaceAll('/', '-').replaceAll('.', '-')
 * 绝对路径首字符 '/' 也会变成 '-'，所以最终形如 `-root-dev-...`。
 *
 * ⚠️ 该规则是基于 @anthropic-ai/claude-agent-sdk 当前行为的观察，并非由 SDK 公开 API
 * 保证。若 SDK 升级后改变了编码（如处理 Windows 路径、加 hash 命名空间），本函数会
 * 返回一个不存在的路径。调用方应通过 jsonlFingerprint() 检测路径不存在的情况，并把
 * 「encoding 假设失效」与「无前序对话」区分开记录，便于故障排查。
 */
export function encodeProjectDir(workingDir: string): string {
  const abs = resolve(workingDir);
  return abs.replaceAll('/', '-').replaceAll('.', '-');
}

/** 返回 conversation 的 JSONL 绝对路径（不保证存在）。 */
export function resolveSessionJsonlPath(workingDir: string, conversationId: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectDir(workingDir), `${conversationId}.jsonl`);
}

/**
 * 原子复制 JSONL：先写到 <dst>.tmp 再 rename，避免读到半文件。
 * 失败时清理临时文件并抛错。
 */
export function copyJsonlAtomic(srcPath: string, dstPath: string): void {
  if (!existsSync(srcPath)) {
    throw new Error(`source JSONL not found: ${srcPath}`);
  }
  mkdirSync(dirname(dstPath), { recursive: true });
  const tmpPath = `${dstPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    copyFileSync(srcPath, tmpPath);
    renameSync(tmpPath, dstPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 把 SDK 生成的 fork JSONL 放到目标 cwd 对应的 project 目录。
 *
 * src/dst 往往位于 ~/.claude/projects 下的不同子目录。为了避免跨设备 rename 失败，
 * 这里先 copy 到目标目录临时文件，再 rename 成目标文件，最后删除源文件。
 */
export function moveJsonlAtomic(srcPath: string, dstPath: string): void {
  if (srcPath === dstPath) {
    if (!existsSync(srcPath)) {
      throw new Error(`source JSONL not found: ${srcPath}`);
    }
    return;
  }
  copyJsonlAtomic(srcPath, dstPath);
  unlinkSync(srcPath);
}

/** 计算 JSONL 末尾签名（size + mtime），P2 fork_point 字段用。 */
export function jsonlFingerprint(jsonlPath: string): string | undefined {
  if (!existsSync(jsonlPath)) return undefined;
  const st = statSync(jsonlPath);
  return `${st.size}@${st.mtimeMs}`;
}
