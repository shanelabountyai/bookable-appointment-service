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
  type SessionPayload,
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

/** The verified session payload, or null. The one place the cookie is read. */
async function readSession(now: number): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token, sessionSecret(), now);
}

/**
 * WHO IS AT THE DESK — the person every mutation is stamped with (A-037).
 *
 * Not necessarily the account that signed in. The salon terminal authenticates
 * once in the morning and four people use it, so `act` names whichever of them
 * tapped their PIN last; absent, it is the account holder.
 *
 * Never throws for a bad cookie — a forged, expired or malformed value is
 * simply "not logged in".
 *
 * Re-reads the StaffUser row on every call rather than trusting the cookie's
 * contents, so deactivating somebody invalidates their live sessions on the
 * next request with no revocation list to maintain. **An acting person who has
 * been deactivated falls back to the account holder rather than logging the
 * terminal out**: off-boarding the temp must not throw the front desk out of
 * the system mid-Saturday.
 */
export async function currentStaff(now = Date.now()): Promise<StaffIdentity | null> {
  const session = await readSession(now);
  if (!session) return null;

  const acting = session.act ? await findStaffById(prisma, session.act) : null;
  return acting ?? findStaffById(prisma, session.sub);
}

/**
 * Puts a different name on the next mutation (D-33).
 *
 * The caller is responsible for having verified the PIN; this only re-signs
 * the cookie. `sub` and `exp` are carried through unchanged — switching who is
 * at the desk is not a re-authentication and must not extend the shift's
 * session by eight more hours.
 */
export async function actAsStaff(staffUserId: string | null, now = Date.now()): Promise<void> {
  const session = await readSession(now);
  if (!session) return;

  const jar = await cookies();
  const token = signSession(
    // Dropping the field entirely for "back to the account holder", rather
    // than storing `sub` twice — one state, so nothing downstream has to know
    // the two spellings are the same thing.
    staffUserId && staffUserId !== session.sub
      ? { sub: session.sub, exp: session.exp, act: staffUserId }
      : { sub: session.sub, exp: session.exp },
    sessionSecret(),
  );
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: toDate(instant(session.exp)),
  });
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
