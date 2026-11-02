export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="animate-pulse space-y-4">
      <div className="h-7 w-48 rounded bg-line" />
      <div className="h-32 rounded-lg bg-line" />
      <div className="h-64 rounded-lg bg-line" />
    </div>
  );
}
