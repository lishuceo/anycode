import dotenv from 'dotenv';
dotenv.config();

import { dirname } from 'node:path';
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
      /** 通讯录工具 (根据 open_id 查询用户信息) */
      contact: process.env.FEISHU_TOOLS_CONTACT !== 'false',
      /** 任务工具 */
      task: process.env.FEISHU_TOOLS_TASK !== 'false',
      /** 日历工具 */
      calendar: process.env.FEISHU_TOOLS_CALENDAR !== 'false',
    },
    /** OAuth 用户授权配置（用于获取 user_access_token，支持查询用户个人任务等） */
    oauth: {
      /** OAuth 回调地址（需要公网可访问） */
      redirectUri: process.env.FEISHU_OAUTH_REDIRECT_URI || '',
      /** OAuth 请求的权限范围（空格分隔）。默认包含 task + tasklist 读写权限。 */
      scopes: process.env.FEISHU_OAUTH_SCOPES || 'task:task:read task:task:write task:tasklist:read calendar:calendar calendar:calendar:readonly contact:user:search',
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
    defaultWorkDir: process.env.DEFAULT_WORK_DIR || dirname(process.cwd()),
    /** Anthropic API Base URL（支持代理/自定义端点），默认官方地址 */
    apiBaseUrl: process.env.ANTHROPIC_BASE_URL || '',
    /** 单步空闲超时 (秒)：某步骤长时间无 SDK 消息活动时 abort。不限制总执行时长 */
    timeoutSeconds: parseInt(process.env.CLAUDE_TIMEOUT || '300', 10),
    /** 模型名称，默认 claude-opus-4-7 (Opus 4.7) */
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-7',
    /** thinking 模式: 'adaptive' (自适应思考) | 'disabled' */
    thinking: (process.env.CLAUDE_THINKING || 'adaptive') as 'adaptive' | 'disabled',
    /** effort 等级: 'low' | 'medium' | 'high' | 'max' */
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
      `${process.env.DEFAULT_WORK_DIR || dirname(process.cwd())}/.workspaces`,
    branchPrefix: process.env.WORKSPACE_BRANCH_PREFIX || 'feat/claude-session',
    /** 工作区最大保留天数（过期后 thread session 和目录均会被清理） */
    maxAgeDays: parseInt(process.env.WORKSPACE_MAX_AGE_DAYS || '3', 10),
  },

  // 仓库缓存配置
  repoCache: {
    /** 缓存根目录 (bare clone 存放位置) */
    dir: process.env.REPO_CACHE_DIR || `${process.env.DEFAULT_WORK_DIR || dirname(process.cwd())}/.repo-cache`,
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
    historyMaxChars: parseInt(process.env.CHAT_HISTORY_MAX_CHARS || '8000', 10),
  },

  // DashScope (阿里云百炼) 通用配置
  dashscope: {
    apiKey: process.env.DASHSCOPE_API_KEY || '',
    baseUrl:
      process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },

  // 快速确认配置（Direct 模式下先用小模型快速回复，掩盖主流程延迟）
  quickAck: {
    /** 快速确认开关 (默认关闭) */
    enabled: process.env.QUICK_ACK_ENABLED === 'true',
    /** 使用的模型 (DashScope) */
    model: process.env.QUICK_ACK_MODEL || 'qwen3.5-flash',
    /** 超时毫秒数，超时则放弃快速回复 */
    timeoutMs: parseInt(process.env.QUICK_ACK_TIMEOUT_MS || '3000', 10),
  },

  // 记忆系统配置
  memory: {
    /** 记忆系统总开关 */
    enabled: process.env.MEMORY_ENABLED === 'true',
    /** 记忆数据库路径 */
    dbPath: process.env.MEMORY_DB_PATH || './data/memories.db',
    /** DashScope (阿里云百炼) API Key，embedding 和抽取模型共用 */
    dashscopeApiKey: process.env.DASHSCOPE_API_KEY || '',
    /** DashScope OpenAI-compatible base URL */
    dashscopeBaseUrl:
      process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    /** Embedding 模型名称 */
    embeddingModel: process.env.MEMORY_EMBEDDING_MODEL || 'text-embedding-v4',
    /** Embedding 向量维度 */
    embeddingDimension: parseInt(process.env.MEMORY_EMBEDDING_DIM || '1536', 10),
    /** 记忆抽取模型名称 (DashScope Qwen，支持 JSON 结构化输出) */
    extractionModel: process.env.MEMORY_EXTRACTION_MODEL || 'qwen3.5-flash',
    /** 混合检索中向量权重 (0~1, BM25 权重 = 1 - vectorWeight) */
    vectorWeight: parseFloat(process.env.MEMORY_VECTOR_WEIGHT || '0.7'),
    /** 注入记忆的最大 token 数 */
    maxInjectTokens: parseInt(process.env.MEMORY_MAX_INJECT_TOKENS || '4000', 10),
  },

  // 定时任务配置
  cron: {
    /** 定时任务调度器开关 */
    enabled: process.env.CRON_ENABLED === 'true',
    /** 定时任务数据库路径 */
    dbPath: process.env.CRON_DB_PATH || './data/cron.db',
    /** 默认时区 */
    timezone: process.env.CRON_TIMEZONE || 'Asia/Shanghai',
    /** 默认单次执行超时秒数 */
    defaultTimeoutSeconds: parseInt(process.env.CRON_DEFAULT_TIMEOUT || '300', 10),
    /** 默认单次执行预算 USD */
    defaultBudgetUsd: parseFloat(process.env.CRON_DEFAULT_BUDGET || '5'),
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
