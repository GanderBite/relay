import { pino } from 'pino';

export const Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  messageKey: 'event',
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: !process.env.NO_COLOR,
      ignore: 'pid,hostname',
      messageKey: 'event',
      timestampKey: 'ts',
    },
  },
});

export type Logger = typeof Logger;
