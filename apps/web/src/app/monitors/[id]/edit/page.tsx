import { notFound } from 'next/navigation';
import { MonitorForm } from '@/components/MonitorForm';
import { ApiError, apiGet, type Monitor } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function EditMonitorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const monitor = await apiGet<Monitor>(`/monitors/${encodeURIComponent(id)}`).catch((error) => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Edit monitor</h1>
      <MonitorForm monitor={monitor} />
    </div>
  );
}
