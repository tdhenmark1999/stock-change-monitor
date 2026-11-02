function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function loadConfig() {
  return {
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    apiToken: process.env.API_TOKEN ?? '',
    port: intEnv('PORT', 4000),
    fetch: {
      timeoutMs: intEnv('CHECK_TIMEOUT_MS', 20_000),
      maxBytes: intEnv('CHECK_MAX_BYTES', 5 * 1024 * 1024),
      // Exact hostnames exempt from the private-address block. Only for the local demo fixture.
      allowHosts: (process.env.SSRF_ALLOW_HOSTS ?? '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    },
    worker: {
      concurrency: intEnv('WORKER_CONCURRENCY', 5),
      attempts: Math.max(1, intEnv('CHECK_ATTEMPTS', 3)),
      backoffMs: intEnv('CHECK_BACKOFF_MS', 5_000),
      schedulerTickMs: intEnv('SCHEDULER_TICK_MS', 15_000),
      retentionDays: intEnv('HISTORY_RETENTION_DAYS', 90),
      maxRunsPerMonitor: intEnv('HISTORY_MAX_RUNS_PER_MONITOR', 5_000),
    },
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
