import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CheckRunner } from '../../apps/api/src/checks/check-runner';
import { FetchFailure, safeFetch } from '../../apps/api/src/checks/safe-fetch';
import { newPrisma, productFields, silentLog, startFixture, testPolicy, wipe } from './helpers';

let prisma: PrismaClient;
let fixture: Awaited<ReturnType<typeof startFixture>>;
let runner: CheckRunner;

const createMonitor = (url: string, fields: Record<string, unknown>[] = productFields) =>
  prisma.monitor.create({
    data: {
      name: 'm',
      url,
      fields: { create: fields.map((field, position) => ({ ...(field as { name: string; selector: string }), position })) },
    },
    include: { fields: true },
  });

const latestRun = (monitorId: string) =>
  prisma.checkRun.findFirstOrThrow({ where: { monitorId }, orderBy: { startedAt: 'desc' }, include: { results: true } });

const resultFor = (run: Awaited<ReturnType<typeof latestRun>>, name: string) => run.results.find((r) => r.fieldName === name)!;

beforeAll(async () => {
  prisma = newPrisma();
  fixture = await startFixture();
  runner = new CheckRunner(prisma, testPolicy, silentLog);
});
afterAll(async () => {
  await fixture.close();
  await prisma.$disconnect();
});
beforeEach(() => wipe(prisma));

describe('monitoring execution', () => {
  it('records a first run as a baseline with no change', async () => {
    const m = await createMonitor(`${fixture.base}/product/baseline`);
    const summary = await runner.run(m.id);
    expect(summary).toMatchObject({ status: 'SUCCESS', changed: false });

    const run = await latestRun(m.id);
    expect(run).toMatchObject({ monitorId: m.id, status: 'SUCCESS', changed: false, stockStatus: 'IN_STOCK', errorMessage: null });
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(resultFor(run, 'Price')).toMatchObject({ previousValue: null, currentValue: 'CHF 49.90', changed: false, status: 'OK' });

    const monitor = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } });
    expect(monitor.lastSuccessAt).not.toBeNull();
    expect(monitor.lastStockStatus).toBe('IN_STOCK');
    expect(monitor.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('reads attribute values', async () => {
    const m = await createMonitor(`${fixture.base}/product/attr`);
    await runner.run(m.id);
    expect(resultFor(await latestRun(m.id), 'Schema').currentValue).toBe('https://schema.org/InStock');
  });
});

describe('change detection', () => {
  it('reports nothing when the page is unchanged', async () => {
    const m = await createMonitor(`${fixture.base}/product/same`);
    await runner.run(m.id);
    expect((await runner.run(m.id)).changed).toBe(false);
    expect((await latestRun(m.id)).results.every((r) => !r.changed)).toBe(true);
  });

  it('detects a text change with previous and current values', async () => {
    const m = await createMonitor(`${fixture.base}/product/text`);
    await runner.run(m.id);
    await fixture.set('text', { title: 'Neuer Titel' });
    expect((await runner.run(m.id)).changed).toBe(true);
    const run = await latestRun(m.id);
    expect(resultFor(run, 'Title')).toMatchObject({ previousValue: 'Laugenpumpe Bosch 00144978', currentValue: 'Neuer Titel', changed: true });
    expect(resultFor(run, 'Price').changed).toBe(false);
  });

  it('detects a price change', async () => {
    const m = await createMonitor(`${fixture.base}/product/price`);
    await runner.run(m.id);
    await fixture.set('price', { price: "CHF 1'299.50" });
    await runner.run(m.id);
    expect(resultFor(await latestRun(m.id), 'Price')).toMatchObject({ previousValue: 'CHF 49.90', currentValue: "CHF 1'299.50", changed: true });
  });

  it('does not report a price change when only the format changes', async () => {
    const m = await createMonitor(`${fixture.base}/product/format`);
    await fixture.set('format', { price: 'CHF 1299.50' });
    await runner.run(m.id);
    await fixture.set('format', { price: "1'299.50 Fr." });
    await runner.run(m.id);
    expect(resultFor(await latestRun(m.id), 'Price').changed).toBe(false);
  });

  it('detects a stock quantity change', async () => {
    const m = await createMonitor(`${fixture.base}/product/qty`);
    await runner.run(m.id);
    await fixture.set('qty', { quantity: 3 });
    await runner.run(m.id);
    const run = await latestRun(m.id);
    expect(resultFor(run, 'Quantity')).toMatchObject({ previousValue: '12', currentValue: '3', changed: true });
    expect(run.stockStatus).toBe('IN_STOCK');
  });
});

