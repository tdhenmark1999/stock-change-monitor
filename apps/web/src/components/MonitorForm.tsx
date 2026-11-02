'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import type { FieldRole, Monitor } from '@/lib/api';
import { Badge } from './badges';

interface FieldDraft {
  key: string;
  id?: string;
  name: string;
  selector: string;
  extractType: 'TEXT' | 'ATTRIBUTE';
  attribute: string;
  role: FieldRole;
  inStockTerms: string;
  outOfStockTerms: string;
}

interface PreviewRow {
  name: string;
  status: 'OK' | 'MISSING' | 'INVALID_SELECTOR';
  value: string | null;
  stock: string | null;
  error: string | null;
}

let nextKey = 0;
const blankField = (overrides: Partial<FieldDraft> = {}): FieldDraft => ({
  key: `new-${nextKey++}`,
  name: '',
  selector: '',
  extractType: 'TEXT',
  attribute: '',
  role: 'TEXT',
  inStockTerms: '',
  outOfStockTerms: '',
  ...overrides,
});

const roleLabels: Record<FieldRole, string> = {
  TEXT: 'Text',
  PRICE: 'Price',
  STOCK: 'Stock status',
  QUANTITY: 'Stock quantity',
};

const splitTerms = (text: string) => text.split(',').map((term) => term.trim()).filter(Boolean);

function toPayload(field: FieldDraft) {
  return {
    ...(field.id && { id: field.id }),
    name: field.name,
    selector: field.selector,
    extractType: field.extractType,
    attribute: field.extractType === 'ATTRIBUTE' ? field.attribute : null,
    role: field.role,
    inStockTerms: splitTerms(field.inStockTerms),
    outOfStockTerms: splitTerms(field.outOfStockTerms),
  };
}

