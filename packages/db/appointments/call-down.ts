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
  clientName: string | null;
  clientPhone: string | null;
  serviceNames: string[];
}

/**
 * `tomorrow` is the caller's business-zone day label (P1-6) — this function
 * reads no clock and derives no timezone, same discipline as
 * `clientReliability`'s `today`.
 *
 * Sorted by time: the desk works down the day in order. OQ-3's sibling open
 * question, OQ-5, asks whether this should instead rank by ticket value or
 * no-show risk — unanswered, so this stays the plain reading until it is.
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
      client: { select: { name: true, phone: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { service: { select: { name: true } } } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    startAt: row.startAt,
    providerName: row.provider.displayName,
    clientName: row.client?.name ?? null,
    clientPhone: row.client?.phone ?? null,
    serviceNames: row.lines.map((l) => l.service.name),
  }));
}
