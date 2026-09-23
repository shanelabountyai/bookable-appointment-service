// The demo gate (D-65): one shared password over the WHOLE site when
// DEMO_ACCESS_PASSWORD is set, so the hosted demo cannot be filled with
// strangers' bookings. Unset locally and in CI, so it is invisible to the
// suite. Staff sign-in stays where it was — in the pages, not here.
import { NextResponse, type NextRequest } from 'next/server';
import { demoChallenge } from '@/lib/demo-gate';

export function middleware(request: NextRequest): NextResponse {
  const challenge = demoChallenge(
    request.nextUrl.pathname,
    request.headers.get('authorization'),
    process.env.DEMO_ACCESS_PASSWORD,
  );
  if (challenge) {
    return new NextResponse('Demo access required.', {
      status: challenge.status,
      headers: challenge.headers,
    });
  }
  return NextResponse.next();
}

// Static assets and the image optimiser are excluded: they carry no salon
// data, and challenging them makes a gated page render without its stylesheet.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
