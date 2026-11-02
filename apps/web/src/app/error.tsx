'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="card p-8 text-center">
      <h1 className="text-lg font-semibold">This page could not be loaded</h1>
      <p className="mt-1 text-sm text-muted">The monitoring API did not answer. Your saved monitors are not affected.</p>
      <button type="button" className="btn btn-primary mt-4" onClick={reset}>Try again</button>
    </div>
  );
}
