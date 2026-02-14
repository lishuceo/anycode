import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.server.logLevel,
  transport:
    config.server.nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
