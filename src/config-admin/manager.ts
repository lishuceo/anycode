/**
 * 自配置管理器 — 纯逻辑层（白名单解析 + 写前校验 + 自动备份 + 落盘）
 *
 * 让 anycode 在 owner 授权下安全地编辑「自己的」配置文件：
 * - 只允许改白名单内的目标（agents.json / personas / knowledge / .env / MCP）
 * - 写前按类型校验（agents.json 走 Zod，.env 走 KEY=VALUE 行校验，.md 不校验）
 * - 写前自动备份到 data/config-backups/，支持回滚
 * - agents.json 写后立即 reload，热加载即时生效
 *
 * 关键：本模块运行在服务进程内（cwd = 部署目录），因此定位到的是运行实例
 * 真实读取的 LIVE 配置文件，而非隔离工作区里的副本。owner 门禁在 tool 层做。
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { getConfigPaths, reloadAgentConfig } from '../agent/config-loader.js';
import { AgentConfigFileSchema } from '../agent/config-schema.js';

// ─── 类型 ──────────────────────────────────────────────────

/** 生效方式：热加载即时生效 / 需重启服务 */
export type EffectMode = 'hot-reload' | 'restart';

/** 校验类型 */
type ValidateKind = 'agents' | 'env' | 'none';

/** 已解析的目标 */
interface ResolvedTarget {
  /** 逻辑标签（回显给用户） */
  label: string;
  /** LIVE 文件绝对路径 */
  absPath: string;
  /** 生效方式 */
  effect: EffectMode;
  /** 写前校验类型 */
  validate: ValidateKind;
}

/** 校验结果 */
export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** 写入结果 */
export interface WriteResult {
  label: string;
  absPath: string;
  effect: EffectMode;
  /** 备份文件路径（原文件不存在则 undefined） */
  backup?: string;
  /** agents.json 写后的 reload 结果 */
  reloaded?: boolean;
  reloadError?: string;
}

// ─── 白名单解析 ────────────────────────────────────────────

/** 判断 abs 是否严格位于 base 目录内（防路径穿越） */
function withinDir(abs: string, base: string): boolean {
  return abs.startsWith(base + '/');
}

/** 是否是 .example 模板文件（不可编辑） */
function isExampleFile(p: string): boolean {
  return basename(p).includes('.example.');
}

/** .env 文件的 LIVE 路径（dotenv 从服务进程 cwd 加载） */
function envPath(): string {
  return resolve(process.cwd(), '.env');
}

/** ~/.claude.json 的 LIVE 路径（Claude Code CLI 的 MCP 配置） */
export function claudeJsonPath(): string {
  return resolve(homedir(), '.claude.json');
}

/**
 * 把逻辑 target 字符串解析为白名单内的具体文件。
 * 返回 null 表示不在白名单 / 路径穿越 / .example / 非 .md。
 * 通过 reason 输出参数返回拒绝原因。
 */
