import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { historyQuerySchema } from '@esm/shared';
import { REDIS_TIMEOUT_MS, withTimeout, type CheckJobData } from '../queue/check-queue';
import { CHECK_QUEUE } from '../tokens';
import { MonitorsService } from './monitors.service';

@Controller('history')
export class HistoryController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.monitors.history(historyQuerySchema.parse(query));
  }
}

@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

  @Get()
  get() {
    return this.monitors.dashboard();
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(CHECK_QUEUE) private readonly queue: Queue<CheckJobData>,
  ) {}

  @Get()
  async health(@Res() response: { status(code: number): { json(body: unknown): void } }) {
    const [database, redis] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      withTimeout(this.queue.getWorkersCount(), REDIS_TIMEOUT_MS),
    ]);
    const ok = database.status === 'fulfilled' && redis.status === 'fulfilled';
    response.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      database: database.status === 'fulfilled' ? 'up' : 'down',
      redis: redis.status === 'fulfilled' ? 'up' : 'down',
    });
  }
}