describe('stock availability', () => {
  it('detects in stock changing to out of stock and back', async () => {
    const m = await createMonitor(`${fixture.base}/product/avail`, [{ name: 'Availability', selector: '.stock', role: 'STOCK' }]);
    await runner.run(m.id);
    expect((await latestRun(m.id)).stockStatus).toBe('IN_STOCK');

    await fixture.set('avail', { stock: 'Nicht verfügbar' });
    await runner.run(m.id);
    expect(await latestRun(m.id)).toMatchObject({ stockStatus: 'OUT_OF_STOCK', previousStockStatus: 'IN_STOCK', changed: true });
    expect((await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } })).lastStockStatus).toBe('OUT_OF_STOCK');

    await fixture.set('avail', { stock: 'Auf Lager' });
    await runner.run(m.id);
    expect(await latestRun(m.id)).toMatchObject({ stockStatus: 'IN_STOCK', previousStockStatus: 'OUT_OF_STOCK', changed: true });
  });

  it('treats quantity zero as out of stock', async () => {
    const m = await createMonitor(`${fixture.base}/product/zero`, [{ name: 'Quantity', selector: '.qty', role: 'QUANTITY' }]);
    await fixture.set('zero', { quantity: 0 });
    await runner.run(m.id);
    expect((await latestRun(m.id)).stockStatus).toBe('OUT_OF_STOCK');
  });

  it('stays unknown when the text says nothing about stock', async () => {
    const m = await createMonitor(`${fixture.base}/product/vague`, [{ name: 'Availability', selector: '.stock', role: 'STOCK' }]);
    await fixture.set('vague', { stock: 'Bitte anfragen' });
    await runner.run(m.id);
    expect((await latestRun(m.id)).stockStatus).toBe('UNKNOWN');
  });

  it('uses the terms configured on the field', async () => {
    const m = await createMonitor(`${fixture.base}/product/custom`, [
      { name: 'Availability', selector: '.stock', role: 'STOCK', outOfStockTerms: ['Bitte anfragen'] },
    ]);
    await fixture.set('custom', { stock: 'Bitte anfragen' });
    await runner.run(m.id);
    expect((await latestRun(m.id)).stockStatus).toBe('OUT_OF_STOCK');
  });
});

describe('missing elements and invalid selectors', () => {
  it('reports a missing element as a change, then as stable', async () => {
    const m = await createMonitor(`${fixture.base}/product/gone`);
    await runner.run(m.id);
    await fixture.set('gone', { hidden: ['price'] });

    expect((await runner.run(m.id)).status).toBe('PARTIAL');
    let run = await latestRun(m.id);
    expect(resultFor(run, 'Price')).toMatchObject({ status: 'MISSING', previousValue: 'CHF 49.90', currentValue: null, changed: true });
    expect(run.errorMessage).toContain('Price: element not found');

    await runner.run(m.id);
    run = await latestRun(m.id);
    expect(resultFor(run, 'Price')).toMatchObject({ status: 'MISSING', changed: false });
  });

  it('does not crash on a selector that became invalid, and other fields still work', async () => {
    // The API refuses invalid selectors, so this one is written straight to the database.
    const m = await createMonitor(`${fixture.base}/product/invalid`, [
      { name: 'Broken', selector: 'div[[' },
      { name: 'Price', selector: '.price', role: 'PRICE' },
    ]);
    const summary = await runner.run(m.id);
    expect(summary.status).toBe('PARTIAL');
    const run = await latestRun(m.id);
    expect(resultFor(run, 'Broken').status).toBe('INVALID_SELECTOR');
    expect(resultFor(run, 'Price').currentValue).toBe('CHF 49.90');
    expect(run.errorMessage).toContain('invalid selector');
  });
});

