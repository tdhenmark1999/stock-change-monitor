import dns from 'node:dns';
import type { LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';

export type FetchErrorCode =
  | 'BLOCKED_URL'
  | 'DNS_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'RATE_LIMITED'
  | 'BOT_PROTECTION'
  | 'TOO_MANY_REDIRECTS'
  | 'RESPONSE_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT';

export class FetchFailure extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface FetchPolicy {
  timeoutMs: number;
  maxBytes: number;
  allowHosts: string[];
}

export interface FetchedPage {
  finalUrl: string;
  status: number;
  html: string;
}

const MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const USER_AGENT = 'StockChangeMonitor/1.0 (+change monitoring)';

/** Only ordinary public unicast is reachable: loopback, private, link-local, metadata etc. are not. */
export function isBlockedAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() !== 'unicast';
}

const isAllowedHost = (hostname: string, allowHosts: string[]) => allowHosts.includes(hostname.toLowerCase());

/** Rules that need no network: protocol, credentials, port and IP literals. */
export function assertUrlShapeAllowed(raw: string, allowHosts: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchFailure('BLOCKED_URL', 'Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchFailure('BLOCKED_URL', `Protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new FetchFailure('BLOCKED_URL', 'URLs with credentials are not allowed');
  }
  if (isAllowedHost(url.hostname, allowHosts)) return url;
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new FetchFailure('BLOCKED_URL', `Port ${url.port} is not allowed`);
  }
  // The WHATWG parser already turned decimal, hex and octal IPv4 forms into dotted notation.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && isBlockedAddress(host)) {
    throw new FetchFailure('BLOCKED_URL', 'This address is not allowed');
  }
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new FetchFailure('BLOCKED_URL', 'This address is not allowed');
  }
  return url;
}

/** Save-time check. Fetch time still validates again, because DNS can change after saving. */
export async function assertUrlAllowed(raw: string, allowHosts: string[] = []): Promise<void> {
  const url = assertUrlShapeAllowed(raw, allowHosts);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) || isAllowedHost(host, allowHosts)) return;
  let addresses: LookupAddress[];
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch {
    // An unresolvable host is not an SSRF risk. The check run reports it as a DNS error.
    return;
  }
  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new FetchFailure('BLOCKED_URL', 'This hostname resolves to a non-public address');
  }
}

/**
 * Validates at connect time, so the address that passes the check is the address connected to.
 * That is what stops DNS rebinding, a separate check before connecting would not.
 */
function guardedLookup(allowHosts: string[]) {
  return (
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      if (!isAllowedHost(hostname, allowHosts) && addresses.some((entry) => isBlockedAddress(entry.address))) {
        const blocked: NodeJS.ErrnoException = new Error('Resolved to a non-public address');
        blocked.code = 'EBLOCKEDADDRESS';
        return callback(blocked, '');
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function translateNetworkError(error: unknown): FetchFailure {
  if (error instanceof FetchFailure) return error;
  const cause = (error as { cause?: { code?: string } }).cause;
  const code = (error as { code?: string }).code ?? cause?.code ?? '';
  const name = (error as { name?: string }).name ?? '';
  if (code === 'EBLOCKEDADDRESS') return new FetchFailure('BLOCKED_URL', 'Hostname resolved to a non-public address');
  if (name === 'TimeoutError' || name === 'AbortError' || code.startsWith('UND_ERR_') && code.includes('TIMEOUT')) {
    return new FetchFailure('TIMEOUT', 'The website did not respond in time', true);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new FetchFailure('DNS_ERROR', 'Hostname could not be resolved', true);
  return new FetchFailure('NETWORK_ERROR', `Connection failed${code ? ` (${code})` : ''}`, true);
}

function parseRetryAfter(value: unknown): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86_400) * 1000 : undefined;
}

function decoderFor(contentType: string): TextDecoder {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

export async function safeFetch(rawUrl: string, policy: FetchPolicy): Promise<FetchedPage> {
  const dispatcher = new Agent({
    connect: { lookup: guardedLookup(policy.allowHosts) as never, timeout: policy.timeoutMs },
    headersTimeout: policy.timeoutMs,
    bodyTimeout: policy.timeoutMs,
  });
  const signal = AbortSignal.timeout(policy.timeoutMs);

  try {
    let current = assertUrlShapeAllowed(rawUrl, policy.allowHosts);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await request(current, {
        method: 'GET',
        dispatcher,
        signal,
        // No Accept-Encoding: the response stays uncompressed, so the size limit is the real size.
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' },
      });
      const { statusCode, headers, body } = response;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        await body.dump();
        // Every hop is validated again, a public URL may redirect to an internal one.
        current = assertUrlShapeAllowed(new URL(String(headers.location), current).toString(), policy.allowHosts);
        continue;
      }
      if (statusCode === 429) {
        await body.dump();
        throw new FetchFailure('RATE_LIMITED', 'The website asked us to slow down (HTTP 429)', false, parseRetryAfter(headers['retry-after']));
      }
      if (headers['cf-mitigated'] || ((statusCode === 403 || statusCode === 503) && headers['cf-ray'])) {
        await body.dump();
        throw new FetchFailure('BOT_PROTECTION', `Blocked by the website's bot protection (HTTP ${statusCode}). This is not bypassed.`);
      }
      if (statusCode >= 400) {
        await body.dump();
        throw new FetchFailure('HTTP_ERROR', `The website returned HTTP ${statusCode}`, statusCode >= 500);
      }
      const contentType = String(headers['content-type'] ?? '');
      if (contentType && !/html|xml|text\//i.test(contentType)) {
        await body.dump();
        throw new FetchFailure('UNSUPPORTED_CONTENT', `Unsupported content type: ${contentType.slice(0, 80)}`);
      }

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > policy.maxBytes) {
          await body.destroy();
          throw new FetchFailure('RESPONSE_TOO_LARGE', `Response is larger than ${policy.maxBytes} bytes`);
        }
        chunks.push(chunk as Buffer);
      }
      return { finalUrl: current.toString(), status: statusCode, html: decoderFor(contentType).decode(Buffer.concat(chunks)) };
    }
    throw new FetchFailure('TOO_MANY_REDIRECTS', `More than ${MAX_REDIRECTS} redirects`);
  } catch (error) {
    throw translateNetworkError(error);
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}
