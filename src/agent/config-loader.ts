/**
 * Agent 配置加载器 — 文件加载 + Zod 校验 + defaults 合并 + 热重载
 *
 * 借鉴 OpenClaw 的 defaults + per-agent overrides 模式：
 * - agent 级字段完整覆盖 defaults 同名字段（非深度合并）
 * - 未配置的字段回退到 defaults → 内置默认值
 *
 * 热重载：fs.watchFile (polling) + SIGHUP 信号
 * 系统提示词文件：每次 query 重新读取，修改即生效
 */
import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { agentRegistry } from './registry.js';
import { AgentConfigFileSchema } from './config-schema.js';
import type { AgentDefaults, AgentConfigInput, ToolPolicyValue } from './config-schema.js';
import type { AgentConfig, ToolPolicy } from './types.js';

// ─── 内置默认值（无配置文件时的 fallback） ───────────────────

const BUILTIN_DEFAULTS: AgentDefaults = {
  model: 'claude-sonnet-4-6',
  toolPolicy: 'readonly',
  settingSources: ['user', 'project'],
  maxBudgetUsd: 5,
  maxTurns: 100,
  requiresApproval: false,
  replyMode: 'direct',
};

// ─── 状态 ──────────────────────────────────────────────────

/** 已解析的配置文件路径 */
let configFilePath: string | undefined;
/** 配置文件所在目录（用于解析相对路径） */
let configFileDir: string | undefined;
/** 知识文件根目录（resolved absolute path） */
let knowledgeDirPath: string | undefined;
/** 文件监听是否活跃 */
let watcherActive = false;
/** 重载防抖定时器 */
let reloadDebounceTimer: ReturnType<typeof setTimeout> | undefined;

// ─── Tool Policy 解析 ──────────────────────────────────────

function resolveToolPolicy(policy: ToolPolicyValue | undefined): {
  toolPolicy: ToolPolicy;
  readOnly: boolean;
  toolAllow?: string[];
  toolDeny?: string[];
} {
  if (!policy) {
    return { toolPolicy: 'all', readOnly: false };
  }

  if (typeof policy === 'string') {
    return { toolPolicy: policy, readOnly: policy === 'readonly' };
  }

  // 详细对象格式：{ profile, allow?, deny? }
  const base = policy.profile ?? 'all';
  return {
    toolPolicy: base,
    readOnly: base === 'readonly',
    toolAllow: policy.allow,
    toolDeny: policy.deny,
  };
}

// ─── Merge 逻辑 ────────────────────────────────────────────

/**
 * 合并单个 agent 配置：input → defaults → 内置默认值
 * 遵循 OpenClaw 模式：agent 级字段完整覆盖 defaults 同名字段
 */
function mergeAgentConfig(input: AgentConfigInput, defaults: AgentDefaults): AgentConfig {
  const toolPolicyRaw = input.toolPolicy ?? defaults.toolPolicy ?? BUILTIN_DEFAULTS.toolPolicy;
  const { toolPolicy, readOnly, toolAllow, toolDeny } = resolveToolPolicy(toolPolicyRaw);

  return {
    id: input.id,
    displayName: input.displayName ?? input.id,
    model: input.model ?? defaults.model ?? BUILTIN_DEFAULTS.model!,
    toolPolicy,
    readOnly,
    settingSources: (input.settingSources ?? defaults.settingSources ?? BUILTIN_DEFAULTS.settingSources!) as ('user' | 'project')[],
    maxBudgetUsd: input.maxBudgetUsd ?? defaults.maxBudgetUsd ?? BUILTIN_DEFAULTS.maxBudgetUsd!,
    maxTurns: input.maxTurns ?? defaults.maxTurns ?? BUILTIN_DEFAULTS.maxTurns!,
    requiresApproval: input.requiresApproval ?? defaults.requiresApproval ?? BUILTIN_DEFAULTS.requiresApproval!,
    replyMode: input.replyMode ?? defaults.replyMode ?? BUILTIN_DEFAULTS.replyMode! as 'direct' | 'thread',
    persona: input.persona ?? defaults.persona,
    knowledge: input.knowledge ?? defaults.knowledge,
    toolAllow,
    toolDeny,
  };
}

// ─── 加载 / 重载 ──────────────────────────────────────────

export interface LoadResult {
  loaded: boolean;
  error?: string;
}

/**
 * 启动时加载 agent 配置。
 * 查找顺序：AGENT_CONFIG_PATH env → ./config/agents.json
 * 无文件 → 使用内置默认值（向后兼容）
 */
export function loadAgentConfig(): LoadResult {
  const envPath = config.agent.configPath;
  const defaultPath = resolve(process.cwd(), 'config', 'agents.json');

  const candidatePath = envPath || defaultPath;

  if (!existsSync(candidatePath)) {
    if (envPath) {
      // 显式配置但文件不存在 → 错误
      return { loaded: false, error: `AGENT_CONFIG_PATH file not found: ${candidatePath}` };
    }
    // 无显式配置，默认路径也不存在 → 注册最小可用的 dev agent 兜底
    logger.warn('No config/agents.json found, registering minimal fallback dev agent');
    agentRegistry.replaceAll([{
      id: 'dev',
      displayName: 'DevBot',
      model: config.claude.model,
      toolPolicy: 'all',
      readOnly: false,
      settingSources: ['user', 'project'] as ('user' | 'project')[],
      maxBudgetUsd: config.claude.maxBudgetUsd,
      maxTurns: config.claude.maxTurns,
      requiresApproval: false,
      replyMode: 'thread',
    }]);
    return { loaded: false };
  }

  configFilePath = candidatePath;
  configFileDir = dirname(candidatePath);

  return reloadAgentConfig();
}

