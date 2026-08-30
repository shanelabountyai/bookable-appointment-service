/**
 * A-021 — THE CALL-DOWN LIST (APPT-02).
 *
 * "Unconfirmed tomorrow" is DERIVED, same reflex as AVAIL-05's conflicts and
 * CLIENT-04's counters (operator R-7): nothing stores "needs a call", because
 * the moment somebody confirms — by staff or by the manage link — the fact
 * that produced the row disappears on its own. A stored flag would need its
 * own clearing code and a second place to go stale.
 *
 * A-061 ADDS THE ONE THING THAT IS NOT DERIVABLE, and the distinction is the
 * point rather than a softening of the rule above. "Needs a call" is derived
 * and stays derived. "We ALREADY rang her and she did not pick up" can be read
 * back out of nothing at all: no status moves, no message is sent, the
 * appointment is identical afterwards. Stored, therefore — scoped to the day
 * it was about, so it still needs no clearing code.
 *
 * `booked` is the only status this asks for. `confirmed` has already had its
 * call; anything terminal (cancelled, no_show) is not tomorrow's problem
 * anymore. No `system` actor ever moves a row off this list on its own —
 * APPT-02 is explicit that no reply never auto-cancels, and the absence of a
 * `system` clause in §7's table is what makes that true here too.
 */
import type { Actor } from '../../core/auth';
import { resolveStaffNames } from '../auth';
import type { CallAttemptOutcome, Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export type { CallAttemptOutcome };

/** A-061 — the most recent call at this appointment, for the day it is on. */
export interface CallAttempt {
  outcome: CallAttemptOutcome;
  /** The person who rang, when the log knows one. Null for a row whose staff
   *  id no longer resolves — never coerced to "the front desk", which would
   *  claim knowledge the row does not have (A-037's rule). */
  triedByName: string | null;
  triedAt: Date;
}

export interface UnconfirmedAppointment {
  id: string;
  startAt: Date;
  providerName: string;
  /** A-051 (OQ-5): needed to put the no-show flag on the row. Null for a
   *  walk-in with no record, which has no history to flag. */
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  serviceNames: string[];
  /** A-051 (OQ-5): what tomorrow loses if this one does not turn up. Summed
   *  from the appointment's OWN line prices, never the live catalogue — the
   *  visit was priced when it was booked (D-16's reflex). */
  valueCents: number;
  /** A-061: the last attempt at THIS appointment for THIS day, or null when
   *  nobody has rung yet. Never a count — a row that has been tried twice is
   *  still one row to ring again, and the history belongs in the event log. */
  attempt: CallAttempt | null;
}

/**
 * `tomorrow` is the caller's business-zone day label (P1-6) — this function
 * reads no clock and derives no timezone, same discipline as
 * `clientReliability`'s `today`.
 *
 * SORTED BY TIME, and A-051 settled that rather than leaving it open (D-37).
 * OQ-5 asked whether this should rank by ticket value or no-show risk
 * instead; the answer is neither. The desk works down the day in order,
 * usually with the diary open beside it, and silently reordering that list
 * makes every row's position mean something the person reading it does not
 * know. What the row now CARRIES is the triage information — the ticket value
 * and the no-show flag — so a desk that runs out of afternoon can pick, which
 * is the need behind the question without the surprise behind the answer.
 */
export async function listUnconfirmedTomorrow(
  db: Db,
  args: { businessId: string; tomorrow: string },
): Promise<UnconfirmedAppointment[]> {
  const rows = await db.appointment.findMany({
    where: { businessId: args.businessId, status: 'booked', startDay: args.tomorrow },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      startAt: true,
      provider: { select: { displayName: true } },
      client: { select: { id: true, name: true, phone: true } },
      lines: {
        orderBy: { ordinal: 'asc' },
        select: { priceCents: true, service: { select: { name: true } } },
      },
    },
  });

  // A-061. One query for the whole list plus one for the names, the same
  // shape `clientReliability` uses — a per-row lookup would be eighteen
  // round-trips on the screen whose entire complaint is that it is slow to
  // work through.
  //
  // `forDay` is matched against the day being listed, NOT just the
  // appointment id: an appointment rescheduled off this day keeps its row
  // (D-6), and its old attempt must not follow it.
  const attempts = await db.callDownAttempt.findMany({
    where: { appointmentId: { in: rows.map((r) => r.id) }, forDay: args.tomorrow },
    select: { appointmentId: true, outcome: true, triedByActor: true, actorRef: true, createdAt: true },
  });
  const names = await resolveStaffNames(
    db as PrismaClient,
    attempts.filter((a) => a.triedByActor === 'staff' && a.actorRef).map((a) => a.actorRef!),
  );
  const byAppointment = new Map(
    attempts.map((a) => [
      a.appointmentId,
      {
        outcome: a.outcome,
        triedByName: (a.triedByActor === 'staff' && a.actorRef ? names.get(a.actorRef) : undefined) ?? null,
        triedAt: a.createdAt,
      } satisfies CallAttempt,
    ]),
  );

  return rows.map((row) => ({
    id: row.id,
    startAt: row.startAt,
    providerName: row.provider.displayName,
    clientId: row.client?.id ?? null,
    clientName: row.client?.name ?? null,
    clientPhone: row.client?.phone ?? null,
    serviceNames: row.lines.map((l) => l.service.name),
    valueCents: row.lines.reduce((total, line) => total + line.priceCents, 0),
    attempt: byAppointment.get(row.id) ?? null,
  }));
}

