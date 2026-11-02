import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
// @ts-expect-error plain JavaScript fixture
import { createFixture } from '../../fixture/server.mjs';

// Tests wipe tables, so they refuse to run against anything except the throwaway test database.
export function assertTestDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://none/none');
  if (url.pathname !== '/esm_test') {
    throw new Error(`Refusing to run: DATABASE_URL must point at esm_test, got ${url.pathname}`);
  }
}

export const newPrisma = () => {
  assertTestDatabase();
  return new PrismaClient();
};

export async function wipe(prisma: PrismaClient) {
  assertTestDatabase();
  await prisma.$executeRaw`TRUNCATE "Monitor" CASCADE`;
}

export async function startFixture() {
  const server: Server = createFixture();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    set: (slug: string, state: Record<string, unknown>) =>
      fetch(`${base}/__state/${slug}`, { method: 'POST', body: JSON.stringify(state) }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startApi(): Promise<INestApplication> {
  assertTestDatabase();
  process.env.SSRF_ALLOW_HOSTS = '127.0.0.1';
  const { AppModule } = await import('../../apps/api/src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  return app;
}

export const silentLog = { info() {}, warn() {}, error() {}, debug() {} } as never;

export const testPolicy = { timeoutMs: 2_000, maxBytes: 5 * 1024 * 1024, allowHosts: ['127.0.0.1'] };

export const productFields = [
  { name: 'Title', selector: '.title', role: 'TEXT' },
  { name: 'Price', selector: '.price', role: 'PRICE' },
  { name: 'Availability', selector: '.stock', role: 'STOCK' },
  { name: 'Quantity', selector: '.qty', role: 'QUANTITY' },
  { name: 'Schema', selector: '.availability', role: 'STOCK', extractType: 'ATTRIBUTE', attribute: 'href' },
];

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Condition not met in ${timeoutMs}ms, last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
