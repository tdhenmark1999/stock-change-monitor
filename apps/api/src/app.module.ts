import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { FetchFailure } from './checks/safe-fetch';
import { loadConfig, type AppConfig } from './config';
import { createLogger } from './logger';
import { DashboardController, HealthController, HistoryController } from './monitors/insights.controller';
import { MonitorsController } from './monitors/monitors.controller';
import { MonitorsService } from './monitors/monitors.service';
import { createCheckQueue, type CheckJobData } from './queue/check-queue';
import { CHECK_QUEUE, CONFIG } from './tokens';

const log = createLogger('api');

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Injectable()
export class QueueLifecycle implements OnModuleDestroy {
  constructor(@Inject(CHECK_QUEUE) private readonly queue: Queue<CheckJobData>) {}
  async onModuleDestroy() {
    await this.queue.close();
  }
}

const sameToken = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (request.path === '/health' || !this.config.apiToken) return true;
    const header = String(request.headers.authorization ?? '');
    if (header.startsWith('Bearer ') && sameToken(header.slice(7), this.config.apiToken)) return true;
    throw new UnauthorizedException('Invalid or missing API token');
  }
}

/** Clear messages for bad input. Unexpected errors are logged and never returned to the client. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      return response.status(400).json({ statusCode: 400, message: issues[0]?.message ?? 'Invalid input', issues });
    }
    if (error instanceof FetchFailure) {
      const statusCode = error.code === 'BLOCKED_URL' ? 400 : 502;
      return response.status(statusCode).json({ statusCode, message: error.message, code: error.code });
    }
    if (error instanceof HttpException) {
      return response.status(error.getStatus()).json({ statusCode: error.getStatus(), message: error.message });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') return response.status(404).json({ statusCode: 404, message: 'Not found' });
      if (error.code === 'P2002') return response.status(409).json({ statusCode: 409, message: 'A field with this name already exists' });
    }
    log.error({ error: error instanceof Error ? error.message : String(error) }, 'unhandled error');
    return response.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}

@Module({
  controllers: [MonitorsController, HistoryController, DashboardController, HealthController],
  providers: [
    PrismaService,
    MonitorsService,
    QueueLifecycle,
    { provide: PrismaClient, useExisting: PrismaService },
    { provide: CONFIG, useFactory: loadConfig },
    { provide: CHECK_QUEUE, useFactory: (config: AppConfig) => createCheckQueue(config.redisUrl), inject: [CONFIG] },
    { provide: APP_GUARD, useClass: ApiTokenGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