/**
 * "I rang her — no answer." / "Left her a message."
 *
 * SENDS NOTHING, and that is the decision rather than an omission — the same
 * one A-059 took for the running-late ring-round. D-14 still has no driver,
 * and A-044's finding was that a message row rendering as "queued" beside a
 * client's name is read by staff as "no need to call her", which is the exact
 * inversion of what this list is for.
 *
 * Scoped to the appointment's OWN `startDay`, read here rather than passed in:
 * a caller that supplied the day could scope an attempt to a day the
 * appointment is not on, and the row would then be invisible forever.
 *
 * Returns null when the appointment is not this business's, or has left
 * `booked` — she confirmed while the desk was dialling, and recording a call
 * against a row that is no longer on the list is a tick nobody will ever see.
 */
export async function recordCallAttempt(
  db: Db,
  args: { businessId: string; appointmentId: string; outcome: CallAttemptOutcome; actor: Actor },
): Promise<CallAttempt | null> {
  const appointment = await db.appointment.findUnique({
    where: { id: args.appointmentId },
    select: { businessId: true, status: true, startDay: true },
  });
  if (!appointment || appointment.businessId !== args.businessId || appointment.status !== 'booked') return null;

  const forDay = appointment.startDay.trim();
  const row = await db.callDownAttempt.upsert({
    where: { appointmentId_forDay: { appointmentId: args.appointmentId, forDay } },
    create: {
      businessId: args.businessId,
      appointmentId: args.appointmentId,
      forDay,
      outcome: args.outcome,
      triedByActor: args.actor.type,
      actorRef: args.actor.ref,
    },
    // A second call RE-STAMPS: "no answer at 2, left a message at 4" is one
    // row whose current state is "left a message", because that is the fact
    // the next person at the desk needs.
    update: { outcome: args.outcome, triedByActor: args.actor.type, actorRef: args.actor.ref },
  });

  const names = await resolveStaffNames(db as PrismaClient, row.actorRef ? [row.actorRef] : []);
  return {
    outcome: row.outcome,
    triedByName: (row.triedByActor === 'staff' && row.actorRef ? names.get(row.actorRef) : undefined) ?? null,
    triedAt: row.createdAt,
  };
}

/**
 * Untick. The call-down is a shared screen and a mis-tap otherwise marks the
 * WRONG client as rung — which silently skips her, the exact harm this item
 * exists to prevent, inverted. So the mark has to be reversible by the same
 * hand that made it, the same reasoning A-059 applied to its ticks.
 */
export async function clearCallAttempt(
  db: Db,
  args: { businessId: string; appointmentId: string },
): Promise<void> {
  await db.callDownAttempt.deleteMany({
    where: { appointmentId: args.appointmentId, businessId: args.businessId },
  });
}
