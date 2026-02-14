import express from 'express';
import { config } from './config';
import { logger } from './utils/logger';
import { handleFeishuEvent } from './feishu/event-handler';
import type { FeishuEventBody } from './feishu/types';

export function createServer(): express.Application {
  const app = express();

  // 解析 JSON body
  app.use(express.json());

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 飞书事件回调
  app.post('/feishu/webhook', async (req, res) => {
    const body = req.body as FeishuEventBody;

    logger.debug({ eventType: body.header?.event_type, challenge: !!body.challenge }, 'Webhook received');

    try {
      const result = await handleFeishuEvent(body);

      // URL 验证需要返回 challenge
      if (result) {
        res.json(result);
      } else {
        // 飞书要求 2 秒内返回 200，否则会重试
        res.json({ code: 0 });
      }
    } catch (err) {
      logger.error({ err }, 'Error handling webhook');
      res.status(500).json({ code: -1, msg: 'Internal error' });
    }
  });

  // 飞书卡片交互回调 (预留)
  app.post('/feishu/card', async (req, res) => {
    logger.debug({ body: req.body }, 'Card action received');
    res.json({});
  });

  return app;
}

export function startServer(): void {
  const app = createServer();
  const { port } = config.server;

  app.listen(port, () => {
    logger.info({ port, env: config.server.nodeEnv }, `Server started on port ${port}`);
    logger.info(`Feishu webhook URL: http://localhost:${port}/feishu/webhook`);
  });
}