describe('pages with unusual values', () => {
  it('records a run for a number too large to store, instead of failing forever', async () => {
    const m = await createMonitor(`${fixture.base}/product/giant`, [{ name: 'Price', selector: '.price', role: 'PRICE' }]);
    await fixture.set('giant', { price: '123456789012345678901234567890' });
    await expect(runner.run(m.id)).resolves.toMatchObject({ status: 'SUCCESS' });
    expect(resultFor(await latestRun(m.id), 'Price').currentValue).toBe('123456789012345678901234567890');
  });
});

describe('website failures', () => {
  it('records a timeout as a failed run on the final attempt', async () => {
    const m = await createMonitor(`${fixture.base}/slow?ms=10000`);
    const summary = await runner.run(m.id, true);
    expect(summary.status).toBe('ERROR');
    expect(await latestRun(m.id)).toMatchObject({ status: 'ERROR', errorCode: 'TIMEOUT' });
    const monitor = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } });
    expect(monitor).toMatchObject({ lastRunStatus: 'ERROR', consecutiveFailures: 1 });
    expect(monitor.lastError).toContain('did not respond');
  });

  it('throws for the queue to retry, and writes no history, before the final attempt', async () => {
    const m = await createMonitor(`${fixture.base}/slow?ms=10000`);
    await expect(runner.run(m.id, false)).rejects.toBeInstanceOf(FetchFailure);
    expect(await prisma.checkRun.count({ where: { monitorId: m.id } })).toBe(0);
  });

  it('clears the failure count after a success', async () => {
    const m = await createMonitor(`${fixture.base}/status?code=500`);
    await runner.run(m.id);
    await prisma.monitor.update({ where: { id: m.id }, data: { url: `${fixture.base}/product/ok` } });
    await runner.run(m.id);
    expect(await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ consecutiveFailures: 0, lastError: null });
  });

  it.each([
    ['/status?code=404', 'HTTP_ERROR', false],
    ['/status?code=503', 'HTTP_ERROR', true],
    ['/blocked', 'BOT_PROTECTION', false],
    ['/pdf', 'UNSUPPORTED_CONTENT', false],
    ['/huge', 'RESPONSE_TOO_LARGE', false],
  ])('classifies %s as %s', async (path, code, retryable) => {
    const error = await safeFetch(`${fixture.base}${path}`, testPolicy).catch((e) => e);
    expect(error).toBeInstanceOf(FetchFailure);
    expect(error).toMatchObject({ code, retryable });
  });

  it('respects Retry-After by delaying the next check', async () => {
    const m = await createMonitor(`${fixture.base}/status?code=429&retry=7200`);
    await runner.run(m.id);
    expect(await latestRun(m.id)).toMatchObject({ errorCode: 'RATE_LIMITED' });
    const monitor = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } });
    expect(monitor.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 7_000_000);
  });
});