export function resolveTarget(target: string, reason?: { msg?: string }): ResolvedTarget | null {
  const t = target.trim().replace(/^\.\//, '');
  const paths = getConfigPaths();

  if (t === 'agents.json') {
    return { label: 'agents.json', absPath: paths.configFile, effect: 'hot-reload', validate: 'agents' };
  }
  if (t === '.env') {
    return { label: '.env', absPath: envPath(), effect: 'restart', validate: 'env' };
  }

  // personas/<name>.md
  if (t.startsWith('personas/')) {
    const base = resolve(paths.configDir, 'personas');
    const abs = resolve(base, t.slice('personas/'.length));
    if (!withinDir(abs, base)) { if (reason) reason.msg = '路径越出 personas/ 目录'; return null; }
    if (!abs.endsWith('.md')) { if (reason) reason.msg = '只允许编辑 .md 文件'; return null; }
    if (isExampleFile(abs)) { if (reason) reason.msg = '.example 是模板，不可编辑'; return null; }
    return { label: t, absPath: abs, effect: 'hot-reload', validate: 'none' };
  }

  // knowledge/<name>.md
  if (t.startsWith('knowledge/')) {
    const base = paths.knowledgeDir ? resolve(paths.knowledgeDir) : resolve(paths.configDir, 'knowledge');
    const abs = resolve(base, t.slice('knowledge/'.length));
    if (!withinDir(abs, base)) { if (reason) reason.msg = '路径越出 knowledge/ 目录'; return null; }
    if (!abs.endsWith('.md')) { if (reason) reason.msg = '只允许编辑 .md 文件'; return null; }
    if (isExampleFile(abs)) { if (reason) reason.msg = '.example 是模板，不可编辑'; return null; }
    return { label: t, absPath: abs, effect: 'hot-reload', validate: 'none' };
  }

  if (reason) reason.msg = `不在白名单内: ${target}（允许: agents.json / personas/*.md / knowledge/*.md / .env）`;
  return null;
}

// ─── 校验 ──────────────────────────────────────────────────

/** .env 行格式：允许空行、# 注释、KEY=... 或 export KEY=... */
const ENV_LINE_RE = /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/;

/** 按目标类型校验待写入内容。校验失败时不落盘。 */
export function validateContent(kind: ValidateKind, content: string): ValidationResult {
  if (kind === 'none') return { ok: true };

  if (kind === 'agents') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return { ok: false, error: `JSON 解析失败: ${(err as Error).message}` };
    }
    const result = AgentConfigFileSchema.safeParse(parsed);
    if (!result.success) {
      const msg = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return { ok: false, error: `agents.json schema 校验失败: ${msg}` };
    }
    return { ok: true };
  }

  if (kind === 'env') {
    const bad: string[] = [];
    content.split('\n').forEach((raw, idx) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) return;
      if (!ENV_LINE_RE.test(line)) bad.push(`第 ${idx + 1} 行: ${raw.slice(0, 60)}`);
    });
    if (bad.length > 0) {
      return { ok: false, error: `.env 存在非 KEY=VALUE 行（不支持多行值）:\n${bad.join('\n')}` };
    }
    return { ok: true };
  }

  return { ok: true };
}

// ─── 备份 ──────────────────────────────────────────────────

/** 备份目录（部署目录下 data/config-backups/） */
function backupDir(): string {
  return resolve(process.cwd(), 'data', 'config-backups');
}

/** 备份原文件到 data/config-backups/。原文件不存在（新建）返回 undefined。 */
export function backupFile(absPath: string): string | undefined {
  if (!existsSync(absPath)) return undefined;
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(dir, `${basename(absPath)}.${ts}.bak`);
  copyFileSync(absPath, backup);
  logger.info({ absPath, backup }, 'config-admin: backup created');
  return backup;
}

// ─── 读 ────────────────────────────────────────────────────

/** 列出的目标信息 */
export interface TargetInfo {
  label: string;
  effect: EffectMode;
  exists: boolean;
  kind: 'file' | 'mcp';
}

/** 列出所有可编辑目标（含现有 personas/knowledge 文件 + MCP servers） */
export function listTargets(): TargetInfo[] {
  const paths = getConfigPaths();
  const out: TargetInfo[] = [];

  out.push({ label: 'agents.json', effect: 'hot-reload', exists: existsSync(paths.configFile), kind: 'file' });

  const personasDir = resolve(paths.configDir, 'personas');
  for (const f of listMdFiles(personasDir)) {
    out.push({ label: `personas/${f}`, effect: 'hot-reload', exists: true, kind: 'file' });
  }

  const knowledgeDir = paths.knowledgeDir ? resolve(paths.knowledgeDir) : resolve(paths.configDir, 'knowledge');
  for (const f of listMdFiles(knowledgeDir)) {
    out.push({ label: `knowledge/${f}`, effect: 'hot-reload', exists: true, kind: 'file' });
  }

  out.push({ label: '.env', effect: 'restart', exists: existsSync(envPath()), kind: 'file' });

  for (const name of listMcpServerNames()) {
    out.push({ label: `mcp:${name}`, effect: 'restart', exists: true, kind: 'mcp' });
  }

  return out;
}

/** 列出目录下非 .example 的 .md 文件名 */
function listMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md') && !f.includes('.example.')).sort();
  } catch {
    return [];
  }
}

/** 读取白名单文件内容。返回 null 表示 target 非法（reason 输出原因）。 */
export function readConfig(target: string, reason?: { msg?: string }): string | null {
  const r = resolveTarget(target, reason);
  if (!r) return null;
  if (!existsSync(r.absPath)) {
    if (reason) reason.msg = `文件不存在: ${r.label}`;
    return null;
  }
  return readFileSync(r.absPath, 'utf-8');
}

