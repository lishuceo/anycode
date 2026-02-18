import express from 'express';
import * as lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { createEventDispatcher, createCardActionHandler } from './feishu/event-handler.js';

/**
 * 启动服务
 *
 * 支持两种飞书事件接收模式 (由 FEISHU_EVENT_MODE 控制):
 *
 *   1. webhook 模式 (默认):
 *      - 飞书通过 HTTP POST 把事件推送到你的服务器
 *      - 需要公网可访问的 HTTPS 地址
 *      - 适合生产环境
 *
 *   2. websocket 模式:
 *      - 使用飞书 SDK 的 WSClient 主动连接飞书
 *      - 不需要公网 IP，不需要配置回调地址
 *      - 适合开发调试、没有公网 IP 的场景
 */
export function startServer(): void {
  const { port } = config.server;
  const eventDispatcher = createEventDispatcher();

  if (config.feishu.eventMode === 'websocket') {
    startWebSocketMode(eventDispatcher, port);
  } else {
    startWebhookMode(eventDispatcher, port);
  }
}

// ============================================================
// 模式一: HTTP Webhook (需要公网)
// ============================================================

function startWebhookMode(eventDispatcher: lark.EventDispatcher, port: number): void {
  const app = express();
  app.use(express.json());

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'webhook', timestamp: new Date().toISOString() });
  });

  // 飞书事件回调 — SDK 自动处理 challenge、签名验证、事件去重
  app.post(
    '/feishu/webhook',
    lark.adaptExpress(eventDispatcher, { autoChallenge: true }),
  );

  // 飞书卡片交互回调
  const cardHandler = createCardActionHandler();
  app.post(
    '/feishu/card',
    lark.adaptExpress(cardHandler, { autoChallenge: true }),
  );

  app.listen(port, () => {
    logger.info({ port, mode: 'webhook' }, 'Server started (HTTP Webhook mode)');
    logger.info(`  Webhook URL: http://localhost:${port}/feishu/webhook`);
    logger.info(`  Card action URL: http://localhost:${port}/feishu/card`);
    logger.info('  Note: 飞书需要能通过公网 HTTPS 访问以上地址');
  });
}

// ============================================================
// 模式二: WebSocket 长连接 (无需公网)
// ============================================================

function startWebSocketMode(eventDispatcher: lark.EventDispatcher, port: number): void {
  // WSClient 主动连接飞书，通过 WebSocket 接收事件
  const wsClient = new lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  });

  // 将 EventDispatcher 传给 WSClient
  wsClient.start({ eventDispatcher }).then(() => {
    logger.info({ mode: 'websocket' }, 'Feishu WebSocket connected');
    logger.info('  无需配置回调地址，无需公网 IP');
    logger.info('  飞书后台事件订阅方式选择「使用长连接接收事件」');
  }).catch((err: Error) => {
    logger.error({ err }, 'Failed to connect Feishu WebSocket');
  });

  // 仍然启动 Express 用于健康检查 + 卡片交互回调
  // 注意：飞书卡片交互始终通过 HTTP POST 回调（即使事件使用 WebSocket），
  // 因此需要在两种模式下都注册卡片回调端点
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'websocket', timestamp: new Date().toISOString() });
  });

  // 飞书卡片交互回调
  const cardHandler = createCardActionHandler();
  app.post(
    '/feishu/card',
    lark.adaptExpress(cardHandler, { autoChallenge: true }),
  );

  app.listen(port, () => {
    logger.info({ port, mode: 'websocket' }, 'Health check + card action server started');
    logger.info(`  Card action URL: http://localhost:${port}/feishu/card`);
  });
}
