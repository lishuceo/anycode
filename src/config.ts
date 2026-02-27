import dotenv from 'dotenv';
dotenv.config();

import type { BotAccountConfig, AgentBinding, GroupConfig } from './agent/types.js';

function parseBotAccounts(raw?: string): BotAccountConfig[] {
  if (!raw?.trim()) return [];
  try {
    return JSON.parse(raw) as BotAccountConfig[];
  } catch {
    return [];
  }
}

function parseAgentBindings(raw?: string): AgentBinding[] {
  if (!raw?.trim()) return [];
  try {
    return JSON.parse(raw) as AgentBinding[];
  } catch {
    return [];
  }
}

function parseGroupConfigs(raw?: string): Record<string, GroupConfig> {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, GroupConfig>;
  } catch {
    return {};
  }
}

export const config = {
  // 飞书配置
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    verifyToken: process.env.FEISHU_VERIFY_TOKEN || '',
    /** 事件接收模式: 'webhook' (HTTP 回调，需要公网) | 'websocket' (长连接，无需公网) */
    eventMode: (process.env.FEISHU_EVENT_MODE || 'websocket') as 'webhook' | 'websocket',
    /** 飞书文档/知识库/云空间/多维表格 MCP 工具配置 */
    tools: {
      /** 飞书工具总开关 (默认关闭，需显式开启) */
      enabled: process.env.FEISHU_TOOLS_ENABLED === 'true',
      /** 文档工具 */
      doc: process.env.FEISHU_TOOLS_DOC !== 'false',
      /** 知识库工具 */
      wiki: process.env.FEISHU_TOOLS_WIKI !== 'false',
      /** 云空间工具 */
      drive: process.env.FEISHU_TOOLS_DRIVE !== 'false',
      /** 多维表格工具 */
      bitable: process.env.FEISHU_TOOLS_BITABLE !== 'false',
      /** 群成员工具 */
      chat: process.env.FEISHU_TOOLS_CHAT !== 'false',
    },
  },

  // 安全配置
  security: {
    /** 允许使用的用户 open_id 列表，为空则允许所有 */
    allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** 管理员用户 open_id，拥有完整代码编辑权限。为空则所有允许用户均有完整权限（向后兼容） */
    ownerUserId: process.env.OWNER_USER_ID?.trim() || '',
  },

  // Claude Code 配置
  claude: {
    defaultWorkDir: process.env.DEFAULT_WORK_DIR || '/home/ubuntu/projects',
    /** 单步空闲超时 (秒)：某步骤长时间无 SDK 消息活动时 abort。不限制总执行时长 */
    timeoutSeconds: parseInt(process.env.CLAUDE_TIMEOUT || '300', 10),
    /** 模型名称，默认 claude-opus-4-6 (Opus 4.6) */
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-6',
    /** thinking 模式: 'adaptive' (Opus 4.6 自适应) | 'disabled' */
    thinking: (process.env.CLAUDE_THINKING || 'adaptive') as 'adaptive' | 'disabled',
    /** effort 等级: 'low' | 'medium' | 'high' | 'max' (Opus 4.6 支持 max) */
    effort: (process.env.CLAUDE_EFFORT || 'max') as 'low' | 'medium' | 'high' | 'max',
    /** 单次 query 最大轮次 (Agent ↔ Tool 来回次数)，兜底防死循环 */
    maxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || '500', 10),
    /** 单次 query 最大花费 (美元)，真正的费用熔断 */
    maxBudgetUsd: parseFloat(process.env.CLAUDE_MAX_BUDGET_USD || '50'),
  },

  // 工作区配置
  workspace: {
    baseDir:
      process.env.WORKSPACE_BASE_DIR ||
      `${process.env.DEFAULT_WORK_DIR || '/home/ubuntu/projects'}/anywhere-code-work-dir`,
    branchPrefix: process.env.WORKSPACE_BRANCH_PREFIX || 'feat/claude-session',
    /** 工作区最大保留天数（过期后 thread session 和目录均会被清理） */
    maxAgeDays: parseInt(process.env.WORKSPACE_MAX_AGE_DAYS || '3', 10),
  },

  // 仓库缓存配置
  repoCache: {
    /** 缓存根目录 (bare clone 存放位置) */
    dir: process.env.REPO_CACHE_DIR || '/repos/cache',
    /** 缓存最大保留天数 */
    maxAgeDays: parseInt(process.env.REPO_CACHE_MAX_AGE_DAYS || '30', 10),
    /** 缓存最大总大小 (GB)，超过按 LRU 清理 — TODO: 尚未实现，当前仅按过期时间清理 */
    maxSizeGb: parseInt(process.env.REPO_CACHE_MAX_SIZE_GB || '50', 10),
    /** 同一仓库两次 fetch 的最小间隔 (分钟) */
    fetchIntervalMin: parseInt(process.env.REPO_CACHE_FETCH_INTERVAL_MIN || '10', 10),
  },

  // 数据库配置
  db: {
    sessionDbPath: process.env.SESSION_DB_PATH || './data/sessions.db',
    pipelineDbPath: process.env.PIPELINE_DB_PATH || './data/pipelines.db',
  },

  // 多 Agent 配置
  agent: {
    /** 多 bot 账号配置 (JSON 数组)，未配置时退化为单 bot 模式 */
    botAccounts: parseBotAccounts(process.env.BOT_ACCOUNTS),
    /** Agent 路由规则 (JSON 数组)，未配置时所有消息走 dev agent */
    bindings: parseAgentBindings(process.env.AGENT_BINDINGS),
    /** 群配置 (JSON 对象: chatId → GroupConfig) */
    groupConfigs: parseGroupConfigs(process.env.GROUP_CONFIGS),
    /** Agent 配置文件路径 (默认 ./config/agents.json，不存在则使用内置默认值) */
    configPath: process.env.AGENT_CONFIG_PATH || '',
  },

  // Codex CLI 配置 (用于 pipeline code review)
  codex: {
    /** 是否启用 Codex review agent */
    enabled: process.env.CODEX_ENABLED === 'true',
    /** codex 可执行文件路径，默认从 PATH 查找 */
    command: process.env.CODEX_COMMAND || 'codex',
    /** 单次 review 超时 (秒) */
    timeoutSeconds: parseInt(process.env.CODEX_TIMEOUT || '120', 10),
  },

  // 聊天上下文配置
  chat: {
    /** 注入初始上下文时最多拉取的历史消息条数 */
    historyMaxCount: parseInt(process.env.CHAT_HISTORY_MAX_COUNT || '10', 10),
    /** 历史上下文总字符上限（超出时从最旧的消息开始丢弃） */
    historyMaxChars: parseInt(process.env.CHAT_HISTORY_MAX_CHARS || '4000', 10),
  },

  // 服务配置
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
  },
};

/** 检查必要配置是否存在 */
export function validateConfig(): string[] {
  const errors: string[] = [];
  const hasMultiBot = config.agent.botAccounts.length > 0;
  // 多 bot 模式下不需要 FEISHU_APP_ID/SECRET（从 BOT_ACCOUNTS 读取）
  if (!hasMultiBot) {
    if (!config.feishu.appId) errors.push('FEISHU_APP_ID is required (or configure BOT_ACCOUNTS)');
    if (!config.feishu.appSecret) errors.push('FEISHU_APP_SECRET is required (or configure BOT_ACCOUNTS)');
  }
  return errors;
}

/** 是否多 bot 模式 */
export function isMultiBotMode(): boolean {
  return config.agent.botAccounts.length > 0;
}
