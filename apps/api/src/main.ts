import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { createLogger, NestPinoLogger } from './logger';

async function bootstrap() {
  const config = loadConfig();
  const log = createLogger('api');
  if (process.env.NODE_ENV === 'production' && !config.apiToken) {
    throw new Error('API_TOKEN must be set in production');
  }
  const app = await NestFactory.create(AppModule, { logger: new NestPinoLogger(log) });
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  log.info({ port: config.port }, 'api started');
}

void bootstrap();
