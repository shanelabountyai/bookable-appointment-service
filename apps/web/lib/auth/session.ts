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
  ACT_TTL_MS,
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
 * The session's TWO identities, resolved together (A-037, A-044).
 *
 * `staff` is who the next mutation is stamped with. `isAccountHolder` says
 * whether that is the account whose email and password opened the session —
 * which is the whole of A-044's guard: setting a desk PIN decides who can put
 * a name on the log, so it is the one thing a borrowed identity must not do.
 *
 * Re-reads the StaffUser row on every call rather than trusting the cookie's
 * contents, so deactivating somebody invalidates their live sessions on the
 * next request with no revocation list to maintain.
 *
 * THREE ways to stop being the acting person, and all three land in the same
 * place — the account holder, never a logged-out terminal. Off-boarding the
 * Saturday temp must not throw the front desk out of the system mid-shift:
 *   - somebody else taps their PIN in;
 *   - the acting person is deactivated (`findStaffById` filters on `active`);
 *   - `actExp` passes.
 */
async function readDesk(now: number): Promise<{ staff: StaffIdentity; isAccountHolder: boolean } | null> {
  const session = await readSession(now);
  if (!session) return null;

  // `(session.actExp ?? 0) > now` — an `act` with no timeout at all is a
  // cookie signed before A-044 and reads as lapsed, not as permanent.
  const acting =
    session.act && (session.actExp ?? 0) > now ? await findStaffById(prisma, session.act) : null;
  if (acting) return { staff: acting, isAccountHolder: acting.id === session.sub };

  const holder = await findStaffById(prisma, session.sub);
  return holder ? { staff: holder, isAccountHolder: true } : null;
}

/**
 * WHO IS AT THE DESK — the person every mutation is stamped with (A-037).
 *
 * Not necessarily the account that signed in. The salon terminal authenticates
 * once in the morning and four people use it, so `act` names whichever of them
 * tapped their PIN last; absent or lapsed, it is the account holder.
 *
 * Never throws for a bad cookie — a forged, expired or malformed value is
 * simply "not logged in".
 */
export async function currentStaff(now = Date.now()): Promise<StaffIdentity | null> {
  return (await readDesk(now))?.staff ?? null;
}

/**
 * The guard for anything only the ACCOUNT HOLDER may do (A-044).
 *
 * Exactly one thing today: setting or clearing a desk PIN. That is not a
 * permissions matrix and must not grow into one — D-9 and D-33 stand, every
 * staff member can still do everything a staff member could do before. The
 * distinction here is narrower than a role: a PIN is the credential the audit
 * trail rests on, so handing it out cannot itself be done with a borrowed
 * identity, or the trail forges in thirty seconds.
 *
 * Redirects when there is no session at all. When there IS one and it is
 * acting as somebody else, this returns `isAccountHolder: false` rather than
 * redirecting: the caller is mid-form and needs to say why, not be thrown at
 * the login page for a thing they are legitimately signed in for.
 */
export async function requireDesk(
  now = Date.now(),
): Promise<{ staff: StaffIdentity; isAccountHolder: boolean }> {
  const desk = await readDesk(now);
  if (!desk) redirect('/staff/login');
  return desk;
}

/**
 * A-050 (D-36) — the guard on anything only an OWNER may see or do.
 *
 * Asked of the ACTING person, not of the account that opened the session. The
 * salon terminal signs in once in the morning as the owner and four people use
 * it, so if the role came from `sub` then any stylist who tapped her PIN in
 * would still be holding the owner's dashboard — revenue, utilization, and
 * every colleague's no-show count. Taking the desk therefore hands the money
 * back, and the owner takes it again with her own PIN or her own sign-in.
 *
 * Redirects to `/staff`, never to the login page: they ARE signed in, and
 * throwing a legitimately-authenticated person at a sign-in form is how a
 * front desk concludes the system is broken. The link is hidden from
 * non-owners too, so reaching this at all means a typed URL or a stale tab.
 */
export async function requireOwner(now = Date.now()): Promise<StaffIdentity> {
  const staff = await requireStaff(now);
  if (staff.role !== 'owner') redirect('/staff');
  return staff;
}

/**
 * Puts a different name on the next mutation (D-33).
 *
 * The caller is responsible for having verified the PIN; this only re-signs
 * the cookie. `sub` and `exp` are carried through unchanged — switching who is
 * at the desk is not a re-authentication and must not extend the shift's
 * session by eight more hours.
 *
 * A-044: the switch now carries its own, much shorter expiry. Nothing used to
 * hand the desk BACK, so whoever tapped last stayed all day — including after
 * they had gone home, which is when their name on an event stops being true.
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
      ? { sub: session.sub, exp: session.exp, act: staffUserId, actExp: now + ACT_TTL_MS }
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
