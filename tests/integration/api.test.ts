import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newPrisma, productFields, startApi, startFixture, wipe } from './helpers';

let app: INestApplication;
let prisma: PrismaClient;
let fixture: Awaited<ReturnType<typeof startFixture>>;
const api = () => request(app.getHttpServer());

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Laugenpumpe',
  url: `${fixture.base}/product/pump`,
  intervalMinutes: 30,
  fields: productFields,
  ...overrides,
});

beforeAll(async () => {
  prisma = newPrisma();
  fixture = await startFixture();
  app = await startApi();
});
afterAll(async () => {
  await app.close();
  await fixture.close();
  await prisma.$disconnect();
});
beforeEach(() => wipe(prisma));

describe('monitors', () => {
  it('creates a monitor with its fields and stores them in PostgreSQL', async () => {
    const res = await api().post('/monitors').send(body()).expect(201);
    expect(res.body.name).toBe('Laugenpumpe');
    expect(res.body.fields.map((f: { name: string }) => f.name)).toEqual(productFields.map((f) => f.name));

    const rows = await prisma.monitorField.findMany({ where: { monitorId: res.body.id }, orderBy: { position: 'asc' } });
    expect(rows).toHaveLength(5);
    expect(rows[4]).toMatchObject({ extractType: 'ATTRIBUTE', attribute: 'href', role: 'STOCK' });
  });

  it('edits name, url, interval and enabled state', async () => {
    const { body: created } = await api().post('/monitors').send(body()).expect(201);
    const res = await api().patch(`/monitors/${created.id}`).send({
      name: 'Renamed', url: `${fixture.base}/product/other`, intervalMinutes: 5, enabled: false,
    }).expect(200);
    expect(res.body).toMatchObject({ name: 'Renamed', intervalMinutes: 5, enabled: false });
    expect(res.body.url).toContain('/product/other');
    expect(res.body.fields).toHaveLength(5);
  });

  it('applies a shorter interval straight away, and leaves a sooner check alone', async () => {
    const { body: m } = await api().post('/monitors').send(body({ intervalMinutes: 10080 })).expect(201);
    const farAway = new Date(Date.now() + 7 * 86_400_000);
    await prisma.monitor.update({ where: { id: m.id }, data: { nextCheckAt: farAway } });

    await api().patch(`/monitors/${m.id}`).send({ intervalMinutes: 5 }).expect(200);
    const shortened = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } });
    expect(shortened.nextCheckAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);

    await api().patch(`/monitors/${m.id}`).send({ intervalMinutes: 60 }).expect(200);
    const lengthened = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } });
    expect(lengthened.nextCheckAt).toEqual(shortened.nextCheckAt);
  });

  it('restarts the baseline and checks soon when the URL changes', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    await prisma.monitorField.updateMany({ where: { monitorId: m.id }, data: { lastValue: 'old page', lastCheckedAt: new Date() } });
    await prisma.monitor.update({ where: { id: m.id }, data: { nextCheckAt: new Date(Date.now() + 86_400_000), lastStockStatus: 'IN_STOCK' } });

    const res = await api().patch(`/monitors/${m.id}`).send({ url: `${fixture.base}/product/elsewhere` }).expect(200);
    expect(res.body.fields.every((f: { lastValue: unknown; lastCheckedAt: unknown }) => f.lastValue === null && f.lastCheckedAt === null)).toBe(true);
    expect(res.body.lastStockStatus).toBe('UNKNOWN');
    expect(new Date(res.body.nextCheckAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the baseline when the same URL is saved again', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    await prisma.monitorField.updateMany({ where: { monitorId: m.id }, data: { lastValue: 'kept', lastCheckedAt: new Date() } });
    const res = await api().patch(`/monitors/${m.id}`).send({ url: m.url, name: 'Same page' }).expect(200);
    expect(res.body.fields[0].lastValue).toBe('kept');
  });

  it('deletes a monitor with its fields and history', async () => {
    const { body: created } = await api().post('/monitors').send(body()).expect(201);
    await prisma.checkRun.create({ data: { monitorId: created.id, startedAt: new Date(), durationMs: 1, status: 'SUCCESS' } });
    await api().delete(`/monitors/${created.id}`).expect(204);
    await api().get(`/monitors/${created.id}`).expect(404);
    expect(await prisma.monitorField.count()).toBe(0);
    expect(await prisma.checkRun.count()).toBe(0);
  });

  it('returns 404 for an unknown monitor and 400 for a malformed id', async () => {
    await api().get('/monitors/7f0e8d6a-1b2c-4d3e-8f90-123456789abc').expect(404);
    await api().get('/monitors/not-a-uuid').expect(400);
  });
});

