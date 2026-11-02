import dns from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertUrlAllowed, assertUrlShapeAllowed, isBlockedAddress, safeFetch } from '../../apps/api/src/checks/safe-fetch';

const policy = { timeoutMs: 2_000, maxBytes: 1024, allowHosts: [] as string[] };

afterEach(() => vi.restoreAllMocks());

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1',
    'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', 'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '104.26.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('assertUrlShapeAllowed', () => {
  it.each([
    'file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,x',
    'http://user:pw@example.com/', 'http://example.com:22/', 'http://localhost/', 'http://sub.localhost/', 'http://LOCALHOST/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertUrlShapeAllowed(url)).toThrowError();
  });

  it.each(['http://example.com/', 'https://example.com/a?b=c', 'https://example.com:8443/', 'http://8.8.8.8/'])('allows %s', (url) => {
    expect(() => assertUrlShapeAllowed(url)).not.toThrow();
  });

  it('exempts only the exact allow-listed host', () => {
    expect(() => assertUrlShapeAllowed('http://fixture:4100/', ['fixture'])).not.toThrow();
    expect(() => assertUrlShapeAllowed('http://fixture.evil.com:4100/', ['fixture'])).toThrow();
  });
});

describe('DNS validation', () => {
  const resolveTo = (address: string) =>
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address, family: 4 }] as never);

  it('refuses a public-looking hostname that resolves to a private address', async () => {
    resolveTo('10.0.0.7');
    await expect(assertUrlAllowed('https://internal.example.com/')).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  });

  it('refuses a hostname when any one of its addresses is private', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
    await expect(assertUrlAllowed('https://mixed.example.com/')).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  });

  it('accepts a hostname that resolves publicly', async () => {
    resolveTo('93.184.216.34');
    await expect(assertUrlAllowed('https://public.example.com/')).resolves.toBeUndefined();
  });

  it('does not treat an unresolvable hostname as a security failure', async () => {
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    await expect(assertUrlAllowed('https://does-not-exist.example.com/')).resolves.toBeUndefined();
  });
});

describe('DNS rebinding', () => {
  it('validates the address at connect time, when a rebinding host would switch to an internal one', async () => {
    // Passes every check made before connecting, then resolves to loopback when the connection is made.
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: unknown, callback: (e: null, a: unknown) => void) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as never);
    const error = await safeFetch('http://rebind.example.com/', policy).catch((e) => e);
    expect(lookup).toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'BLOCKED_URL' });
  });
});
