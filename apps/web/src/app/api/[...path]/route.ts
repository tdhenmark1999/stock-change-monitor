import { NextResponse, type NextRequest } from 'next/server';

const ALLOWED_ROOTS = new Set(['monitors', 'history', 'dashboard']);

// Sandboxed pages send the origin "null", which is not a URL.
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

async function forward(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!ALLOWED_ROOTS.has(path[0])) return NextResponse.json({ message: 'Not found' }, { status: 404 });

  // Browsers send Basic credentials on cross-site requests, so writes must come from this origin.
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    if (origin && originHost(origin) !== host) {
      return NextResponse.json({ message: 'Cross-origin request refused' }, { status: 403 });
    }
  }

  const target = `${process.env.API_URL ?? 'http://localhost:4000'}/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.API_TOKEN) headers.authorization = `Bearer ${process.env.API_TOKEN}`;

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text(),
      cache: 'no-store',
    });
    if (response.status === 204) return new NextResponse(null, { status: 204 });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return NextResponse.json({ message: 'The API is not reachable' }, { status: 502 });
  }
}

export { forward as GET, forward as POST, forward as PATCH, forward as DELETE };