// ─── 写 ────────────────────────────────────────────────────

/** 写入结果或错误 */
export type WriteOutcome = { ok: true; result: WriteResult } | { ok: false; error: string };

/**
 * 校验 → 备份 → 写入白名单文件。agents.json 写后立即 reload。
 * 任一步失败均不落盘（校验失败直接返回，不备份不写）。
 */
export function writeConfig(target: string, content: string): WriteOutcome {
  const reason: { msg?: string } = {};
  const r = resolveTarget(target, reason);
  if (!r) return { ok: false, error: reason.msg ?? '非法目标' };

  const validation = validateContent(r.validate, content);
  if (!validation.ok) return { ok: false, error: validation.error ?? '校验失败' };

  const backup = backupFile(r.absPath);
  mkdirSync(dirname(r.absPath), { recursive: true });
  writeFileSync(r.absPath, content, 'utf-8');
  logger.info({ label: r.label, absPath: r.absPath }, 'config-admin: file written');

  const result: WriteResult = { label: r.label, absPath: r.absPath, effect: r.effect, backup };

  if (r.validate === 'agents') {
    const reload = reloadAgentConfig();
    result.reloaded = reload.loaded;
    if (!reload.loaded) result.reloadError = reload.error;
  }

  return { ok: true, result };
}

// ─── MCP servers（~/.claude.json 的 mcpServers 段） ──────────

/** 读取并解析 ~/.claude.json。不存在返回空对象。 */
function readClaudeJson(): { data: Record<string, unknown>; error?: string } {
  const p = claudeJsonPath();
  if (!existsSync(p)) return { data: {} };
  try {
    return { data: JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown> };
  } catch (err) {
    return { data: {}, error: `~/.claude.json 解析失败: ${(err as Error).message}` };
  }
}

/** 列出 ~/.claude.json 中已配置的 MCP server 名称 */
export function listMcpServerNames(): string[] {
  const { data } = readClaudeJson();
  const servers = data.mcpServers;
  if (servers && typeof servers === 'object') return Object.keys(servers as Record<string, unknown>).sort();
  return [];
}

/** 读取单个 MCP server 配置（不存在返回 null） */
export function getMcpServer(name: string): unknown | null {
  const { data } = readClaudeJson();
  const servers = data.mcpServers as Record<string, unknown> | undefined;
  return servers && name in servers ? servers[name] : null;
}

/**
 * 新增/更新单个 MCP server（浅合并到 mcpServers，保留其它 server 与顶层其它键）。
 * 写前备份整份 ~/.claude.json。需重启会话才能生效。
 */
export function setMcpServer(name: string, serverConfig: unknown): WriteOutcome {
  if (!name || !name.trim()) return { ok: false, error: 'mcp_name 不能为空' };
  if (serverConfig === null || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) {
    return { ok: false, error: 'mcp_config 必须是 JSON 对象（如 { "type":"http", "url":"...", "headers":{...} } 或 { "command":"...", "args":[...] }）' };
  }
  const { data, error } = readClaudeJson();
  if (error) return { ok: false, error };

  const p = claudeJsonPath();
  const backup = backupFile(p);

  const servers = (data.mcpServers && typeof data.mcpServers === 'object'
    ? data.mcpServers
    : {}) as Record<string, unknown>;
  servers[name] = serverConfig;
  data.mcpServers = servers;

  writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  logger.info({ name, backup }, 'config-admin: mcp server set');
  return { ok: true, result: { label: `mcp:${name}`, absPath: p, effect: 'restart', backup } };
}

/** 删除单个 MCP server。写前备份。需重启会话才能生效。 */
export function removeMcpServer(name: string): WriteOutcome {
  if (!name || !name.trim()) return { ok: false, error: 'mcp_name 不能为空' };
  const { data, error } = readClaudeJson();
  if (error) return { ok: false, error };

  const servers = data.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !(name in servers)) return { ok: false, error: `MCP server 不存在: ${name}` };

  const p = claudeJsonPath();
  const backup = backupFile(p);
  delete servers[name];
  data.mcpServers = servers;

  writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  logger.info({ name, backup }, 'config-admin: mcp server removed');
  return { ok: true, result: { label: `mcp:${name}`, absPath: p, effect: 'restart', backup } };
}
