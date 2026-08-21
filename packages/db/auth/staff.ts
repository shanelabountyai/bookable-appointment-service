/**
 * The database side of staff auth (D-9). `packages/core/auth` decides; this
 * file reads and writes — so the policy has unit tests with no database, and
 * the storage has integration tests with no policy.
 */
import { DUMMY_HASH_PROMISE, hashPassword, isValidPin, verifyPassword } from '../../core/auth';
import type { PrismaClient } from '../generated/client/index.js';

export interface StaffIdentity {
  id: string;
  businessId: string;
  email: string;
  /** A-037: what the event log calls this person. */
  name: string;
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
 * ponytail: no rate limiting or lockout. The scrypt cost is the only
 * brute-force control today, which is reasonable for one shared credential on
 * a single-tenant v1 but is NOT a substitute for a limiter. Upgrade path when
 * this is public: a `RateLimitCounter` table keyed on `login:{email}` and
 * `login:{ip}`, consumed inside a transaction with an advisory lock (the
 * sibling rental build's shape) — A-013 already needs exactly that machinery
 * for the manage-token route, so build it once there and call it here too.
 */
export async function authenticateStaff(
  prisma: PrismaClient,
  email: string,
  password: string,
): Promise<StaffIdentity | null> {
  const normalized = email.trim().toLowerCase();
  const staff = await prisma.staffUser.findFirst({
    where: { email: normalized, active: true },
    select: { id: true, businessId: true, email: true, name: true, passwordHash: true },
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

  return { id: staff.id, businessId: staff.businessId, email: staff.email ?? '', name: staff.name };
}

/** Loads the staff user a session claims to be. Returns null if the row is
 *  gone OR deactivated — so off-boarding somebody invalidates their live
 *  sessions on the very next request, without a revocation list. A-037 made
 *  deactivation the off-boarding path rather than deletion, so this filters
 *  on `active` where it used to rely on the row disappearing. */
export async function findStaffById(prisma: PrismaClient, id: string): Promise<StaffIdentity | null> {
  return prisma.staffUser.findFirst({
    where: { id, active: true },
    select: { id: true, businessId: true, email: true, name: true },
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
  args: { businessId: string; staffUserId: string; pin: string },
): Promise<StaffIdentity | null> {
  const staff = await prisma.staffUser.findFirst({
    where: { id: args.staffUserId, businessId: args.businessId, active: true },
    select: { id: true, businessId: true, email: true, name: true, pinHash: true },
  });

  if (!staff?.pinHash) {
    await verifyPassword(args.pin, await DUMMY_HASH_PROMISE);
    return null;
  }

  const ok = await verifyPassword(args.pin, staff.pinHash);
  if (!ok) return null;

  return { id: staff.id, businessId: staff.businessId, email: staff.email ?? '', name: staff.name };
}

/** Everyone on the roster, including the deactivated — off-boarding hides
 *  somebody from the switcher, never from the owner's own list. */
export async function listStaff(prisma: PrismaClient, businessId: string): Promise<StaffRow[]> {
  const rows = await prisma.staffUser.findMany({
    where: { businessId },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, email: true, active: true, pinHash: true },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    active: row.active,
    // The hash never leaves this function. Whether one EXISTS is what the
    // owner's screen needs, and it is the whole of what it needs.
    hasPin: row.pinHash !== null,
  }));
}

export interface StaffRow {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  hasPin: boolean;
}

export class InvalidPin extends Error {
  constructor() {
    super('A desk PIN is 4 to 6 digits.');
    this.name = 'InvalidPin';
  }
}

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
  args: { businessId: string; id?: string; name: string; pin?: string; active?: boolean; clearPin?: boolean },
): Promise<{ id: string }> {
  const name = args.name.trim();
  if (!name) throw new Error('A staff member needs a name.');

  const pin = args.pin?.trim();
  if (pin && !isValidPin(pin)) throw new InvalidPin();

  const pinHash = args.clearPin ? null : pin ? await hashPassword(pin) : undefined;

  if (args.id) {
    const updated = await prisma.staffUser.updateMany({
      // Scoped by business, so an id from elsewhere edits nothing rather than
      // somebody else's roster.
      where: { id: args.id, businessId: args.businessId },
      data: { name, ...(pinHash !== undefined ? { pinHash } : {}), ...(args.active !== undefined ? { active: args.active } : {}) },
    });
    if (updated.count === 0) throw new Error('No such staff member.');
    return { id: args.id };
  }

  const created = await prisma.staffUser.create({
    // No email and no password: a new person on the roster is an IDENTITY, not
    // an account. Giving her a credential she never asked for is a credential
    // somebody has to rotate.
    data: { businessId: args.businessId, name, pinHash: pinHash ?? null },
    select: { id: true },
  });
  return created;
}
