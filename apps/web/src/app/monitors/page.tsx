import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Badge, RunBadge, StockBadge } from '@/components/badges';
import { apiGet, type Monitor } from '@/lib/api';
import { formatInterval, formatRelative } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function MonitorsPage() {
  const monitors = await apiGet<Monitor[]>('/monitors');
  return (
    <div className="space-y-4">
      <AutoRefresh />
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Monitors</h1>
        <Link href="/monitors/new" className="btn btn-primary">New monitor</Link>
      </div>
      {monitors.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-sm text-muted">No monitors yet.</p>
          <Link href="/monitors/new" className="btn btn-primary mt-3">Create monitor</Link>
        </div>
      ) : (
        <ul className="card divide-y divide-line">
          {monitors.map((monitor) => (
            <li key={monitor.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
              <div className="min-w-0 flex-1 basis-64">
                <Link href={`/monitors/${monitor.id}`} className="font-medium text-brand hover:underline">{monitor.name}</Link>
                <p className="truncate text-xs text-muted">{monitor.url}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!monitor.enabled && <Badge tone="neutral">Paused</Badge>}
                <RunBadge status={monitor.lastRunStatus} />
                <StockBadge status={monitor.lastStockStatus} />
              </div>
              <div className="text-right text-xs text-muted">
                <p>{monitor.fields.length} field{monitor.fields.length === 1 ? '' : 's'} · {formatInterval(monitor.intervalMinutes)}</p>
                <p>Checked: {formatRelative(monitor.lastCheckAt)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
