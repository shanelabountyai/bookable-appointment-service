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
 * holds, not a guess. W-001 adds `api`: an integration's write through
 * /api/v1, by an `ApiKey` (API PRD §5, W-D1).
 */
export type Channel = 'desk' | 'manage_link' | 'mcp' | 'system' | 'api';

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

/**
 * W-001 (API PRD §5, W-D1) — an INTEGRATION writing through /api/v1 with an
 * `ApiKey`. `ref` is the key's id, not a person's, and the channel is what the
 * audit line reads ("Booked via API (HubSpot sync)").
 *
 * Typed `staff`, not `system`, ON PURPOSE (W-D1): the transition table grants
 * status moves to `staff` and `customer_token` only, and `system` is the cron.
 * An API key is the owner's delegate at the desk — the same rules, the same
 * notification side effects — so §2's "nothing the API writes skips the rules
 * the desk follows" is true by construction rather than by a parallel table.
 * Readers that resolve `actorRef` to a staff NAME must check the channel first;
 * `withActorNames` does.
 */
export const apiActor = (apiKeyId: string): Actor => ({ type: 'staff', ref: apiKeyId, channel: 'api' });
