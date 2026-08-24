/**
 * A-013 — issuing, verifying and revoking the manage link (TOKEN-01..03, D-5).
 *
 * `packages/core/auth/manage-token.ts` decides what a token IS and when it
 * dies; this file is the storage side, the same split as staff auth.
 *
 * THREE PROPERTIES, and each one is a rejected alternative:
 *
 *  1. MULTI-USE until expiry. Single-use was considered and rejected (D-5):
 *     confirm-then-later-cancel and reschedule-twice are the ORDINARY customer
 *     workflow, so a burn-on-use token fails on step two of every appointment
 *     and the salon answers the phone instead. The control set is scope,
 *     expiry, revocation and rate limiting — not one-shot use.
 *  2. SCOPED TO ONE APPOINTMENT. The grant names a row, never a client and
 *     never a business. A customer with two appointments holds two links, and
 *     neither one reaches the other — which is what makes a forwarded link a
 *     bounded disclosure rather than an account takeover.
 *  3. REVOKED ON REISSUE. Issuing supersedes; it never accumulates. Two live
 *     links for one appointment means the older text message still works after
 *     the newer one was sent to a corrected number.
 */
import { hashManageToken, manageTokenExpiry, mintManageToken } from '../../core/auth';
import { fromDate, toDate } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface IssueManageTokenInput {
  businessId: string;
  appointmentId: string;
  /** The appointment's scheduled end — the expiry is derived from it. */
  endAt: Date;
  now: Date;
  /**
   * A-054 (D-38). Leave the previous token WORKING alongside the new one.
   *
   * Only the reminder passes this, and only because its message may never
   * arrive: a revocation is a promise that a replacement is in the client's
   * hands, and at enqueue time nobody can make that promise. Two live links
   * to one appointment are harmless — same scope, same expiry, same page —
   * where a revoked link and an undelivered replacement is a client who
   * cannot reach her own booking.
   */
  keepPrevious?: boolean;
}

export interface IssuedManageToken {
  /** The raw value for the link. Returned once and never readable again. */
  token: string;
  expiresAt: Date;
}

/**
 * Mints a token for this appointment and, by default, revokes any earlier one.
 *
 * Takes a transaction client on purpose: A-009 issues this inside the booking
 * transaction, so an appointment can never commit with no way to manage it,
 * for the same reason its confirmation is enqueued there (D-14).
 *
 * `keepPrevious` exists for the reminder, and demo checkpoint 4 is why (D-38).
 * D-28's argument for revoke-on-reissue ends "the reminder always carries a
 * fresh link, so nothing is left dangling" — which is true only if the
 * reminder is DELIVERED. Enqueuing is not delivering: the walk revoked her
 * confirmation link, failed the reminder permanently, and left her holding a
 * dead link with no replacement.
 */
export async function issueManageToken(db: Db, input: IssueManageTokenInput): Promise<IssuedManageToken> {
  const { token, tokenHash } = mintManageToken();
  const expiresAt = toDate(manageTokenExpiry(fromDate(input.endAt)));

  if (!input.keepPrevious) await revokeManageTokens(db, input.appointmentId, input.now);
  await db.manageToken.create({
    data: {
      businessId: input.businessId,
      appointmentId: input.appointmentId,
      tokenHash,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

/** What a valid token grants. The appointment id and NOTHING else — no client,
 *  no business-wide read. `tokenId` is the audit trail: it becomes the
 *  `actorRef` on every event the customer causes (D-9). */
export interface ManageGrant {
  tokenId: string;
  appointmentId: string;
  businessId: string;
}

/**
 * Returns the grant, or null for anything wrong — unknown, revoked, expired.
 *
 * NULL RATHER THAN A REASON, exactly as `verifySession` does. "This link has
 * expired" and "no such link" are the same sentence to the customer (TOKEN-02:
 * a clear, non-enumerating message), and a differentiated error is a probe
 * telling an attacker which of their guesses named a real appointment.
 */
export async function verifyManageToken(db: Db, token: string, now: Date): Promise<ManageGrant | null> {
  const row = await db.manageToken.findUnique({
    where: { tokenHash: hashManageToken(token) },
    select: { id: true, appointmentId: true, businessId: true, expiresAt: true, revokedAt: true },
  });

  if (!row) return null;
  if (row.revokedAt !== null) return null;
  // Exactly ON the expiry is dead. An expiry is the first instant the token no
  // longer works, and the alternative — one more millisecond — is a boundary
  // nobody can state in a sentence.
  if (fromDate(row.expiresAt) <= fromDate(now)) return null;

  return { tokenId: row.id, appointmentId: row.appointmentId, businessId: row.businessId };
}

/**
 * TOKEN-02 — reschedule RE-POINTS the token; it is never burned or replaced.
 *
 * The appointment row survives a reschedule (D-6), so the token already points
 * at the right thing; only its expiry moves, because the appointment now ends
 * somewhere else. Reissuing instead would break the link in the customer's own
 * confirmation message — the one she rescheduled FROM, which is the one she
 * will open again to cancel.
 *
 * Lives here rather than in A-014's reschedule so that `end + 24h` is stated
 * in exactly one place; a second copy of that arithmetic is how two surfaces
 * come to disagree about when a link dies.
 */
export async function repointManageTokens(db: Db, appointmentId: string, newEndAt: Date): Promise<void> {
  await db.manageToken.updateMany({
    where: { appointmentId, revokedAt: null },
    data: { expiresAt: toDate(manageTokenExpiry(fromDate(newEndAt))) },
  });
}

/** Kills every live token for an appointment. Idempotent — already-revoked
 *  rows keep their original revocation time, which is the one that is true. */
export async function revokeManageTokens(db: Db, appointmentId: string, now: Date): Promise<void> {
  await db.manageToken.updateMany({
    where: { appointmentId, revokedAt: null },
    data: { revokedAt: now },
  });
}
