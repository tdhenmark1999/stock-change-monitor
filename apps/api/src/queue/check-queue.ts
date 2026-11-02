import { Queue, type ConnectionOptions } from 'bullmq';
import type { PrismaClient } from '@prisma/client';

export const QUEUE_NAME = 'monitor-checks';

export interface CheckJobData {
  monitorId: string;
  // A scheduled job re-checks that the monitor is still due. A manual one always runs.
  manual: boolean;
}

export const REDIS_TIMEOUT_MS = 3_000;

/** BullMQ waits for Redis to return indefinitely, which must not leave an API request hanging. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function redisConnection(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
    db: Number(parsed.pathname.slice(1)) || 0,
    maxRetriesPerRequest: null,
  };
}

export function createCheckQueue(redisUrl: string) {
  return new Queue<CheckJobData>(QUEUE_NAME, { connection: redisConnection(redisUrl) });
}

interface EnqueueOptions {
  attempts: number;
  backoffMs: number;
}

const jobOptions = (jobId: string, { attempts, backoffMs }: EnqueueOptions) => ({
  // BullMQ ignores an add when this jobId is still queued, active or waiting for a retry.
  jobId,
  attempts,
  backoff: { type: 'exponential' as const, delay: backoffMs },
  removeOnComplete: true,
  removeOnFail: true,
});

export function enqueueManualCheck(queue: Queue<CheckJobData>, monitorId: string, options: EnqueueOptions) {
  return queue.add('check', { monitorId, manual: true }, jobOptions(`manual-${monitorId}`, options));
}

/**
 * Due monitors are read from PostgreSQL on every tick and Redis only carries the work.
 * So schedules recover from a worker restart and even from a completely empty Redis.
 */
export async function enqueueDueMonitors(prisma: PrismaClient, queue: Queue<CheckJobData>, options: EnqueueOptions): Promise<number> {
  const due = await prisma.monitor.findMany({
    where: { enabled: true, nextCheckAt: { lte: new Date() } },
    select: { id: true },
    orderBy: { nextCheckAt: 'asc' },
    take: 500,
  });
  await Promise.all(
    due.map(({ id }) => queue.add('check', { monitorId: id, manual: false }, jobOptions(`scheduled-${id}`, options))),
  );
  return due.length;
}