describe('custom fields', () => {
  it('adds a field to an existing monitor', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    const res = await api().post(`/monitors/${m.id}/fields`).send({ name: 'Description', selector: '.description' }).expect(201);
    expect(res.body).toMatchObject({ name: 'Description', position: 5, role: 'TEXT' });
    const { body: reread } = await api().get(`/monitors/${m.id}`).expect(200);
    expect(reread.fields).toHaveLength(6);
  });

  it('renames a field and keeps its id and last value', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    const field = m.fields[0];
    await prisma.monitorField.update({ where: { id: field.id }, data: { lastValue: 'kept', lastCheckedAt: new Date() } });
    const res = await api().patch(`/monitors/${m.id}/fields/${field.id}`).send({ name: 'Product name' }).expect(200);
    expect(res.body).toMatchObject({ id: field.id, name: 'Product name', lastValue: 'kept' });
  });

  it('changes selector and extraction rule, and restarts the baseline', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    const field = m.fields[0];
    await prisma.monitorField.update({ where: { id: field.id }, data: { lastValue: 'old', lastCheckedAt: new Date() } });
    const res = await api().patch(`/monitors/${m.id}/fields/${field.id}`)
      .send({ selector: '.price', extractType: 'ATTRIBUTE', attribute: 'data-amount' }).expect(200);
    expect(res.body).toMatchObject({ selector: '.price', extractType: 'ATTRIBUTE', attribute: 'data-amount', lastValue: null, lastCheckedAt: null });
  });

  it('removes a field but refuses to remove the last one', async () => {
    const { body: m } = await api().post('/monitors').send(body({ fields: productFields.slice(0, 2) })).expect(201);
    await api().delete(`/monitors/${m.id}/fields/${m.fields[0].id}`).expect(204);
    await api().delete(`/monitors/${m.id}/fields/${m.fields[1].id}`).expect(400);
    expect(await prisma.monitorField.count({ where: { monitorId: m.id } })).toBe(1);
  });

  it('saves a whole field set in one request: edit, add, remove, reorder', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    const [title, price] = m.fields;
    const res = await api().patch(`/monitors/${m.id}`).send({
      fields: [
        { id: price.id, name: 'Price CHF', selector: '.price', role: 'PRICE' },
        { id: title.id, name: 'Title', selector: '.title', role: 'TEXT' },
        { name: 'Description', selector: '.description' },
      ],
    }).expect(200);
    expect(res.body.fields.map((f: { name: string }) => f.name)).toEqual(['Price CHF', 'Title', 'Description']);
    expect(res.body.fields[0].id).toBe(price.id);
  });

  it('swaps two field names in one save without a unique-name conflict', async () => {
    const { body: m } = await api().post('/monitors').send(body({ fields: productFields.slice(0, 2) })).expect(201);
    const [a, b] = m.fields;
    const res = await api().patch(`/monitors/${m.id}`).send({
      fields: [
        { id: a.id, name: b.name, selector: a.selector },
        { id: b.id, name: a.name, selector: b.selector },
      ],
    }).expect(200);
    expect(res.body.fields.map((f: { id: string }) => f.id)).toEqual([a.id, b.id]);
    expect(res.body.fields[0].name).toBe(b.name);
  });

  it('rolls the whole save back when one field in it is invalid', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    await api().patch(`/monitors/${m.id}`).send({
      name: 'Should not be saved',
      fields: [{ id: '7f0e8d6a-1b2c-4d3e-8f90-123456789abc', name: 'Foreign', selector: 'h1' }],
    }).expect(400);
    const { body: reread } = await api().get(`/monitors/${m.id}`).expect(200);
    expect(reread.name).toBe('Laugenpumpe');
    expect(reread.fields).toHaveLength(5);
  });

  it('keeps fields after the API is fully restarted', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    await api().post(`/monitors/${m.id}/fields`).send({ name: 'Description', selector: '.description' }).expect(201);

    await app.close();
    app = await startApi();

    const { body: reread } = await api().get(`/monitors/${m.id}`).expect(200);
    expect(reread.fields.map((f: { name: string }) => f.name)).toEqual([...productFields.map((f) => f.name), 'Description']);
    expect(reread.fields[4]).toMatchObject({ extractType: 'ATTRIBUTE', attribute: 'href' });
  });
});

