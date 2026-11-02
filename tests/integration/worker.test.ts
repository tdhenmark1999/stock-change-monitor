import type { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../apps/api/src/config';
import { createCheckQueue, enqueueDueMonitors, enqueueManualCheck, type CheckJobData } from '../../apps/api/src/queue/check-queue';
import { pruneHistory, startMonitorWorker } from '../../apps/api/src/queue/monitor-worker';
import { newPrisma, silentLog, startFixture, testPolicy, until, wipe } from './helpers';

let prisma: PrismaClient;
let fixture: Awaited<ReturnType<typeof startFixture>>;
let queue: Queue<CheckJobData>;
let running: { close(): Promise<void> } | null = null;

const config = (): AppConfig => ({
  ...loadConfig(),
  fetch: testPolicy,
  worker: { concurrency: 3, attempts: 2, backoffMs: 50, schedulerTickMs: 100, retentionDays: 90, maxRunsPerMonitor: 5_000 },
});
const startWorker = () => {
  running = startMonitorWorker(prisma, config(), silentLog);
  return running;
};
const stopWorker = async () => {
  await running?.close();
  running = null;
};

const createMonitor = (url: string, data: Record<string, unknown> = {}) =>
  prisma.monitor.create({
    data: { name: 'm', url, intervalMinutes: 1, ...data, fields: { create: [{ name: 'Price', selector: '.price', role: 'PRICE' }] } },
  });
const runCount = (monitorId: string) => prisma.checkRun.count({ where: { monitorId } });
const makeDue = (id: string) => prisma.monitor.update({ where: { id }, data: { nextCheckAt: new Date(Date.now() - 1000) } });

beforeAll(async () => {
  prisma = newPrisma();
  fixture = await startFixture();
  queue = createCheckQueue(loadConfig().redisUrl);
});
afterAll(async () => {
  await queue.close();
  await fixture.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await queue.obliterate({ force: true });
  await wipe(prisma);
});
afterEach(stopWorker);

describe('scheduled monitoring', () => {
  it('checks a due monitor and schedules its next check by its interval', async () => {
    const m = await createMonitor(`${fixture.base}/product/sched`);
    startWorker();
    await until(() => runCount(m.id), (n) => n === 1);
    const monitor = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } });
    const delta = monitor.nextCheckAt.getTime() - Date.now();
    expect(delta).toBeGreaterThan(50_000);
    expect(delta).toBeLessThanOrEqual(60_000);
  });

  it('runs once per due period, not on every tick', async () => {
    const m = await createMonitor(`${fixture.base}/product/once`);
    startWorker();
    await until(() => runCount(m.id), (n) => n >= 1);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await runCount(m.id)).toBe(1);
  });

  it('leaves disabled monitors alone', async () => {
    const m = await createMonitor(`${fixture.base}/product/off`, { enabled: false });
    startWorker();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await runCount(m.id)).toBe(0);
  });

  it('runs a manual check on a disabled monitor', async () => {
    const m = await createMonitor(`${fixture.base}/product/manual`, { enabled: false, nextCheckAt: new Date(Date.now() + 3_600_000) });
    startWorker();
    await enqueueManualCheck(queue, m.id, { attempts: 1, backoffMs: 0 });
    await until(() => runCount(m.id), (n) => n === 1);
  });
});

