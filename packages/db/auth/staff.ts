/**
 * The database side of staff auth (D-9). `packages/core/auth` decides; this
 * file reads and writes — so the policy has unit tests with no database, and
 * the storage has integration tests with no policy.
 */
import { DUMMY_HASH_PROMISE, hashPassword, isValidPin, verifyPassword } from '../../core/auth';
import { consumeRateLimit, resetRateLimit } from '../rate-limit';
import type { PrismaClient } from '../generated/client/index.js';

/** A-050 (D-36). Two, and the resistance to a third is the decision. */
export type StaffRole = 'owner' | 'staff';

/**
 * A-050 — the brute-force brake A-005 left as a `ponytail:` note.
 *
 * Thrown rather than folded into the generic "those do not match", and that is
 * deliberate on both counts. It cannot enumerate users: the counter is
 * consumed BEFORE the row is looked up, so an unknown email locks out exactly
 * as an existing one does. And a desk typing the right password into a locked
 * door needs to be told the door is locked — "that email and password do not
 * match" at 5pm on a Saturday is the message that produces a phone call.
 */
export class TooManyAttempts extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooManyAttempts';
  }
}

/**
 * The password door: generous, because the salon signs in once a shift and a
 * lockout here costs a Saturday. The scrypt cost (~100ms) is what makes this
 * enough — ten guesses per quarter-hour against a work factor that expensive
 * is not a keyspace anybody walks.
 */
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;

/**
 * The PIN door: tighter, because the keyspace IS walkable — four digits is ten
 * thousand, and this door is standing open in a room the public is in. Keyed
 * per staff row, so one stylist fat-fingering hers never locks out the desk.
 */
const PIN_LIMIT = 5;
const PIN_WINDOW_MS = 5 * 60_000;

export interface StaffIdentity {
  id: string;
  businessId: string;
  email: string;
  /** A-037: what the event log calls this person. */
  name: string;
  /** A-050 (D-36). `owner` sees the money and hands out credentials. */
  role: StaffRole;
}

/** One name on the desk switcher (A-037). No email, no id beyond what the
 *  switch needs — this list renders on a screen anyone standing at reception
 *  can see, so it carries names and nothing else. */
export interface StaffOption {
  id: string;
  name: string;
}

/**
 * Checks an email/password pair. Returns the staff identity, or null.
 *
 * NULL FOR BOTH FAILURE MODES, and the same amount of work for both. If a
 * missing email returned early, "no such user" would come back in
 * microseconds while a real user with a wrong password took the ~100ms of
 * deliberate scrypt work — a timing oracle that turns this into a
 * user-enumeration endpoint. When no user is found we verify against a dummy
 * hash instead, so both paths pay the same cost.
 *
 * A-050 — RATE LIMITED, which is the `ponytail:` note A-005 left here being
 * paid off with the machinery A-013 built for the manage-token route. Keyed on
 * the normalized email and consumed BEFORE the lookup, so a locked-out unknown
 * address behaves exactly like a locked-out real one and the limiter cannot
 * become the enumeration oracle the timing equalisation above exists to close.
 *
 * ponytail: keyed on the EMAIL only, not on the IP as the old note proposed.
 * A single-tenant salon has one address for the whole building, so an IP
 * limiter's first victim is the front desk on the busiest afternoon of the
 * year — and the email key already defends the thing worth defending, which is
 * an account. Upgrade path if this ever serves many salons from one origin: a
 * second, much looser `login:ip:{addr}` bucket beside this one.
 */
export async function authenticateStaff(
  prisma: PrismaClient,
  email: string,
  password: string,
  now: Date = new Date(),
): Promise<StaffIdentity | null> {
  const normalized = email.trim().toLowerCase();

  const within = await consumeRateLimit(prisma, {
    key: `login:${normalized}`,
    limit: LOGIN_LIMIT,
    windowMs: LOGIN_WINDOW_MS,
    now,
  });
  if (!within) {
    throw new TooManyAttempts('Too many sign-in attempts. Wait a few minutes and try again.');
  }

  const staff = await prisma.staffUser.findFirst({
    where: { email: normalized, active: true },
    select: { id: true, businessId: true, email: true, name: true, role: true, passwordHash: true },
  });

  // A PIN-only identity has no `passwordHash` and can never sign in — the
  // null-email filter above already excludes it, and this is the second lock
  // on the same door.
  if (!staff?.passwordHash) {
    // Same work as the found-user branch. The result is discarded; only the
    // elapsed time matters.
    await verifyPassword(password, await DUMMY_HASH_PROMISE);
    return null;
  }

  const ok = await verifyPassword(password, staff.passwordHash);
  if (!ok) return null;

  // The counter measures FAILURES, not sign-ins: a desk that legitimately
  // signs in eleven times on a Saturday must not lock itself out.
  await resetRateLimit(prisma, `login:${normalized}`);

  return {
    id: staff.id,
    businessId: staff.businessId,
    email: staff.email ?? '',
    name: staff.name,
    role: staff.role,
  };
}

