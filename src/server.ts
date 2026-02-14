import express from 'express';
import * as lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { createEventDispatcher, createCardActionHandler } from './feishu/event-handler.js';

export function createServer(): express.Application {
  const app = express();

  // 解析 JSON body
  app.use(express.json());

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ====================================================
  // 飞书事件回调 — 使用 SDK 的 EventDispatcher + adaptExpress
  //
  // SDK 自动处理:
  //   - URL verification (challenge 自动应答)
  //   - 事件签名验证
  //   - 事件加密/解密
  //   - 事件去重 (内置 cache)
  // ====================================================
  const eventDispatcher = createEventDispatcher();
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

  return app;
}

export function startServer(): void {
  const app = createServer();
  const { port } = config.server;

  app.listen(port, () => {
    logger.info({ port, env: config.server.nodeEnv }, `Server started on port ${port}`);
    logger.info(`Feishu webhook URL: http://localhost:${port}/feishu/webhook`);
    logger.info(`Feishu card action URL: http://localhost:${port}/feishu/card`);
  });
}
