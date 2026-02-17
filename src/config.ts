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
    timeoutSeconds: parseInt(process.env.CLAUDE_TIMEOUT || '300', 10),
  },

  // 数据库配置
  db: {
    sessionDbPath: process.env.SESSION_DB_PATH || './data/sessions.db',
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
