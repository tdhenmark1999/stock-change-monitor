import { MonitorForm } from '@/components/MonitorForm';

export default function NewMonitorPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Create monitor</h1>
      <MonitorForm />
    </div>
  );
}
