import type { LoggerService } from '@nestjs/common';
import pino from 'pino';

export function createLogger(service: string) {
  return pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service } });
}

export type Logger = ReturnType<typeof createLogger>;

export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown) {
    this.logger.info({ msg: String(message) });
  }
  error(message: unknown, trace?: string) {
    this.logger.error({ msg: String(message), trace });
  }
  warn(message: unknown) {
    this.logger.warn({ msg: String(message) });
  }
}
