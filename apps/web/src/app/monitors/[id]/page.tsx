import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/AutoRefresh';
import { Badge, FieldBadge, RunBadge, StockBadge } from '@/components/badges';
import { HistoryList } from '@/components/HistoryList';
import { MonitorActions } from '@/components/MonitorActions';
import { ApiError, apiGet, type HistoryPage, type Monitor } from '@/lib/api';
import { formatDateTime, formatInterval, formatRelative } from '@/lib/format';

export const dynamic = 'force-dynamic';

const roleNames = { TEXT: 'Text', PRICE: 'Price', STOCK: 'Stock status', QUANTITY: 'Stock quantity' };

export default async function MonitorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const safeId = encodeURIComponent(id);
  const monitor = await apiGet<Monitor>(`/monitors/${safeId}`).catch((error) => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  const history = await apiGet<HistoryPage>(`/history?monitorId=${safeId}&limit=10`);

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{monitor.name}</h1>
          <a href={monitor.url} target="_blank" rel="noreferrer noopener" className="break-all text-sm text-brand hover:underline">{monitor.url}</a>
        </div>
        <MonitorActions id={monitor.id} enabled={monitor.enabled} />
      </div>

      <section aria-label="Status" className="card grid grid-cols-2 gap-4 p-4 text-sm lg:grid-cols-4">
        <div>
          <p className="text-muted">Status</p>
          <p className="mt-1 flex flex-wrap gap-1">{monitor.enabled ? <Badge tone="good">Active</Badge> : <Badge tone="neutral">Paused</Badge>}<RunBadge status={monitor.lastRunStatus} /></p>
        </div>
        <div>
          <p className="text-muted">Availability</p>
          <p className="mt-1"><StockBadge status={monitor.lastStockStatus} /></p>
        </div>
        <div>
          <p className="text-muted">Last check</p>
          <p className="mt-1" title={formatDateTime(monitor.lastCheckAt)}>{formatRelative(monitor.lastCheckAt)}</p>
        </div>
        <div>
          <p className="text-muted">Next check</p>
          <p className="mt-1">{monitor.enabled ? formatRelative(monitor.nextCheckAt) : 'Paused'}</p>
          <p className="hint">{formatInterval(monitor.intervalMinutes)}</p>
        </div>
      </section>

      {monitor.lastError && (
        <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {monitor.lastRunStatus === 'ERROR' ? `Last check failed (${monitor.consecutiveFailures} in a row): ` : 'Last check had a problem: '}
          {monitor.lastError}
        </p>
      )}

      <section className="card">
        <h2 className="border-b border-line p-4 font-semibold">Monitored fields ({monitor.fields.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Field</th>
                <th scope="col" className="px-4 py-2 font-medium">Selector</th>
                <th scope="col" className="px-4 py-2 font-medium">Type</th>
                <th scope="col" className="px-4 py-2 font-medium">Current value</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {monitor.fields.map((field) => (
                <tr key={field.id} className="border-t border-line" data-testid="field">
                  <td className="px-4 py-2 font-medium">{field.name}</td>
                  <td className="px-4 py-2 font-mono text-xs">{field.selector}{field.attribute ? ` @${field.attribute}` : ''}</td>
                  <td className="px-4 py-2">{roleNames[field.role]}</td>
                  <td className="max-w-xs break-words px-4 py-2">{field.lastValue ?? '—'}</td>
                  <td className="px-4 py-2"><FieldBadge status={field.lastStatus} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="flex items-center justify-between border-b border-line p-4">
          <h2 className="font-semibold">Recent history</h2>
          <Link href={`/history?monitorId=${monitor.id}`} className="text-sm text-brand hover:underline">View all ({history.total})</Link>
        </div>
        <HistoryList runs={history.items} />
      </section>
    </div>
  );
}
