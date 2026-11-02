import Link from 'next/link';
import { HistoryList } from '@/components/HistoryList';
import { apiGet, type HistoryPage, type Monitor } from '@/lib/api';

export const dynamic = 'force-dynamic';

type Search = { monitorId?: string; status?: string; changed?: string; page?: string };

function buildQuery(search: Search, overrides: Search = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...search, ...overrides })) {
    if (value) query.set(key, value);
  }
  return query.toString();
}

export default async function HistoryPageView({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const [history, monitors] = await Promise.all([
    apiGet<HistoryPage>(`/history?${buildQuery(search)}&limit=25`),
    apiGet<Monitor[]>('/monitors'),
  ]);
  const pages = Math.max(1, Math.ceil(history.total / history.limit));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Monitoring history</h1>

      <form className="card flex flex-wrap items-end gap-3 p-4" action="/history">
        <div>
          <label className="label" htmlFor="filter-monitor">Monitor</label>
          <select id="filter-monitor" name="monitorId" className="input" defaultValue={search.monitorId ?? ''}>
            <option value="">All monitors</option>
            {monitors.map((monitor) => <option key={monitor.id} value={monitor.id}>{monitor.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="filter-status">Result</label>
          <select id="filter-status" name="status" className="input" defaultValue={search.status ?? ''}>
            <option value="">All results</option>
            <option value="SUCCESS">OK</option>
            <option value="PARTIAL">Partial</option>
            <option value="ERROR">Failed</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="filter-changed">Changes</label>
          <select id="filter-changed" name="changed" className="input" defaultValue={search.changed ?? ''}>
            <option value="">All checks</option>
            <option value="true">Only changes</option>
            <option value="false">No change</option>
          </select>
        </div>
        <button type="submit" className="btn">Apply</button>
      </form>

      <section className="card"><HistoryList runs={history.items} showMonitor /></section>

      <nav aria-label="Pagination" className="flex items-center justify-between text-sm text-muted">
        <span>{history.total} check{history.total === 1 ? '' : 's'} · page {history.page} of {pages}</span>
        <span className="flex gap-2">
          {history.page > 1 && <Link className="btn" href={`/history?${buildQuery(search, { page: String(history.page - 1) })}`}>Previous</Link>}
          {history.page < pages && <Link className="btn" href={`/history?${buildQuery(search, { page: String(history.page + 1) })}`}>Next</Link>}
        </span>
      </nav>
    </div>
  );
}