describe('retry policy', () => {
  it('retries a transient failure and writes one history row', async () => {
    const m = await createMonitor(`${fixture.base}/status?code=503`);
    startWorker();
    await until(() => runCount(m.id), (n) => n === 1);
    const run = await prisma.checkRun.findFirstOrThrow({ where: { monitorId: m.id } });
    expect(run).toMatchObject({ status: 'ERROR', errorCode: 'HTTP_ERROR' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await runCount(m.id)).toBe(1);
  });
});

describe('duplicate-job prevention', () => {
  it('keeps one queued job however many times a monitor is enqueued', async () => {
    const m = await createMonitor(`${fixture.base}/product/dup`);
    const options = { attempts: 1, backoffMs: 0 };
    await enqueueDueMonitors(prisma, queue, options);
    await enqueueDueMonitors(prisma, queue, options);
    await enqueueDueMonitors(prisma, queue, options);
    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
    await enqueueManualCheck(queue, m.id, options);
    await enqueueManualCheck(queue, m.id, options);
    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 2 });
  });

  it('skips a stale scheduled job when the monitor is no longer due', async () => {
    const m = await createMonitor(`${fixture.base}/product/stale`);
    await enqueueDueMonitors(prisma, queue, { attempts: 1, backoffMs: 0 });
    await prisma.monitor.update({ where: { id: m.id }, data: { nextCheckAt: new Date(Date.now() + 3_600_000) } });
    startWorker();
    await until(() => queue.getJobCounts('waiting', 'active'), (c) => c.waiting === 0 && c.active === 0);
    expect(await runCount(m.id)).toBe(0);
  });
});

describe('worker restart recovery', () => {
  it('continues the schedule after a restart, with fields intact', async () => {
    const m = await createMonitor(`${fixture.base}/product/restart`);
    startWorker();
    await until(() => runCount(m.id), (n) => n === 1);
    await stopWorker();

    await makeDue(m.id);
    await fixture.set('restart', { price: 'CHF 10.00' });
    startWorker();
    await until(() => runCount(m.id), (n) => n === 2);

    const run = await prisma.checkRun.findFirstOrThrow({ where: { monitorId: m.id }, orderBy: { startedAt: 'desc' }, include: { results: true } });
    expect(run.changed).toBe(true);
    expect(run.results[0]).toMatchObject({ previousValue: 'CHF 49.90', currentValue: 'CHF 10.00' });
    expect(await prisma.monitorField.count({ where: { monitorId: m.id } })).toBe(1);
  });

  it('recovers the schedule when Redis has lost everything', async () => {
    const m = await createMonitor(`${fixture.base}/product/flush`);
    startWorker();
    await until(() => runCount(m.id), (n) => n === 1);
    await stopWorker();

    await queue.obliterate({ force: true });
    await makeDue(m.id);
    startWorker();
    await until(() => runCount(m.id), (n) => n === 2);
  });

  it('finishes running checks on graceful shutdown', async () => {
    const m = await createMonitor(`${fixture.base}/slow?ms=700`);
    startWorker();
    await until(() => queue.getJobCounts('active'), (c) => c.active === 1);
    await stopWorker();
    expect(await runCount(m.id)).toBe(1);
  });

  it('checks several monitors at once within the concurrency limit', async () => {
    const monitors = await Promise.all(Array.from({ length: 6 }, () => createMonitor(`${fixture.base}/slow?ms=400`)));
    const started = Date.now();
    startWorker();
    await until(() => prisma.checkRun.count(), (n) => n === monitors.length);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(2_400);
  });
});

describe('history retention', () => {
  it('removes old runs and caps runs per monitor', async () => {
    const m = await createMonitor(`${fixture.base}/product/prune`);
    const now = Date.now();
    await prisma.checkRun.createMany({
      data: [
        { monitorId: m.id, startedAt: new Date(now - 100 * 86_400_000), durationMs: 1, status: 'SUCCESS' },
        ...Array.from({ length: 5 }, (_, i) => ({ monitorId: m.id, startedAt: new Date(now - i * 1000), durationMs: 1, status: 'SUCCESS' as const })),
      ],
    });
    const removed = await pruneHistory(prisma, 90, 3);
    expect(removed).toBe(3);
    const left = await prisma.checkRun.findMany({ where: { monitorId: m.id }, orderBy: { startedAt: 'desc' } });
    expect(left).toHaveLength(3);
    expect(left[0].startedAt.getTime()).toBe(now);
  });
});
