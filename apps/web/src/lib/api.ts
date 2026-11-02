// Server-side access to the REST API. The browser goes through /api/*, which adds the token.

export type RunStatus = 'SUCCESS' | 'PARTIAL' | 'ERROR';
export type StockStatus = 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
export type FieldStatus = 'OK' | 'MISSING' | 'INVALID_SELECTOR';
export type FieldRole = 'TEXT' | 'PRICE' | 'STOCK' | 'QUANTITY';

export interface MonitorField {
  id: string;
  name: string;
  selector: string;
  extractType: 'TEXT' | 'ATTRIBUTE';
  attribute: string | null;
  role: FieldRole;
  inStockTerms: string[];
  outOfStockTerms: string[];
  lastValue: string | null;
  lastStatus: FieldStatus | null;
  lastCheckedAt: string | null;
}

export interface Monitor {
  id: string;
  name: string;
  url: string;
  intervalMinutes: number;
  enabled: boolean;
  nextCheckAt: string;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastRunStatus: RunStatus | null;
  lastStockStatus: StockStatus;
  lastError: string | null;
  consecutiveFailures: number;
  fields: MonitorField[];
}

export interface FieldResult {
  id: string;
  fieldName: string;
  role: FieldRole;
  status: FieldStatus;
  previousValue: string | null;
  currentValue: string | null;
  changed: boolean;
}

export interface CheckRun {
  id: string;
  monitorId: string;
  startedAt: string;
  durationMs: number;
  status: RunStatus;
  changed: boolean;
  stockStatus: StockStatus;
  previousStockStatus: StockStatus;
  errorCode: string | null;
  errorMessage: string | null;
  results: FieldResult[];
  monitor: { id: string; name: string };
}

export interface HistoryPage {
  items: CheckRun[];
  total: number;
  page: number;
  limit: number;
}

export interface Dashboard {
  total: number;
  active: number;
  recentChanges: number;
  failedChecks: number;
  lastSuccess: { id: string; name: string; lastSuccessAt: string; lastStockStatus: StockStatus }[];
  changes: (Omit<CheckRun, 'results'> & { results: FieldResult[] })[];
  failing: { id: string; name: string; lastError: string | null; lastCheckAt: string | null; consecutiveFailures: number }[];
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${process.env.API_URL ?? 'http://localhost:4000'}${path}`, {
    cache: 'no-store',
    headers: process.env.API_TOKEN ? { authorization: `Bearer ${process.env.API_TOKEN}` } : {},
  });
  if (!response.ok) throw new ApiError(response.status, `API request failed with HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
