/**
 * A-072 — WHO HAS ALREADY BEEN OFFERED THIS FREED SLOT (WAIT-02, D-37(b)).
 *
 * Thursday's three-hour colour cancels on Saturday morning and lands on
 * `/staff/opened` with two waitlist matches and a tel: link. The desk rings
 * Mrs Patel, who says "let me check with work". Then a walk-in arrives and the
 * phone goes, and at 4pm the second person at the desk opens the same list,
 * sees the same slot and the same two names, and **rings Mrs Patel again — or
 * promises it to the second name while the first is still deciding.**
 *
 * A-061 fixed exactly this for the call-down list. The list with the money on
 * it never got it, and this is that correction.
 *
 * A RECORD, NOT A HOLD. That is the whole reason this is buildable while
 * OQ-4's soft-hold offer is correctly still blocked: the slot stays sellable
 * to anybody throughout, nothing here refuses a booking, delays one, or
 * reserves anything. It is a note about a phone call a human made, exactly
 * like `RunningLateTold` and `CallDownAttempt` — and like both of those it
 * **sends nothing**, must appear nowhere near `deliveryWord()` (D-41), and has
 * a test asserting the outbox does not move.
 *
 * NO CLEARING CODE, and the reason is A-067's: `/staff/opened` is derived on
 * every read, so when the slot is sold it leaves the list and these marks are
 * simply never read again. A span freed twice gets a different `freedKey` and
 * therefore a clean slate.
 */
import type { Actor } from '../../core/auth';
import { resolveStaffNames } from '../auth';
import type { FreedOfferOutcome, Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export type { FreedOfferOutcome };

/** The most recent offer of one slot to one client. Never a count: a client
 *  rung twice is still one person to ring again. */
export interface FreedOffer {
  clientId: string;
  clientName: string | null;
  outcome: FreedOfferOutcome;
  /** The person who rang, when the log knows one. Null for a row whose staff
   *  id no longer resolves — never coerced to "the front desk", which would
   *  claim knowledge the row does not have (A-037's rule). */
  offeredByName: string | null;
  offeredAt: Date;
}

/**
 * Records that somebody was offered this slot, and what she said.
 *
 * UPSERT, so a second call re-stamps: "no answer at 2, thinking about it at 4"
 * is one row whose current state is "thinking about it", because that is the
 * fact the next person at the desk needs. Two desks pressing one button in the
 * same second is the same upsert rather than a list reading "rung, rung".
 */
export async function recordFreedOffer(
  db: Db,
  args: {
    businessId: string;
    /** A-067's derived row key for the freed span. */
    freedKey: string;
    appointmentId: string;
    clientId: string;
    outcome: FreedOfferOutcome;
    actor: Actor;
  },
): Promise<FreedOffer | null> {
  // Both sides scoped to the business, because `freedKey` arrives from a URL
  // and an id from another salon must not become a row here.
  const [appointment, client] = await Promise.all([
    db.appointment.findFirst({
      where: { id: args.appointmentId, businessId: args.businessId },
      select: { id: true },
    }),
    db.client.findFirst({
      where: { id: args.clientId, businessId: args.businessId },
      select: { id: true, name: true },
    }),
  ]);
  if (!appointment || !client) return null;

  const row = await db.freedSlotOffer.upsert({
    where: { freedKey_clientId: { freedKey: args.freedKey, clientId: args.clientId } },
    create: {
      businessId: args.businessId,
      freedKey: args.freedKey,
      appointmentId: args.appointmentId,
      clientId: args.clientId,
      outcome: args.outcome,
      offeredByActor: args.actor.type,
      actorRef: args.actor.ref,
    },
    update: { outcome: args.outcome, offeredByActor: args.actor.type, actorRef: args.actor.ref },
  });

  const names = await resolveStaffNames(db as PrismaClient, row.actorRef ? [row.actorRef] : []);
  return {
    clientId: row.clientId,
    clientName: client.name,
    outcome: row.outcome,
    offeredByName: (row.offeredByActor === 'staff' && row.actorRef ? names.get(row.actorRef) : undefined) ?? null,
    offeredAt: row.updatedAt,
  };
}

/**
 * Untick. A shared screen, so a mis-tap otherwise marks the WRONG client as
 * rung — which silently skips her, the exact harm this exists to prevent,
 * inverted. Reversible by the same hand that made it, the same reasoning A-059
 * and A-061 both applied to their marks.
 */
export async function clearFreedOffer(
  db: Db,
  args: { businessId: string; freedKey: string; clientId: string },
): Promise<void> {
  await db.freedSlotOffer.deleteMany({
    where: { businessId: args.businessId, freedKey: args.freedKey, clientId: args.clientId },
  });
}

/**
 * Every offer made about these slots, keyed by `freedKey`.
 *
 * Takes the WHOLE list of keys in one call rather than one query per row: the
 * freed list is a fortnight of a salon's cancellations, and a per-row read
 * there is the N+1 the opened list already avoids for its emptiness check by
 * bounding first.
 */
export async function listFreedOffers(
  db: Db,
  args: { businessId: string; freedKeys: readonly string[] },
): Promise<Map<string, FreedOffer[]>> {
  const out = new Map<string, FreedOffer[]>();
  if (args.freedKeys.length === 0) return out;

  const rows = await db.freedSlotOffer.findMany({
    where: { businessId: args.businessId, freedKey: { in: [...args.freedKeys] } },
    orderBy: { updatedAt: 'asc' },
    select: {
      freedKey: true,
      clientId: true,
      outcome: true,
      offeredByActor: true,
      actorRef: true,
      updatedAt: true,
      client: { select: { name: true } },
    },
  });
  if (rows.length === 0) return out;

  const names = await resolveStaffNames(
    db as PrismaClient,
    rows.flatMap((row) => (row.offeredByActor === 'staff' && row.actorRef ? [row.actorRef] : [])),
  );

  for (const row of rows) {
    const list = out.get(row.freedKey) ?? [];
    list.push({
      clientId: row.clientId,
      clientName: row.client.name,
      outcome: row.outcome,
      offeredByName: (row.offeredByActor === 'staff' && row.actorRef ? names.get(row.actorRef) : undefined) ?? null,
      offeredAt: row.updatedAt,
    });
    out.set(row.freedKey, list);
  }
  return out;
}