describe('input validation', () => {
  it.each([
    ['missing name', { name: '' }],
    ['bad url', { url: 'not a url' }],
    ['interval below minimum', { intervalMinutes: 0 }],
    ['fractional interval', { intervalMinutes: 1.5 }],
    ['no fields', { fields: [] }],
    ['duplicate field names', { fields: [{ name: 'A', selector: 'h1' }, { name: 'a', selector: 'h2' }] }],
    ['field without selector', { fields: [{ name: 'A', selector: ' ' }] }],
    ['attribute rule without attribute', { fields: [{ name: 'A', selector: 'h1', extractType: 'ATTRIBUTE' }] }],
    ['unknown role', { fields: [{ name: 'A', selector: 'h1', role: 'NOPE' }] }],
  ])('rejects %s', async (_label, overrides) => {
    const res = await api().post('/monitors').send(body(overrides)).expect(400);
    expect(res.body.message).toBeTruthy();
    expect(await prisma.monitor.count()).toBe(0);
  });

  it('rejects an invalid CSS selector with a clear message', async () => {
    const res = await api().post('/monitors').send(body({ fields: [{ name: 'Bad', selector: 'div[[' }] })).expect(400);
    expect(res.body.message).toContain('Invalid CSS selector');
  });

  it('answers 409 when a new field reuses an existing name', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    await api().post(`/monitors/${m.id}/fields`).send({ name: 'Title', selector: 'h1' }).expect(409);
  });
});

describe('SSRF protection at save time', () => {
  it.each([
    'http://localhost/',
    'http://127.0.0.2/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fd00:ec2::254]/',
    'http://[::ffff:10.0.0.1]/',
    // Decimal and hex forms of 127.0.0.2. These tests allow-list exactly 127.0.0.1 for the fixture.
    'http://2130706434/',
    'http://0x7f.0.0.2/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'http://user:secret@example.com/',
    'https://example.com:6379/',
  ])('refuses %s', async (url) => {
    await api().post('/monitors').send(body({ url })).expect(400);
    expect(await prisma.monitor.count()).toBe(0);
  });

  it('also protects URL changes on an existing monitor', async () => {
    const { body: m } = await api().post('/monitors').send(body()).expect(201);
    await api().patch(`/monitors/${m.id}`).send({ url: 'http://169.254.169.254/' }).expect(400);
  });
});

describe('selector preview', () => {
  it('tests rules against the page without saving anything', async () => {
    const res = await api().post('/monitors/preview').send({ url: `${fixture.base}/product/preview`, fields: productFields }).expect(200);
    expect(res.body.fields.find((f: { name: string }) => f.name === 'Price')).toMatchObject({ status: 'OK', value: 'CHF 49.90', numeric: 49.9 });
    expect(await prisma.monitor.count()).toBe(0);
  });
});

describe('dashboard', () => {
  it('reports totals, active monitors, changes and failures', async () => {
    const { body: on } = await api().post('/monitors').send(body()).expect(201);
    await api().post('/monitors').send(body({ name: 'Paused', enabled: false })).expect(201);
    await prisma.checkRun.create({ data: { monitorId: on.id, startedAt: new Date(), durationMs: 1, status: 'SUCCESS', changed: true } });
    await prisma.checkRun.create({ data: { monitorId: on.id, startedAt: new Date(), durationMs: 1, status: 'ERROR' } });
    const { body: dash } = await api().get('/dashboard').expect(200);
    expect(dash).toMatchObject({ total: 2, active: 1, recentChanges: 1, failedChecks: 1 });
  });
});

describe('health', () => {
  it('reports database and redis status', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up', redis: 'up' });
  });
});
