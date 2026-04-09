module.exports = {
  apps: [{
    name: 'anycode',
    script: 'dist/index.js',

    // 给 shutdown handler 足够时间清理子进程（默认 1600ms 太短）
    kill_timeout: 10000,

    // 内存超限自动重启
    max_memory_restart: '1G',

    // 兜底日志：捕获 Node 崩溃、unhandled rejection 等 Pino 来不及写的输出
    // 注意：路径固定为 logs/，不跟随 LOG_DIR 环境变量（PM2 解析配置时 .env 尚未加载）
    out_file: 'logs/pm2-out.log',
    error_file: 'logs/pm2-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    env: {
      NODE_ENV: 'production',
    },
  }],
};
