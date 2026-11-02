import { NextResponse, type NextRequest } from 'next/server';

function sameText(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

export function middleware(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('ADMIN_PASSWORD is not configured', { status: 503 });
    }
    return NextResponse.next();
  }
  const expected = `${process.env.ADMIN_USER ?? 'admin'}:${password}`;
  const header = request.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    try {
      if (sameText(atob(header.slice(6)), expected)) return NextResponse.next();
    } catch {
      // A malformed header falls through to the 401 below.
    }
  }
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Monitor", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|healthz).*)'],
};
