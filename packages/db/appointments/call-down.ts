/**
 * A-021 — THE CALL-DOWN LIST (APPT-02).
 *
 * "Unconfirmed tomorrow" is DERIVED, same reflex as AVAIL-05's conflicts and
 * CLIENT-04's counters (operator R-7): nothing stores "needs a call", because
 * the moment somebody confirms — by staff or by the manage link — the fact
 * that produced the row disappears on its own. A stored flag would need its
 * own clearing code and a second place to go stale.
 *
 * `booked` is the only status this asks for. `confirmed` has already had its
 * call; anything terminal (cancelled, no_show) is not tomorrow's problem
 * anymore. No `system` actor ever moves a row off this list on its own —
 * APPT-02 is explicit that no reply never auto-cancels, and the absence of a
 * `system` clause in §7's table is what makes that true here too.
 */
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

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

  return rows.map((row) => ({
    id: row.id,
    startAt: row.startAt,
    providerName: row.provider.displayName,
    clientId: row.client?.id ?? null,
    clientName: row.client?.name ?? null,
    clientPhone: row.client?.phone ?? null,
    serviceNames: row.lines.map((l) => l.service.name),
    valueCents: row.lines.reduce((total, line) => total + line.priceCents, 0),
  }));
}
