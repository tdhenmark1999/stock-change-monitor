import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Badge, StockBadge } from '@/components/badges';
import { apiGet, type Dashboard } from '@/lib/api';
import { formatRelative } from '@/lib/format';

export const dynamic = 'force-dynamic';

function Metric({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export default async function DashboardPage() {
  const data = await apiGet<Dashboard>('/dashboard');

  if (data.total === 0) {
    return (
      <div className="card p-10 text-center">
        <h1 className="text-xl font-semibold">Start monitoring your first page</h1>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">Add a product page and choose the fields to watch, such as price and availability.</p>
        <Link href="/monitors/new" className="btn btn-primary mt-4">Create monitor</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Link href="/monitors/new" className="btn btn-primary">New monitor</Link>
      </div>

      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Total monitors" value={data.total} />
        <Metric label="Active monitors" value={data.active} />
        <Metric label="Recent changes" value={data.recentChanges} hint="Last 24 hours" />
        <Metric label="Failed checks" value={data.failedChecks} hint="Last 24 hours" />
      </section>

      {data.failing.length > 0 && (
        <section className="card border-red-200 p-4">
          <h2 className="font-semibold">Needs attention</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {data.failing.map((monitor) => (
              <li key={monitor.id} className="py-2">
                <Link href={`/monitors/${monitor.id}`} className="font-medium text-brand hover:underline">{monitor.name}</Link>
                <span className="text-muted"> · {monitor.consecutiveFailures} failed in a row · {monitor.lastError}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="font-semibold">Recent changes</h2>
          {data.changes.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No changes detected yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line text-sm">
              {data.changes.map((run) => (
                <li key={run.id} className="py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/monitors/${run.monitor.id}`} className="font-medium text-brand hover:underline">{run.monitor.name}</Link>
                    <span className="text-xs text-muted">{formatRelative(run.startedAt)}</span>
                  </div>
                  {run.results.map((result) => (
                    <p key={result.id} className="break-words text-muted">
                      {result.fieldName}: {result.previousValue ?? '—'} → <span className="text-ink">{result.currentValue ?? '—'}</span>
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-4">
          <h2 className="font-semibold">Last successful checks</h2>
          {data.lastSuccess.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No successful checks yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line text-sm">
              {data.lastSuccess.map((monitor) => (
                <li key={monitor.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/monitors/${monitor.id}`} className="font-medium text-brand hover:underline">{monitor.name}</Link>
                  <span className="flex items-center gap-2">
                    <StockBadge status={monitor.lastStockStatus} />
                    <Badge tone="neutral">{formatRelative(monitor.lastSuccessAt)}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
