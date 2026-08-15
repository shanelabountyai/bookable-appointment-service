/**
 * WHO DID THIS (D-9).
 *
 * Every mutation carries one of these. Without an actor there is no
 * "blocked for customers, allowed for staff" cancellation cutoff (D-11), no
 * audit log worth the name (APPT-07), and no way for the day view to
 * distinguish a staff override from a customer booking (D-8).
 *
 * The union mirrors the Prisma `Actor` enum exactly. It is redeclared here
 * rather than imported so `packages/core` stays free of `packages/db` — the
 * same split `NotificationChannel` uses. A string literal satisfies both.
 */
export type ActorType = 'staff' | 'customer_token' | 'system';

export interface Actor {
  type: ActorType;
  /**
   * Which staff user, or which manage token. Null for `system`.
   *
   * Recorded so "who marked this no-show" is answerable by a name rather than
   * by a role. In v1 there is one shared staff credential (D-9), so this is
   * the same id for every staff action today — but the column being there
   * from the start is what makes multi-user staff auth (Phase 3) a data
   * change rather than a schema migration across every event ever written.
   */
  ref: string | null;
}

export const systemActor: Actor = { type: 'system', ref: null };

export const staffActor = (staffUserId: string): Actor => ({ type: 'staff', ref: staffUserId });

export const customerTokenActor = (tokenId: string): Actor => ({ type: 'customer_token', ref: tokenId });
