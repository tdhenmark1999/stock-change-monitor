import Link from 'next/link';
import type { CheckRun } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Badge, FieldBadge, RunBadge, StockBadge } from './badges';

function RunRow({ run, showMonitor }: { run: CheckRun; showMonitor: boolean }) {
  const stockChanged = run.status !== 'ERROR' && run.stockStatus !== run.previousStockStatus && run.previousStockStatus !== 'UNKNOWN';
  return (
    <li className="p-3" data-testid="history-run">
      <details open={run.changed}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="tabular-nums">{formatDateTime(run.startedAt)}</span>
          {showMonitor && <Link href={`/monitors/${run.monitor.id}`} className="font-medium text-brand hover:underline">{run.monitor.name}</Link>}
          <RunBadge status={run.status} />
          {run.changed ? <Badge tone="info">Changed</Badge> : <Badge tone="neutral">No change</Badge>}
          {run.status !== 'ERROR' && <StockBadge status={run.stockStatus} />}
          <span className="ml-auto text-xs tabular-nums text-muted">{run.durationMs} ms</span>
        </summary>
        <div className="mt-3 space-y-2">
          {stockChanged && <p className="text-sm">Stock changed: {run.previousStockStatus.replaceAll('_', ' ').toLowerCase()} → {run.stockStatus.replaceAll('_', ' ').toLowerCase()}</p>}
          {run.errorMessage && <p className="rounded-md bg-red-50 p-2 text-sm text-red-800">{run.errorCode ? `${run.errorCode}: ` : ''}{run.errorMessage}</p>}
          {run.results.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">Field</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Previous</th>
                    <th scope="col" className="py-1 pr-3 font-medium">Current</th>
                    <th scope="col" className="py-1 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {run.results.map((result) => (
                    <tr key={result.id} className={`border-t border-line ${result.changed ? 'bg-sky-50/60' : ''}`}>
                      <td className="py-1.5 pr-3 font-medium">{result.fieldName}</td>
                      <td className="max-w-xs break-words py-1.5 pr-3 text-muted">{result.previousValue ?? '—'}</td>
                      <td className="max-w-xs break-words py-1.5 pr-3">{result.currentValue ?? '—'}</td>
                      <td className="py-1.5">{result.changed ? <Badge tone="info">Changed</Badge> : <FieldBadge status={result.status} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

export function HistoryList({ runs, showMonitor = false }: { runs: CheckRun[]; showMonitor?: boolean }) {
  if (runs.length === 0) {
    return <p className="p-8 text-center text-sm text-muted">No checks recorded yet.</p>;
  }
  return <ul className="divide-y divide-line">{runs.map((run) => <RunRow key={run.id} run={run} showMonitor={showMonitor} />)}</ul>;
}
