import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { FieldInput, MonitorCreate, MonitorUpdate } from '@esm/shared';
import { CHECK_QUEUE, CONFIG } from '../tokens';
import { extractFields, selectorError, type FieldRule } from '../checks/extract';
import { assertUrlAllowed, safeFetch } from '../checks/safe-fetch';
import type { AppConfig } from '../config';
import { enqueueManualCheck, REDIS_TIMEOUT_MS, withTimeout, type CheckJobData } from '../queue/check-queue';

const fieldsInOrder = { fields: { orderBy: { position: 'asc' as const } } };

// Changing how a value is read restarts its baseline, otherwise the edit itself looks like a page change.
const clearedResult = { lastValue: null, lastNumeric: null, lastStatus: null, lastCheckedAt: null };

function toFieldData(field: Partial<FieldInput>) {
  return {
    ...(field.name !== undefined && { name: field.name }),
    ...(field.selector !== undefined && { selector: field.selector }),
    ...(field.extractType !== undefined && { extractType: field.extractType }),
    ...(field.extractType !== undefined && { attribute: field.extractType === 'ATTRIBUTE' ? field.attribute ?? null : null }),
    ...(field.role !== undefined && { role: field.role }),
    ...(field.inStockTerms !== undefined && { inStockTerms: field.inStockTerms }),
    ...(field.outOfStockTerms !== undefined && { outOfStockTerms: field.outOfStockTerms }),
  };
}

function readingRuleChanged(
  before: { selector: string; extractType: string; attribute: string | null; role: string },
  next: Partial<FieldInput>,
): boolean {
  return (
    (next.selector !== undefined && next.selector !== before.selector) ||
    (next.extractType !== undefined && next.extractType !== before.extractType) ||
    (next.attribute !== undefined && (next.attribute ?? null) !== before.attribute) ||
    (next.role !== undefined && next.role !== before.role)
  );
}

function assertSelectorsValid(fields: { name?: string; selector?: string }[]) {
  for (const field of fields) {
    if (!field.selector) continue;
    const error = selectorError(field.selector);
    if (error) throw new BadRequestException(`Invalid CSS selector for "${field.name ?? field.selector}": ${error}`);
  }
}

