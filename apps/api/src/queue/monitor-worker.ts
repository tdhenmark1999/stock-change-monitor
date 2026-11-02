import { Worker, type Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import { CheckRunner } from '../checks/check-runner';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import { createCheckQueue, enqueueDueMonitors, QUEUE_NAME, redisConnection, type CheckJobData } from './check-queue';

export const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/worker-heartbeat';

/** Keeps storage bounded: removes runs older than the retention period and caps runs per monitor. */
export async function pruneHistory(prisma: PrismaClient, retentionDays: number, maxRunsPerMonitor: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const aged = await prisma.checkRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
  const capped = await prisma.$executeRaw`
    DELETE FROM "CheckRun" WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY "monitorId" ORDER BY "startedAt" DESC) AS position FROM "CheckRun"
      ) ranked WHERE position > ${maxRunsPerMonitor}
    )`;
  return aged.count + capped;
}

export function startMonitorWorker(prisma: PrismaClient, config: AppConfig, log: Logger) {
  const runner = new CheckRunner(prisma, config.fetch, log);
  const queue = createCheckQueue(config.redisUrl);
  const { attempts, backoffMs, concurrency, schedulerTickMs, retentionDays, maxRunsPerMonitor } = config.worker;

  const worker = new Worker<CheckJobData>(
    QUEUE_NAME,
    async (job: Job<CheckJobData>) => {
      const { monitorId, manual } = job.data;
      if (!manual) {
        const monitor = await prisma.monitor.findUnique({ where: { id: monitorId }, select: { enabled: true, nextCheckAt: true } });
        // A tick can race the end of the previous run, so the database has the final word.
        if (!monitor?.enabled || monitor.nextCheckAt > new Date()) return { status: 'SKIPPED' };
      }
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return runner.run(monitorId, finalAttempt);
    },
    { connection: redisConnection(config.redisUrl), concurrency },
  );
  worker.on('failed', (job, error) => {
    log.warn({ jobId: job?.id, attempt: job?.attemptsMade, error: error.message }, 'check attempt failed');
  });
  worker.on('error', (error) => log.error({ error: error.message }, 'worker error'));

  const tick = async () => {
    try {
      const due = await enqueueDueMonitors(prisma, queue, { attempts, backoffMs });
      if (due) log.debug({ due }, 'scheduler tick');
      fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
    } catch (error) {
      log.error({ error: (error as Error).message }, 'scheduler tick failed');
    }
  };
  const prune = async () => {
    try {
      const removed = await pruneHistory(prisma, retentionDays, maxRunsPerMonitor);
      if (removed) log.info({ removed }, 'history pruned');
    } catch (error) {
      log.error({ error: (error as Error).message }, 'history pruning failed');
    }
  };

  void tick();
  void prune();
  const tickTimer = setInterval(tick, schedulerTickMs);
  const pruneTimer = setInterval(prune, 3_600_000);

  return {
    /** Stops taking new jobs and lets the running checks finish. */
    async close() {
      clearInterval(tickTimer);
      clearInterval(pruneTimer);
      await worker.close();
      await queue.close();
    },
  };
}