/** Loads the staff user a session claims to be. Returns null if the row is
 *  gone OR deactivated — so off-boarding somebody invalidates their live
 *  sessions on the very next request, without a revocation list. A-037 made
 *  deactivation the off-boarding path rather than deletion, so this filters
 *  on `active` where it used to rely on the row disappearing. */
export async function findStaffById(prisma: PrismaClient, id: string): Promise<StaffIdentity | null> {
  return prisma.staffUser.findFirst({
    where: { id, active: true },
    select: { id: true, businessId: true, email: true, name: true, role: true },
  }).then((row) => (row ? { ...row, email: row.email ?? '' } : null));
}

/** Who the desk switcher offers: everybody in this business who is active and
 *  has a PIN set. No PIN means no fast path — the person still has their own
 *  credential, they just sign in with it. */
export async function listSwitchableStaff(prisma: PrismaClient, businessId: string): Promise<StaffOption[]> {
  return prisma.staffUser.findMany({
    where: { businessId, active: true, pinHash: { not: null } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
}

/**
 * Checks a PIN for one named person IN THE SAME BUSINESS as the open session.
 *
 * The business check is the whole security boundary of the switch (D-33): the
 * session was already authenticated, so this decides only WHOSE NAME goes on
 * the next mutation — and the one thing it must never allow is putting a name
 * from another salon onto this salon's audit log.
 *
 * Same dummy-hash equalisation as `authenticateStaff`, for the same reason:
 * a fast "no such person" against a slow "wrong PIN" tells anyone standing at
 * reception which of the names on the switcher are real.
 */
export async function verifyStaffPin(
  prisma: PrismaClient,
  args: { businessId: string; staffUserId: string; pin: string; now?: Date },
): Promise<StaffIdentity | null> {
  // A-050 — the limiter A-037 noted as missing and A-044 restated. This door
  // matters MORE than the password one: four digits is ten thousand
  // possibilities, the switcher lists the names to try them against, and it is
  // standing in a room the public walks into. Keyed per staff row so one
  // stylist mistyping hers cannot lock the desk out of everybody else's.
  const within = await consumeRateLimit(prisma, {
    key: `pin:${args.staffUserId}`,
    limit: PIN_LIMIT,
    windowMs: PIN_WINDOW_MS,
    now: args.now ?? new Date(),
  });
  if (!within) {
    throw new TooManyAttempts('Too many PIN attempts for that name. Wait a few minutes.');
  }

  const staff = await prisma.staffUser.findFirst({
    where: { id: args.staffUserId, businessId: args.businessId, active: true },
    select: { id: true, businessId: true, email: true, name: true, role: true, pinHash: true },
  });

  if (!staff?.pinHash) {
    await verifyPassword(args.pin, await DUMMY_HASH_PROMISE);
    return null;
  }

  const ok = await verifyPassword(args.pin, staff.pinHash);
  if (!ok) return null;

  await resetRateLimit(prisma, `pin:${args.staffUserId}`);

  return {
    id: staff.id,
    businessId: staff.businessId,
    email: staff.email ?? '',
    name: staff.name,
    role: staff.role,
  };
}

/**
 * The names behind a batch of staff ids, for a log or an audit trail to put a
 * name on an event (A-037, operator R-8/R-8-adjacent).
 *
 * Shared rather than reimplemented per screen — the appointment event log
 * (A-037) and the availability screen (A-052) both ask this exact question of
 * a batch of `actorRef`s, and a second copy of the same three lines is how one
 * of them drifts (deactivated staff visible on one screen and silently
 * dropped on the other, say).
 *
 * DEACTIVATED PEOPLE ARE INCLUDED deliberately — the whole reason off-boarding
 * deactivates rather than deletes is that "who did this" must still have an
 * answer after somebody leaves.
 */
export async function resolveStaffNames(prisma: PrismaClient, staffIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(staffIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.staffUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Everyone on the roster, including the deactivated — off-boarding hides
 *  somebody from the switcher, never from the owner's own list. */
export async function listStaff(prisma: PrismaClient, businessId: string): Promise<StaffRow[]> {
  const rows = await prisma.staffUser.findMany({
    where: { businessId },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, email: true, role: true, active: true, pinHash: true, passwordHash: true },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    // Neither hash ever leaves this function. Whether one EXISTS is what the
    // owner's screen needs, and it is the whole of what it needs.
    hasPin: row.pinHash !== null,
    hasPassword: row.passwordHash !== null,
  }));
}

export interface StaffRow {
  id: string;
  name: string;
  email: string | null;
  role: StaffRole;
  active: boolean;
  hasPin: boolean;
  /** A-050: whether this person can sign in at all, as opposed to being a
   *  name the log uses. Never the hash, and never the password. */
  hasPassword: boolean;
}

export class InvalidPin extends Error {
  constructor() {
    super('A desk PIN is 4 to 6 digits.');
    this.name = 'InvalidPin';
  }
}

/** A-050 — a credential that could not be used, or one that must not be
 *  taken away. Both are refusals a person can act on, so both carry the
 *  sentence rather than a code. */
export class InvalidCredential extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCredential';
  }
}

/** The shortest password this will store. Not a policy engine — a floor. */
const MIN_PASSWORD = 10;

/**
 * Adds or edits somebody on the roster (A-037).
 *
 * Identity, not roles (the backlog row is explicit): a name, optionally a PIN,
 * and whether they still work here. No permissions, no matrix, nothing that
 * decides what anybody is allowed to do — every staff member can do everything
 * a staff member could do before this item, and the only thing that changed is
 * that the log now knows which of them did it.
 *
 * An empty `pin` LEAVES AN EXISTING ONE ALONE rather than clearing it, so the
 * owner correcting a spelling does not silently drop somebody off the
 * switcher. Clearing is `clearPin`, which is a deliberate act.
 */
export async function saveStaffMember(
  prisma: PrismaClient,
  args: {
    businessId: string;
    id?: string;
    name: string;
    pin?: string;
    active?: boolean;
    clearPin?: boolean;
    /** A-050. Blank leaves an existing one alone, like the PIN. */
    email?: string;
    password?: string;
    role?: StaffRole;
  },
): Promise<{ id: string }> {
  const name = args.name.trim();
  if (!name) throw new Error('A staff member needs a name.');

  const pin = args.pin?.trim();
  if (pin && !isValidPin(pin)) throw new InvalidPin();

  const pinHash = args.clearPin ? null : pin ? await hashPassword(pin) : undefined;

  const email = args.email?.trim().toLowerCase() || undefined;
  const password = args.password?.trim() || undefined;
  if (password && password.length < MIN_PASSWORD) {
    throw new InvalidCredential(`A sign-in password needs at least ${MIN_PASSWORD} characters.`);
  }

  const existing = args.id
    ? await prisma.staffUser.findFirst({
        where: { id: args.id, businessId: args.businessId },
        select: { role: true, active: true, email: true },
      })
    : null;
  if (args.id && !existing) throw new Error('No such staff member.');

  // A password with nothing to sign in WITH is a credential that can never be
  // used — `authenticateStaff` finds by email, so a null email is a second
  // lock on that door and this is the sentence that explains it at the form.
  if (password && !email && !existing?.email) {
    throw new InvalidCredential('Give them an email address first — that is what they sign in with.');
  }

  // THE LOCKOUT GUARD. Demoting or deactivating the last active owner leaves a
  // salon with no screen that can grant the role back: the dashboard is gone,
  // and so is the only place credentials are handed out. Refused here, in the
  // one function both the role form and the roster toggle go through, rather
  // than in each caller — the "a status enum is never one edit" reflex applied
  // to a privilege.
  if (existing?.role === 'owner' && existing.active && (args.role === 'staff' || args.active === false)) {
    const otherOwners = await prisma.staffUser.count({
      where: { businessId: args.businessId, role: 'owner', active: true, id: { not: args.id! } },
    });
    if (otherOwners === 0) {
      throw new InvalidCredential(
        'This is the only owner. Make somebody else an owner first, or nobody can hand the role back.',
      );
    }
  }

  // The unique index is `[businessId, email]`, so giving two people the same
  // sign-in raises a constraint violation rather than quietly overwriting one
  // of them — which is correct, and reaches a server action as a 500 unless
  // somebody turns it into a sentence. Checked here, and the constraint is
  // still what actually enforces it: this is the message, not the guard.
  if (email) {
    const clash = await prisma.staffUser.findFirst({
      where: { businessId: args.businessId, email, ...(args.id ? { id: { not: args.id } } : {}) },
      select: { name: true },
    });
    if (clash) {
      throw new InvalidCredential(`${clash.name} already signs in with that email address.`);
    }
  }

  const credentials = {
    ...(email !== undefined ? { email } : {}),
    ...(password !== undefined ? { passwordHash: await hashPassword(password) } : {}),
    ...(args.role !== undefined ? { role: args.role } : {}),
  };

  if (args.id) {
    const updated = await prisma.staffUser.updateMany({
      // Scoped by business, so an id from elsewhere edits nothing rather than
      // somebody else's roster.
      where: { id: args.id, businessId: args.businessId },
      data: {
        name,
        ...(pinHash !== undefined ? { pinHash } : {}),
        ...(args.active !== undefined ? { active: args.active } : {}),
        ...credentials,
      },
    });
    if (updated.count === 0) throw new Error('No such staff member.');
    return { id: args.id };
  }

  const created = await prisma.staffUser.create({
    // Still no credential BY DEFAULT: a new person on the roster is an
    // IDENTITY, not an account (A-037), and the role falls to `staff` from the
    // schema. A-050 only adds the ability to give one deliberately.
    data: { businessId: args.businessId, name, pinHash: pinHash ?? null, ...credentials },
    select: { id: true },
  });
  return created;
}