@Injectable()
export class MonitorsService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CHECK_QUEUE) private readonly queue: Queue<CheckJobData>,
  ) {}

  list() {
    return this.prisma.monitor.findMany({ include: fieldsInOrder, orderBy: { createdAt: 'desc' } });
  }

  async get(id: string) {
    const monitor = await this.prisma.monitor.findUnique({ where: { id }, include: fieldsInOrder });
    if (!monitor) throw new NotFoundException('Monitor not found');
    return monitor;
  }

  async create(input: MonitorCreate) {
    await assertUrlAllowed(input.url, this.config.fetch.allowHosts);
    assertSelectorsValid(input.fields);
    const { fields, ...monitor } = input;
    return this.prisma.monitor.create({
      data: {
        ...monitor,
        fields: { create: fields.map((field, position) => ({ selector: field.selector, name: field.name, ...toFieldData(field), position })) },
      },
      include: fieldsInOrder,
    });
  }

  async update(id: string, input: MonitorUpdate) {
    if (input.url) await assertUrlAllowed(input.url, this.config.fetch.allowHosts);
    if (input.fields) assertSelectorsValid(input.fields);
    const { fields, ...monitor } = input;

    // One transaction: the configuration is saved completely or not at all.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.monitor.findUnique({ where: { id }, include: { fields: true } });
      if (!existing) throw new NotFoundException('Monitor not found');

      const urlChanged = monitor.url !== undefined && monitor.url !== existing.url;
      const now = Date.now();
      let nextCheckAt: Date | undefined;
      if ((monitor.enabled === true && !existing.enabled) || urlChanged) {
        // Re-enabling or watching a new page starts checking now, not after the old schedule.
        nextCheckAt = new Date(now);
      } else if (monitor.intervalMinutes !== undefined) {
        // A shorter interval applies straight away instead of waiting out the longer one.
        const soonest = now + monitor.intervalMinutes * 60_000;
        if (soonest < existing.nextCheckAt.getTime()) nextCheckAt = new Date(soonest);
      }
      await tx.monitor.update({ where: { id }, data: { ...monitor, ...(nextCheckAt && { nextCheckAt }) } });
      if (urlChanged) {
        // Another page has nothing to compare with, and its first check must not read as a change.
        await tx.monitorField.updateMany({ where: { monitorId: id }, data: clearedResult });
        await tx.monitor.update({ where: { id }, data: { lastStockStatus: 'UNKNOWN', lastError: null } });
      }

      if (fields) {
        const byId = new Map(existing.fields.map((field) => [field.id, field]));
        for (const field of fields) {
          if (field.id && !byId.has(field.id)) throw new BadRequestException(`Field ${field.id} does not belong to this monitor`);
        }
        const keep = new Set(fields.map((field) => field.id).filter(Boolean));
        const removed = existing.fields.filter((field) => !keep.has(field.id)).map((field) => field.id);
        await tx.monitorField.deleteMany({ where: { id: { in: removed } } });

        // Temporary names first, so swapping two field names cannot hit the unique constraint midway.
        for (const field of fields) {
          if (field.id) await tx.monitorField.update({ where: { id: field.id }, data: { name: `__rename_${field.id}` } });
        }
        for (const [position, field] of fields.entries()) {
          const before = field.id ? byId.get(field.id) : undefined;
          if (before) {
            await tx.monitorField.update({
              where: { id: before.id },
              data: { ...toFieldData(field), position, ...(readingRuleChanged(before, field) ? clearedResult : {}) },
            });
          } else {
            await tx.monitorField.create({ data: { monitorId: id, name: field.name, selector: field.selector, ...toFieldData(field), position } });
          }
        }
      }
      return tx.monitor.findUniqueOrThrow({ where: { id }, include: fieldsInOrder });
    });
  }

  async remove(id: string) {
    await this.prisma.monitor.delete({ where: { id } });
  }

  async addField(monitorId: string, input: Omit<FieldInput, 'id'>) {
    assertSelectorsValid([input]);
    await this.get(monitorId);
    const position = await this.prisma.monitorField.count({ where: { monitorId } });
    return this.prisma.monitorField.create({
      data: { monitorId, name: input.name, selector: input.selector, ...toFieldData(input), position },
    });
  }

  async updateField(monitorId: string, fieldId: string, input: Partial<FieldInput>) {
    assertSelectorsValid([input]);
    const before = await this.prisma.monitorField.findFirst({ where: { id: fieldId, monitorId } });
    if (!before) throw new NotFoundException('Field not found');
    return this.prisma.monitorField.update({
      where: { id: fieldId },
      data: { ...toFieldData(input), ...(readingRuleChanged(before, input) ? clearedResult : {}) },
    });
  }

  async removeField(monitorId: string, fieldId: string) {
    const count = await this.prisma.monitorField.count({ where: { monitorId } });
    const field = await this.prisma.monitorField.findFirst({ where: { id: fieldId, monitorId } });
    if (!field) throw new NotFoundException('Field not found');
    if (count <= 1) throw new BadRequestException('A monitor needs at least one field');
    await this.prisma.monitorField.delete({ where: { id: fieldId } });
  }

  async triggerCheck(id: string) {
    await this.get(id);
    const { attempts, backoffMs } = this.config.worker;
    await withTimeout(enqueueManualCheck(this.queue, id, { attempts, backoffMs }), REDIS_TIMEOUT_MS).catch(() => {
      throw new ServiceUnavailableException('The check queue is not available right now. Your monitors are safe, try again shortly.');
    });
    return { queued: true };
  }

  /** Runs the rules against the live page without saving anything, so selectors can be tried first. */
  async preview(url: string, fields: FieldInput[]) {
    await assertUrlAllowed(url, this.config.fetch.allowHosts);
    const page = await safeFetch(url, this.config.fetch);
    const rules: FieldRule[] = fields.map((field) => ({ ...field, attribute: field.attribute ?? null }));
    const extracted = extractFields(page.html, rules);
    return {
      finalUrl: page.finalUrl,
      fields: rules.map((rule) => {
        const result = extracted.get(rule)!;
        return { name: rule.name, status: result.status, value: result.value, stock: result.stock, numeric: result.numeric, error: result.error ?? null };
      }),
    };
  }

  history(query: { monitorId?: string; status?: 'SUCCESS' | 'PARTIAL' | 'ERROR'; changed?: 'true' | 'false'; page: number; limit: number }) {
    const where: Prisma.CheckRunWhereInput = {
      ...(query.monitorId && { monitorId: query.monitorId }),
      ...(query.status && { status: query.status }),
      ...(query.changed && { changed: query.changed === 'true' }),
    };
    return this.prisma.$transaction([
      this.prisma.checkRun.findMany({
        where,
        include: { results: { orderBy: { fieldName: 'asc' } }, monitor: { select: { id: true, name: true } } },
        orderBy: { startedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.checkRun.count({ where }),
    ]).then(([items, total]) => ({ items, total, page: query.page, limit: query.limit }));
  }

  async dashboard() {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const [total, active, recentChanges, failedChecks, lastSuccess, changes, failing] = await Promise.all([
      this.prisma.monitor.count(),
      this.prisma.monitor.count({ where: { enabled: true } }),
      this.prisma.checkRun.count({ where: { changed: true, startedAt: { gte: dayAgo } } }),
      this.prisma.checkRun.count({ where: { status: 'ERROR', startedAt: { gte: dayAgo } } }),
      this.prisma.monitor.findMany({
        where: { lastSuccessAt: { not: null } },
        orderBy: { lastSuccessAt: 'desc' },
        take: 5,
        select: { id: true, name: true, lastSuccessAt: true, lastStockStatus: true },
      }),
      this.prisma.checkRun.findMany({
        where: { changed: true },
        orderBy: { startedAt: 'desc' },
        take: 8,
        include: { monitor: { select: { id: true, name: true } }, results: { where: { changed: true } } },
      }),
      this.prisma.monitor.findMany({
        where: { lastRunStatus: 'ERROR' },
        orderBy: { lastCheckAt: 'desc' },
        take: 5,
        select: { id: true, name: true, lastError: true, lastCheckAt: true, consecutiveFailures: true },
      }),
    ]);
    return { total, active, recentChanges, failedChecks, lastSuccess, changes, failing };
  }
}
