import type { FieldStatus, RunStatus, StockStatus } from '@/lib/api';

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

const tones: Record<Tone, string> = {
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  bad: 'bg-red-50 text-red-800 ring-red-200',
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  info: 'bg-sky-50 text-sky-800 ring-sky-200',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>{children}</span>;
}

const stock: Record<StockStatus, [Tone, string]> = {
  IN_STOCK: ['good', 'In stock'],
  OUT_OF_STOCK: ['bad', 'Out of stock'],
  UNKNOWN: ['neutral', 'Stock unknown'],
};
export const StockBadge = ({ status }: { status: StockStatus }) => <Badge tone={stock[status][0]}>{stock[status][1]}</Badge>;

const run: Record<RunStatus, [Tone, string]> = {
  SUCCESS: ['good', 'OK'],
  PARTIAL: ['warn', 'Partial'],
  ERROR: ['bad', 'Failed'],
};
export function RunBadge({ status }: { status: RunStatus | null }) {
  if (!status) return <Badge tone="neutral">Not checked yet</Badge>;
  return <Badge tone={run[status][0]}>{run[status][1]}</Badge>;
}

const field: Record<FieldStatus, [Tone, string]> = {
  OK: ['good', 'Found'],
  MISSING: ['warn', 'Element missing'],
  INVALID_SELECTOR: ['bad', 'Invalid selector'],
};
export function FieldBadge({ status }: { status: FieldStatus | null }) {
  if (!status) return <Badge tone="neutral">Waiting for check</Badge>;
  return <Badge tone={field[status][0]}>{field[status][1]}</Badge>;
}
