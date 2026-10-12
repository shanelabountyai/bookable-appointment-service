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

/**
 * M-009 (MCP PRD OQ-M1, M-D1): HOW the actor reached the system. `desk` is a
 * staff session at the terminal, `manage_link` the customer's tokenized link,
 * `mcp` an AI client acting for a named staff member, `system` a job. Written
 * on every AppointmentEvent so "Booked by Sam via Claude" is a fact the log
 * holds, not a guess.
 */
export type Channel = 'desk' | 'manage_link' | 'mcp' | 'system';

/** The channel an event row records for this actor. ONE place, so every writer agrees. */
export const channelOf = (actor: Actor): Channel =>
  actor.channel ?? (actor.type === 'customer_token' ? 'manage_link' : actor.type === 'system' ? 'system' : 'desk');

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
  /** Absent means the default for the actor type — see `channelOf`. */
  channel?: Channel;
}

export const systemActor: Actor = { type: 'system', ref: null };

export const staffActor = (staffUserId: string): Actor => ({ type: 'staff', ref: staffUserId });

export const customerTokenActor = (tokenId: string): Actor => ({ type: 'customer_token', ref: tokenId });

/** A named staff member acting THROUGH an AI client (MCP). Same person in the log, different channel. */
export const mcpActor = (staffUserId: string): Actor => ({ type: 'staff', ref: staffUserId, channel: 'mcp' });
