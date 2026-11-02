'use client';

import Link from 'next/link';
import { useState } from 'react';

async function send(path: string, method: string, body?: unknown) {
  const response = await fetch(`/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.message ?? `Request failed with HTTP ${response.status}`);
  }
}

async function readLastCheck(id: string): Promise<string | null | undefined> {
  const response = await fetch(`/api/monitors/${id}`, { cache: 'no-store' });
  return response.ok ? (await response.json()).lastCheckAt : undefined;
}

export function MonitorActions({ id, enabled }: { id: string; enabled: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stays busy on success, because the full page load that follows replaces this component.
  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const checkNow = () =>
    act('check', async () => {
      // Read from the API, because the value on this page may already be out of date.
      const before = await readLastCheck(id);
      await send(`/monitors/${id}/check`, 'POST');
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const current = await readLastCheck(id);
        if (current !== undefined && current !== before) break;
      }
      window.location.reload();
    });

  const toggle = () =>
    act('toggle', async () => {
      await send(`/monitors/${id}`, 'PATCH', { enabled: !enabled });
      window.location.reload();
    });

  const remove = () => {
    if (!window.confirm('Delete this monitor with its fields and history? This cannot be undone.')) return;
    void act('delete', async () => {
      await send(`/monitors/${id}`, 'DELETE');
      window.location.assign('/monitors');
    });
  };

  const disabled = busy !== null;

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={disabled} onClick={checkNow}>
          {busy === 'check' ? 'Checking…' : 'Check now'}
        </button>
        <Link href={`/monitors/${id}/edit`} className="btn">Edit</Link>
        <button type="button" className="btn" disabled={disabled} onClick={toggle}>{enabled ? 'Pause' : 'Resume'}</button>
        <button type="button" className="btn btn-danger" disabled={disabled} onClick={remove}>Delete</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
