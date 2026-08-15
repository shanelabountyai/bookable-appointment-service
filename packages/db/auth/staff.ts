/**
 * The database side of staff auth (D-9). `packages/core/auth` decides; this
 * file reads and writes — so the policy has unit tests with no database, and
 * the storage has integration tests with no policy.
 */
import { DUMMY_HASH_PROMISE, verifyPassword } from '../../core/auth';
import type { PrismaClient } from '../generated/client/index.js';

export interface StaffIdentity {
  id: string;
  businessId: string;
  email: string;
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
    where: { email: normalized },
    select: { id: true, businessId: true, email: true, passwordHash: true },
  });

  if (!staff) {
    // Same work as the found-user branch. The result is discarded; only the
    // elapsed time matters.
    await verifyPassword(password, await DUMMY_HASH_PROMISE);
    return null;
  }

  const ok = await verifyPassword(password, staff.passwordHash);
  if (!ok) return null;

  return { id: staff.id, businessId: staff.businessId, email: staff.email };
}

/** Loads the staff user a session claims to be. Returns null if the row is
 *  gone — so deleting a StaffUser invalidates its live sessions on the very
 *  next request, without a revocation list. */
export async function findStaffById(prisma: PrismaClient, id: string): Promise<StaffIdentity | null> {
  return prisma.staffUser.findUnique({
    where: { id },
    select: { id: true, businessId: true, email: true },
  });
}
