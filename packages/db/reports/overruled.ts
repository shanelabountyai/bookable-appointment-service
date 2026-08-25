/**
 * A-060 — WHO LET ONE OFF, AND HOW OFTEN (APPT-06).
 *
 * The point of deriving `cancelled` vs `cancelled_late` from the cutoff is
 * that the number stops being an artifact of which button was nearer the
 * thumb. The point of the escape beside it is that a real salon lets people
 * off, and pretending otherwise just moves the lie somewhere the owner cannot
 * see it. This is the surface that keeps the escape honest: every overrule is
 * a row here, with a name on it and the reason that was typed.
 *
 * DERIVED FROM THE EVENT LOG, nothing stored (operator R-7). The event is
 * append-only by trigger, so an overrule cannot be quietly un-recorded — and a
 * later correction of the appointment leaves this row exactly where it is,
 * because "we overruled the cutoff on the 14th" stays true whatever happens to
 * the appointment afterwards.
 *
 * SCOPED BY THE APPOINTMENT'S OWN DAY, not by when the overrule was typed, so
 * the count reconciles with the Cancellations tile it hangs off: both are
 * answering "what happened to this week's book".
 */
import { resolveStaffNames } from '../auth';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface OverruledCancellation {
  eventId: string;
  appointmentId: string;
  startAt: Date;
  startDay: string;
  clientName: string | null;
  providerName: string;
  /** The person who overruled it, or null for a row whose staff id no longer
   *  resolves — never coerced to "the front desk", which would claim knowledge
   *  the row does not have (A-037's rule). */
  staffName: string | null;
  /** Required at the write, so in practice never null — but the column is
   *  nullable and a screen that assumes otherwise crashes on old data. */
  reason: string | null;
  /** What the machine would have written. Always `cancelled_late` today; read
   *  from the payload rather than assumed, because that is what makes this a
   *  record instead of a restatement. */
  overruled: string;
  at: Date;
}

/**
 * Every classification a human is allowed to overrule. One member today, and
 * a list rather than a bare equality because the JSON filter cannot be typed
 * against the status enum — a second overrulable classification would
 * otherwise be written by the transition module and silently missed here,
 * which is the rental `VERIFIED` defect wearing a different hat.
 */
const OVERRULABLE = ['cancelled_late'] as const;

/** The Prisma JSON filter that finds them. One place, so the count and the
 *  list cannot come to disagree about what an overrule is. */
const overruleWhere = (businessId: string, fromDay: string, toDay: string) => ({
  businessId,
  type: 'status_changed',
  OR: OVERRULABLE.map((s) => ({ payload: { path: ['overruled'], equals: s } })),
  appointment: { startDay: { gte: fromDay, lte: toDay } },
});

export async function countOverruledCancellations(
  db: Db,
  args: { businessId: string; fromDay: string; toDay: string },
): Promise<number> {
  return db.appointmentEvent.count({ where: overruleWhere(args.businessId, args.fromDay, args.toDay) });
}

export async function listOverruledCancellations(
  db: Db,
  args: { businessId: string; fromDay: string; toDay: string },
): Promise<OverruledCancellation[]> {
  const rows = await db.appointmentEvent.findMany({
    where: overruleWhere(args.businessId, args.fromDay, args.toDay),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      actor: true,
      actorRef: true,
      reason: true,
      payload: true,
      createdAt: true,
      appointment: {
        select: {
          id: true,
          startAt: true,
          startDay: true,
          client: { select: { name: true } },
          provider: { select: { displayName: true } },
        },
      },
    },
  });

  const names = await resolveStaffNames(
    db as PrismaClient,
    rows.filter((r) => r.actor === 'staff' && r.actorRef).map((r) => r.actorRef!),
  );

  return rows.map((row) => ({
    eventId: row.id,
    appointmentId: row.appointment.id,
    startAt: row.appointment.startAt,
    startDay: row.appointment.startDay.trim(),
    clientName: row.appointment.client?.name ?? null,
    providerName: row.appointment.provider.displayName,
    staffName: (row.actor === 'staff' && row.actorRef ? names.get(row.actorRef) : undefined) ?? null,
    reason: row.reason,
    overruled: String((row.payload as Record<string, unknown> | null)?.overruled ?? 'cancelled_late'),
    at: row.createdAt,
  }));
}