describe('SSRF protection at fetch time', () => {
  const noAllowList = { ...testPolicy, allowHosts: [] };

  it('blocks a URL that became private after it was saved', async () => {
    const error = await safeFetch(`${fixture.base}/product/x`, noAllowList).catch((e) => e);
    expect(error).toMatchObject({ code: 'BLOCKED_URL' });
  });

  it.each(['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'file:///etc/passwd'])(
    'blocks a redirect from an allowed page to %s',
    async (target) => {
      const error = await safeFetch(`${fixture.base}/redirect?to=${encodeURIComponent(target)}`, testPolicy).catch((e) => e);
      expect(error).toMatchObject({ code: 'BLOCKED_URL' });
    },
  );

  it('stops redirect loops', async () => {
    const loop = `${fixture.base}/redirect?to=${encodeURIComponent('/redirect?to=/redirect%3Fto%3D/redirect')}`;
    const error = await safeFetch(loop, testPolicy).catch((e) => e);
    expect(error).toBeInstanceOf(FetchFailure);
  });

  it('records a blocked URL as a failed run without crashing', async () => {
    const m = await createMonitor('http://169.254.169.254/latest/meta-data/');
    expect((await runner.run(m.id)).status).toBe('ERROR');
    expect(await latestRun(m.id)).toMatchObject({ errorCode: 'BLOCKED_URL' });
  });
});

describe('the persistence guarantee: a check can never undo a configuration edit', () => {
  it('keeps a field added while a check is running', async () => {
    const m = await createMonitor(`${fixture.base}/slow?ms=400`, [{ name: 'Price', selector: '.price', role: 'PRICE' }]);
    const running = runner.run(m.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await prisma.monitorField.create({ data: { monitorId: m.id, name: 'Added mid-check', selector: '.stock', position: 1 } });
    await prisma.monitor.update({ where: { id: m.id }, data: { name: 'Renamed mid-check' } });
    await running;

    const reread = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id }, include: { fields: true } });
    expect(reread.name).toBe('Renamed mid-check');
    expect(reread.fields.map((f) => f.name).sort()).toEqual(['Added mid-check', 'Price']);
  });

  it('keeps a selector edited while a check is running, and does not apply the old reading to it', async () => {
    const m = await createMonitor(`${fixture.base}/slow?ms=400`, [{ name: 'Price', selector: '.price', role: 'PRICE' }]);
    const running = runner.run(m.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await prisma.monitorField.update({ where: { id: m.fields[0].id }, data: { selector: '.title' } });
    await running;
    const field = await prisma.monitorField.findUniqueOrThrow({ where: { id: m.fields[0].id } });
    expect(field).toMatchObject({ selector: '.title', lastValue: null });
  });

  it('survives a field removed while a check is running', async () => {
    const m = await createMonitor(`${fixture.base}/slow?ms=400`);
    const running = runner.run(m.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await prisma.monitorField.delete({ where: { id: m.fields[0].id } });
    await expect(running).resolves.toMatchObject({ status: 'SUCCESS' });
    expect(await prisma.monitorField.count({ where: { monitorId: m.id } })).toBe(productFields.length - 1);
  });

  it('discards a result when the URL is edited during the check', async () => {
    const m = await createMonitor(`${fixture.base}/slow?ms=400`);
    const running = runner.run(m.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await prisma.monitor.update({ where: { id: m.id }, data: { url: `${fixture.base}/product/new-url` } });
    await expect(running).resolves.toMatchObject({ status: 'SKIPPED' });
    expect(await prisma.checkRun.count({ where: { monitorId: m.id } })).toBe(0);
  });

  it('skips cleanly when the monitor is deleted during a check', async () => {
    const m = await createMonitor(`${fixture.base}/slow?ms=400`);
    const running = runner.run(m.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await prisma.monitor.delete({ where: { id: m.id } });
    await expect(running).resolves.toMatchObject({ status: 'SKIPPED' });
  });

  it('keeps history readable after a field is renamed or removed', async () => {
    const m = await createMonitor(`${fixture.base}/product/hist`, [
      { name: 'Price', selector: '.price', role: 'PRICE' },
      { name: 'Title', selector: '.title' },
    ]);
    await runner.run(m.id);
    const price = m.fields.find((f) => f.name === 'Price')!;
    await prisma.monitorField.delete({ where: { id: price.id } });
    const results = await prisma.fieldResult.findMany({ where: { fieldName: 'Price' } });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ fieldId: null, currentValue: 'CHF 49.90' });
  });
});