/**
 * 重载 agent 配置（热重载入口）。
 * 校验失败时保留旧配置，不中断服务。
 */
export function reloadAgentConfig(): LoadResult {
  if (!configFilePath) {
    return { loaded: false, error: 'No config file path set' };
  }

  try {
    const raw = readFileSync(configFilePath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Zod 校验
    const result = AgentConfigFileSchema.safeParse(parsed);
    if (!result.success) {
      const errorMsg = result.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      logger.error({ path: configFilePath, errors: errorMsg }, 'Agent config validation failed, keeping old config');
      return { loaded: false, error: errorMsg };
    }

    const configFile = result.data;
    const defaults = configFile.defaults ?? {};

    // 保存 knowledgeDir（相对于配置文件目录解析）
    if (configFile.knowledgeDir) {
      const baseDir = configFileDir ?? process.cwd();
      knowledgeDirPath = configFile.knowledgeDir.startsWith('/')
        ? configFile.knowledgeDir
        : resolve(baseDir, configFile.knowledgeDir);
    } else {
      knowledgeDirPath = undefined;
    }

    // 合并每个 agent
    const agents = configFile.agents.map(input => mergeAgentConfig(input, defaults));

    // 应用到 registry
    agentRegistry.replaceAll(agents);

    logger.info(
      { path: configFilePath, agentCount: agents.length, agentIds: agents.map(a => a.id) },
      'Agent config loaded',
    );
    return { loaded: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ path: configFilePath, err: msg }, 'Failed to load agent config, keeping old config');
    return { loaded: false, error: msg };
  }
}

// ─── Persona 文件读取 ────────────────────────────────────────

/**
 * 读取 agent 的人格提示词文件。
 * 每次 query 调用（不缓存），修改文件即生效。
 * 返回 undefined 时调用方应 fallback 到硬编码 prompt。
 */
export function readPersonaFile(agentId: string): string | undefined {
  const agentCfg = agentRegistry.get(agentId);
  const personaFile = agentCfg?.persona;
  if (!personaFile) return undefined;

  const baseDir = configFileDir ?? process.cwd();
  const resolvedPath = personaFile.startsWith('/')
    ? personaFile
    : resolve(baseDir, personaFile);

  // 安全：限制路径在配置目录或项目目录内，防止路径穿越读取敏感文件
  const allowedDir = resolve(baseDir);
  const projectDir = resolve(process.cwd());
  if (!resolvedPath.startsWith(allowedDir + '/') && !resolvedPath.startsWith(projectDir + '/')) {
    logger.warn(
      { agentId, path: resolvedPath, allowedDir, projectDir },
      'persona file path escapes allowed directories, rejected',
    );
    return undefined;
  }

  try {
    return readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    logger.warn(
      { agentId, path: resolvedPath, err: (err as Error).message },
      'Failed to read persona file, falling back to default',
    );
    return undefined;
  }
}

// ─── Knowledge 文件读取 ──────────────────────────────────────

/**
 * 加载 agent 的知识文件内容。
 * 每次 query 调用（不缓存），修改文件即生效。
 * 按 knowledge 列表顺序拼接，文件缺失跳过并 warn。
 * 返回 undefined 表示该 agent 无知识文件配置。
 */
export function loadKnowledgeContent(agentId: string): string | undefined {
  const agentCfg = agentRegistry.get(agentId);
  const files = agentCfg?.knowledge;
  if (!files || files.length === 0) return undefined;
  if (!knowledgeDirPath) {
    logger.warn({ agentId }, 'Agent has knowledge list but knowledgeDir is not configured');
    return undefined;
  }

  const resolvedKnowledgeDir = resolve(knowledgeDirPath);
  const parts: string[] = [];

  for (const file of files) {
    const filePath = resolve(knowledgeDirPath, file);

    // 路径安全校验：必须在 knowledgeDir 内
    if (!filePath.startsWith(resolvedKnowledgeDir + '/')) {
      logger.warn(
        { agentId, file, filePath, knowledgeDir: resolvedKnowledgeDir },
        'Knowledge file path escapes knowledgeDir, rejected',
      );
      continue;
    }

    try {
      parts.push(readFileSync(filePath, 'utf-8'));
    } catch (err) {
      logger.warn(
        { agentId, file, path: filePath, err: (err as Error).message },
        'Failed to read knowledge file, skipping',
      );
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

// ─── 热重载 Watcher ────────────────────────────────────────

/**
 * 启动配置文件监听（fs.watchFile polling 模式，跨平台稳定）。
 * 文件变更后 500ms debounce 触发 reloadAgentConfig。
 */
export function startConfigWatcher(): void {
  if (!configFilePath || watcherActive) return;

  watchFile(configFilePath, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;

    // 500ms debounce：等待写入完成
    if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = setTimeout(() => {
      logger.info({ path: configFilePath }, 'Agent config file changed, reloading...');
      reloadAgentConfig();
    }, 500);
  });

  watcherActive = true;
  logger.info({ path: configFilePath }, 'Watching agent config file for hot reload');
}

/** 停止配置文件监听 */
export function stopConfigWatcher(): void {
  if (configFilePath && watcherActive) {
    unwatchFile(configFilePath);
    watcherActive = false;
  }
  if (reloadDebounceTimer) {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = undefined;
  }
}