function FieldEditor({ field, index, onChange, onRemove, canRemove }: {
  field: FieldDraft;
  index: number;
  onChange: (patch: Partial<FieldDraft>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const uid = useId();
  const isStock = field.role === 'STOCK' || field.role === 'QUANTITY';
  return (
    <fieldset className="rounded-md border border-line p-3" data-testid="field-row">
      <legend className="px-1 text-xs font-medium text-muted">Field {index + 1}</legend>
      <div className="grid gap-3 sm:grid-cols-12">
        <div className="sm:col-span-3">
          <label className="label" htmlFor={`${uid}-name`}>Field name</label>
          <input id={`${uid}-name`} className="input" required maxLength={100} value={field.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Price" />
        </div>
        <div className="sm:col-span-4">
          <label className="label" htmlFor={`${uid}-selector`}>CSS selector</label>
          <input id={`${uid}-selector`} className="input font-mono" required maxLength={500} value={field.selector} onChange={(e) => onChange({ selector: e.target.value })} placeholder=".product-price" />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`${uid}-role`}>Type</label>
          <select id={`${uid}-role`} className="input" value={field.role} onChange={(e) => onChange({ role: e.target.value as FieldRole })}>
            {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`${uid}-extract`}>Read from</label>
          <select id={`${uid}-extract`} className="input" value={field.extractType} onChange={(e) => onChange({ extractType: e.target.value as FieldDraft['extractType'] })}>
            <option value="TEXT">Text</option>
            <option value="ATTRIBUTE">Attribute</option>
          </select>
        </div>
        <div className="flex items-end sm:col-span-1">
          <button type="button" className="btn btn-danger w-full" disabled={!canRemove} onClick={onRemove} aria-label={`Remove field ${field.name || index + 1}`}>✕</button>
        </div>
        {field.extractType === 'ATTRIBUTE' && (
          <div className="sm:col-span-4">
            <label className="label" htmlFor={`${uid}-attr`}>Attribute name</label>
            <input id={`${uid}-attr`} className="input font-mono" required value={field.attribute} onChange={(e) => onChange({ attribute: e.target.value })} placeholder="href" />
          </div>
        )}
        {isStock && (
          <>
            <div className="sm:col-span-4">
              <label className="label" htmlFor={`${uid}-in`}>Extra “in stock” words</label>
              <input id={`${uid}-in`} className="input" value={field.inStockTerms} onChange={(e) => onChange({ inStockTerms: e.target.value })} placeholder="ab Werk, 2–3 Tage" />
            </div>
            <div className="sm:col-span-4">
              <label className="label" htmlFor={`${uid}-out`}>Extra “out of stock” words</label>
              <input id={`${uid}-out`} className="input" value={field.outOfStockTerms} onChange={(e) => onChange({ outOfStockTerms: e.target.value })} placeholder="auf Anfrage" />
              <p className="hint">Comma separated. Common German, French, Italian, Spanish and English terms are already built in.</p>
            </div>
          </>
        )}
      </div>
    </fieldset>
  );
}

export function MonitorForm({ monitor }: { monitor?: Monitor }) {
  const router = useRouter();
  const [name, setName] = useState(monitor?.name ?? '');
  const [url, setUrl] = useState(monitor?.url ?? '');
  const [interval, setIntervalMinutes] = useState(monitor?.intervalMinutes ?? 60);
  const [enabled, setEnabled] = useState(monitor?.enabled ?? true);
  const [fields, setFields] = useState<FieldDraft[]>(
    monitor
      ? monitor.fields.map((f) => ({
          key: f.id,
          id: f.id,
          name: f.name,
          selector: f.selector,
          extractType: f.extractType,
          attribute: f.attribute ?? '',
          role: f.role,
          inStockTerms: f.inStockTerms.join(', '),
          outOfStockTerms: f.outOfStockTerms.join(', '),
        }))
      : [blankField({ name: 'Price', role: 'PRICE' }), blankField({ name: 'Availability', role: 'STOCK' })],
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);

  const patchField = (key: string, patch: Partial<FieldDraft>) => {
    setFields((current) => current.map((field) => (field.key === key ? { ...field, ...patch } : field)));
    setPreview(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = { name, url, intervalMinutes: interval, enabled, fields: fields.map(toPayload) };
      const response = await fetch(monitor ? `/api/monitors/${monitor.id}` : '/api/monitors', {
        method: monitor ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.message ?? 'The monitor could not be saved.');
      // A full page load: the client router occasionally never finished its navigation after a save,
      // which left a saved monitor looking stuck on "Saving…".
      window.location.assign(`/monitors/${data.id}`);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setTesting(true);
    setError(null);
    setPreview(null);
    try {
      const response = await fetch('/api/monitors/preview', { method: 'POST', body: JSON.stringify({ url, fields: fields.map(toPayload) }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.message ?? 'The page could not be tested.');
      setPreview(data.fields);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <section className="card grid gap-4 p-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="monitor-name">Monitor name</label>
          <input id="monitor-name" className="input" required maxLength={150} value={name} onChange={(e) => setName(e.target.value)} placeholder="Laugenpumpe Bosch 00144978" />
        </div>
        <div>
          <label className="label" htmlFor="monitor-url">Page URL</label>
          <input id="monitor-url" className="input" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://shop.example.ch/product/123" />
        </div>
        <div>
          <label className="label" htmlFor="monitor-interval">Check every (minutes)</label>
          <input id="monitor-interval" className="input" type="number" min={1} max={10080} required value={interval} onChange={(e) => setIntervalMinutes(Number(e.target.value))} />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Monitor is active
          </label>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <div>
          <h2 className="font-semibold">Fields to monitor</h2>
          <p className="text-sm text-muted">Each field reads one value from the page. All of them are stored in the database.</p>
        </div>
        {fields.map((field, index) => (
          <FieldEditor
            key={field.key}
            field={field}
            index={index}
            canRemove={fields.length > 1}
            onChange={(patch) => patchField(field.key, patch)}
            onRemove={() => setFields((current) => current.filter((f) => f.key !== field.key))}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => setFields((current) => [...current, blankField()])}>Add field</button>
          <button type="button" className="btn" disabled={testing || !url} onClick={runPreview}>{testing ? 'Testing…' : 'Test fields on the page'}</button>
        </div>
        {preview && (
          <ul aria-label="Test results" className="divide-y divide-line rounded-md border border-line text-sm">
            {preview.map((row) => (
              <li key={row.name} className="flex flex-wrap items-center gap-2 p-2">
                <span className="font-medium">{row.name}</span>
                <Badge tone={row.status === 'OK' ? 'good' : row.status === 'MISSING' ? 'warn' : 'bad'}>
                  {row.status === 'OK' ? 'Found' : row.status === 'MISSING' ? 'Not found' : 'Invalid selector'}
                </Badge>
                {row.stock && <span className="text-xs text-muted">{row.stock}</span>}
                <span className="break-all text-muted">{row.error ?? row.value}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : monitor ? 'Save changes' : 'Create monitor'}</button>
        <button type="button" className="btn" onClick={() => router.back()}>Cancel</button>
      </div>
    </form>
  );
}
