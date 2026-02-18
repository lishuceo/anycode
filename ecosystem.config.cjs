module.exports = {
  apps: [{
    name: 'feishu-claude',
    script: 'dist/index.js',

    // 给 shutdown handler 足够时间清理子进程（默认 1600ms 太短）
    kill_timeout: 10000,

    // 内存超限自动重启
    max_memory_restart: '1G',

    env: {
      NODE_ENV: 'production',
    },
  }],
};
