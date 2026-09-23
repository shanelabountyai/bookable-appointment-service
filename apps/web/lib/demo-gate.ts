// One shared password over the whole site, HTTP Basic (D-65).
//
// This is NOT access control. It exists so a public demo URL cannot be found
// and filled with strangers' bookings. The seeded book is what DEMO.md walks,
// name by name, so every stranger's booking degrades the thing the deployment
// exists to show. It also keeps the demo staff password, which DEMO.md
// publishes, from being a public key to the back office.
//
// Unset = no gate. That is what local development and CI run with, so the
// e2e suite never sees it.
//
// ponytail: one password for everyone, no per-viewer identity. Upgrade is
// real accounts, and only if this ever holds data that matters.

// This carries its own authentication and must stay reachable without the
// shared password: the reminder job requires CRON_SECRET as a bearer token,
// which is what Vercel Cron sends. Gating it behind Basic would stop the cron.
const EXEMPT = ['/api/jobs/reminders'];

/** Length-checked constant-time compare. Edge-safe: no Node APIs. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Returns the challenge to send, or null to let the request through.
 *
 * `password` is passed in rather than read here so the decision is pure and
 * testable — nothing in this file reads process.env.
 */
export function demoChallenge(
  pathname: string,
  authorization: string | null,
  password: string | undefined,
): { status: number; headers: Record<string, string> } | null {
  if (!password) return null;
  if (EXEMPT.includes(pathname)) return null;

  const [scheme, encoded] = (authorization ?? '').split(' ');
  if (scheme?.toLowerCase() === 'basic' && encoded) {
    let decoded = '';
    try {
      decoded = atob(encoded);
    } catch {
      decoded = '';
    }
    // "user:pass" — the username is ignored, the password is the whole check.
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    if (decoded.includes(':') && safeEqual(supplied, password)) return null;
  }

  return {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Bookable demo", charset="UTF-8"',
      // A demo page behind a password should never be indexed or cached.
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  };
}
