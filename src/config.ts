import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // 飞书配置
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    verifyToken: process.env.FEISHU_VERIFY_TOKEN || '',
    /** 事件接收模式: 'webhook' (HTTP 回调，需要公网) | 'websocket' (长连接，无需公网) */
    eventMode: (process.env.FEISHU_EVENT_MODE || 'websocket') as 'webhook' | 'websocket',
  },

  // 安全配置
  security: {
    /** 允许使用的用户 open_id 列表，为空则允许所有 */
    allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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
  },

  // 工作区配置
  workspace: {
    baseDir:
      process.env.WORKSPACE_BASE_DIR ||
      `${process.env.DEFAULT_WORK_DIR || '/home/ubuntu/projects'}/anywhere-code-work-dir`,
    branchPrefix: process.env.WORKSPACE_BRANCH_PREFIX || 'feat/claude-session',
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
  if (!config.feishu.appId) errors.push('FEISHU_APP_ID is required');
  if (!config.feishu.appSecret) errors.push('FEISHU_APP_SECRET is required');
  return errors;
}
