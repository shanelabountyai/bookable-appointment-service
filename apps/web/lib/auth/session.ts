import 'server-only';

/**
 * The session cookie, and the guard every staff surface goes through (D-9).
 *
 * This is the ONE place a cookie becomes an Actor, so there is one place to
 * audit rather than one per route.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  type Actor,
  SESSION_TTL_MS,
  signSession,
  staffActor,
  systemActor,
  verifySession,
} from '@bookable/core/auth';
import { instant, toDate } from '@bookable/core/time';
import { findStaffById, type StaffIdentity } from '@bookable/db/auth';
import { prisma } from '@bookable/db';

export const SESSION_COOKIE = 'bookable_staff_session';

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Loud, not a fallback. A default secret means every deployment that
    // forgot to set one shares the same forgeable signing key.
    throw new Error('SESSION_SECRET is not set — refusing to handle sessions.');
  }
  return secret;
}

/** Called after a verified login. */
export async function startStaffSession(staffUserId: string, now = Date.now()): Promise<void> {
  const exp = now + SESSION_TTL_MS;
  const token = signSession({ sub: staffUserId, exp }, sessionSecret());
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, // JavaScript can never read it — an XSS cannot exfiltrate the session
    sameSite: 'lax', // a cross-site POST cannot carry it; ordinary top-level navigation still can
    secure: process.env.NODE_ENV === 'production', // http://localhost must still work in dev
    path: '/',
    // toDate() is the repo's one sanctioned Instant->Date bridge (A-003);
    // `new Date(...)` is banned everywhere else by lint. This is the browser's
    // hint only — the signed `exp` inside the token is the actual control.
    expires: toDate(instant(exp)),
  });
}

export async function endStaffSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/**
 * The current staff user, or null. Never throws for a bad cookie — a forged,
 * expired or malformed value is simply "not logged in".
 *
 * Re-reads the StaffUser row on every call rather than trusting the cookie's
 * contents, so deleting a staff user invalidates their live sessions on the
 * next request with no revocation list to maintain.
 */
export async function currentStaff(now = Date.now()): Promise<StaffIdentity | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = verifySession(token, sessionSecret(), now);
  if (!session) return null;

  return findStaffById(prisma, session.sub);
}

/**
 * The guard. Redirects to the login page when unauthenticated.
 *
 * `redirect()` throws, so a caller cannot accidentally continue past it —
 * which is the property that makes "staff routes refuse unauthenticated
 * requests" hold by construction rather than by every route remembering to
 * check a boolean.
 */
export async function requireStaff(now = Date.now()): Promise<StaffIdentity> {
  const staff = await currentStaff(now);
  if (!staff) redirect('/staff/login');
  return staff;
}

/**
 * The Actor to stamp on a mutation (D-9).
 *
 * Falls back to `system` only when there is no session — a background job or
 * a cron. A route that mutates on behalf of a person must call
 * `requireStaff()` first, so it cannot silently write `system` for something
 * a human actually did.
 */
export async function currentActor(now = Date.now()): Promise<Actor> {
  const staff = await currentStaff(now);
  return staff ? staffActor(staff.id) : systemActor;
}
