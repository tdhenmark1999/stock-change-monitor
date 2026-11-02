import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from '../logger';
import { extractFields, overallStock, valueChanged, type ExtractedField, type StockState } from './extract';
import { FetchFailure, safeFetch, type FetchPolicy } from './safe-fetch';

export interface RunSummary {
  runId: string | null;
  status: 'SUCCESS' | 'PARTIAL' | 'ERROR' | 'SKIPPED';
  changed: boolean;
}

export class CheckRunner {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: FetchPolicy,
    private readonly log: Logger,
  ) {}

  /**
   * Fetches outside any transaction, so a slow website never holds a database lock.
   * With finalAttempt=false a transient failure throws for the queue to retry, and only the last
   * attempt is written to history.
   */
  async run(monitorId: string, finalAttempt = true): Promise<RunSummary> {
    const monitor = await this.prisma.monitor.findUnique({
      where: { id: monitorId },
      include: { fields: { orderBy: { position: 'asc' } } },
    });
    if (!monitor) return { runId: null, status: 'SKIPPED', changed: false };

    const startedAt = new Date();
    const timer = performance.now();
    try {
      const page = await safeFetch(monitor.url, this.policy);
      const extracted = extractFields(page.html, monitor.fields.map((field) => ({ ...field, extractType: field.extractType, role: field.role })));
      const byFieldId = new Map<string, { config: string; result: ExtractedField }>();
      for (const [rule, result] of extracted) byFieldId.set(rule.id!, { config: ruleFingerprint(rule), result });
      return await this.recordSuccess(monitorId, monitor.url, startedAt, Math.round(performance.now() - timer), byFieldId);
    } catch (error) {
      if (!(error instanceof FetchFailure)) throw error;
      if (error.retryable && !finalAttempt) throw error;
      return this.recordFailure(monitorId, startedAt, Math.round(performance.now() - timer), error);
    }
  }

  private async recordSuccess(
    monitorId: string,
    fetchedUrl: string,
    startedAt: Date,
    durationMs: number,
    fetched: Map<string, { config: string; result: ExtractedField }>,
  ): Promise<RunSummary> {
    return this.prisma.$transaction(async (tx) => {
      // The row lock orders concurrent runs of one monitor, so "previous value" is always the latest.
      const locked = await lockMonitor(tx, monitorId);
      if (!locked) return { runId: null, status: 'SKIPPED' as const, changed: false };

      const monitor = await tx.monitor.findUniqueOrThrow({ where: { id: monitorId }, include: { fields: true } });
      // The URL was edited during the fetch, so this result describes a page the monitor no longer watches.
      if (monitor.url !== fetchedUrl) return { runId: null, status: 'SKIPPED' as const, changed: false };
      const now = new Date();
      const rows: Prisma.FieldResultCreateManyRunInput[] = [];
      const applied: ExtractedField[] = [];
      const errors: string[] = [];
      let anyChanged = false;
      let degraded = false;

      // Reads the fields again here: one edited or removed during the fetch keeps its new configuration.
      for (const field of monitor.fields) {
        const entry = fetched.get(field.id);
        if (!entry || entry.config !== ruleFingerprint(field)) continue;
        const { result } = entry;
        applied.push(result);

        if (result.status === 'INVALID_SELECTOR') {
          degraded = true;
          errors.push(`${field.name}: invalid selector (${result.error})`);
          rows.push({ fieldId: field.id, fieldName: field.name, role: field.role, status: 'INVALID_SELECTOR', previousValue: field.lastValue, currentValue: field.lastValue, changed: false });
          await tx.monitorField.update({ where: { id: field.id }, data: { lastStatus: 'INVALID_SELECTOR', lastCheckedAt: now } });
          continue;
        }

        if (result.status === 'MISSING') {
          degraded = true;
          errors.push(`${field.name}: element not found`);
        }
        const isBaseline = field.lastCheckedAt === null;
        const changed = !isBaseline && valueChanged(
          { value: field.lastValue, numeric: field.lastNumeric === null ? null : Number(field.lastNumeric) },
          { value: result.value, numeric: result.numeric },
        );
        anyChanged ||= changed;
        rows.push({ fieldId: field.id, fieldName: field.name, role: field.role, status: result.status, previousValue: field.lastValue, currentValue: result.value, changed });
        // Result columns only. This write can never affect name, selector or any other configuration.
        await tx.monitorField.update({
          where: { id: field.id },
          data: { lastValue: result.value, lastNumeric: result.numeric, lastStatus: result.status, lastCheckedAt: now },
        });
      }

      const stock: StockState = overallStock(applied);
      const status = degraded ? 'PARTIAL' as const : 'SUCCESS' as const;
      const run = await tx.checkRun.create({
        data: {
          monitorId,
          startedAt,
          durationMs,
          status,
          changed: anyChanged,
          stockStatus: stock,
          previousStockStatus: monitor.lastStockStatus,
          errorMessage: errors.length ? errors.join('; ').slice(0, 2000) : null,
          results: { createMany: { data: rows } },
        },
      });
      await tx.monitor.update({
        where: { id: monitorId },
        data: {
          lastCheckAt: now,
          lastSuccessAt: now,
          lastRunStatus: status,
          lastStockStatus: stock,
          lastError: errors.length ? errors.join('; ').slice(0, 2000) : null,
          consecutiveFailures: 0,
          nextCheckAt: new Date(now.getTime() + monitor.intervalMinutes * 60_000),
        },
      });
      this.log.info({ monitorId, runId: run.id, status, changed: anyChanged, stock, durationMs }, 'check completed');
      return { runId: run.id, status, changed: anyChanged };
    });
  }

  private async recordFailure(monitorId: string, startedAt: Date, durationMs: number, failure: FetchFailure): Promise<RunSummary> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockMonitor(tx, monitorId);
      if (!locked) return { runId: null, status: 'SKIPPED' as const, changed: false };
      const monitor = await tx.monitor.findUniqueOrThrow({ where: { id: monitorId } });
      const now = new Date();
      const run = await tx.checkRun.create({
        data: {
          monitorId,
          startedAt,
          durationMs,
          status: 'ERROR',
          stockStatus: 'UNKNOWN',
          previousStockStatus: monitor.lastStockStatus,
          errorCode: failure.code,
          errorMessage: failure.message.slice(0, 2000),
        },
      });
      const interval = monitor.intervalMinutes * 60_000;
      await tx.monitor.update({
        where: { id: monitorId },
        data: {
          lastCheckAt: now,
          lastRunStatus: 'ERROR',
          lastError: failure.message.slice(0, 2000),
          consecutiveFailures: { increment: 1 },
          // A site's Retry-After is respected when it asks for longer than the normal interval.
          nextCheckAt: new Date(now.getTime() + Math.max(interval, failure.retryAfterMs ?? 0)),
        },
      });
      this.log.warn({ monitorId, runId: run.id, code: failure.code, durationMs }, 'check failed');
      return { runId: run.id, status: 'ERROR', changed: false };
    });
  }
}

async function lockMonitor(tx: Prisma.TransactionClient, monitorId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>`SELECT id FROM "Monitor" WHERE id = ${monitorId} FOR UPDATE`;
  return rows.length > 0;
}

function ruleFingerprint(rule: { selector: string; extractType: string; attribute?: string | null; role: string }): string {
  return JSON.stringify([rule.selector, rule.extractType, rule.attribute ?? null, rule.role]);
}
