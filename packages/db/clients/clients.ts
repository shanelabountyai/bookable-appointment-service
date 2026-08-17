/**
 * A-015 — THE CLIENT RECORD (CLIENT-01..03, D-17, operator R-10).
 *
 * The shape of this file follows from one decision made in A-003 and defended
 * in D-17: **`Client.phone` is indexed, NOT unique.** A household shares a
 * number, and a unique index silently makes a mother and her teenage daughter
 * one client — merged allergy notes, which CLIENT-03 calls a safety surface,
 * and one shared no-show counter, so the daughter's two no-shows block the
 * mother from booking. Unwinding that after the records have merged is data
 * repair, not a migration.
 *
 * So every lookup here returns a LIST and staff choose. Nothing in this file
 * ever decides that two records are the same person; it only carries out the
 * decision when a human makes it.
 */
import { naturalIntervalDays, normalizePhone } from '../../core/clients';
import { addDays, calendarDay } from '../../core/time';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** What every lookup returns. `mergedIntoClientId` is absent on purpose —
 *  callers get survivors, and a tombstone is resolved before it reaches them. */
export interface ClientSummary {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  /** True when this record was reached through a merged-away one — the front
   *  desk searched an old number and landed on the survivor. Worth saying on
   *  screen, so "that's not the number I dialled" has an answer. */
  reachedByOldNumber?: boolean;
}

const SUMMARY = { id: true, name: true, phone: true, email: true, notes: true } as const;

/**
 * CLIENT-01's lookup. Returns a LIST, never a single client.
 *
 * A tombstone that matches resolves to its survivor (R-10) and is flagged, so
 * the old number keeps working forever without the front desk landing on a
 * record that has no future appointments in it.
 */
export async function findClientsByPhone(
  db: Db,
  businessId: string,
  rawPhone: string,
): Promise<ClientSummary[]> {
  const phone = normalizePhone(rawPhone);
  if (phone === '') return [];

  const matches = await db.client.findMany({
    where: { businessId, phone },
    select: { ...SUMMARY, mergedIntoClientId: true },
    orderBy: { createdAt: 'asc' },
  });

  return resolveTombstones(db, businessId, matches);
}

/**
 * Partial search across name and phone, for a front desk that has half of one
 * or the other. Case-insensitive on the name; digits-only on the phone, so
 * "555 0101" finds `5125550101`.
 */
export async function searchClients(db: Db, businessId: string, query: string): Promise<ClientSummary[]> {
  const text = query.trim();
  if (text === '') return [];

  const digits = text.replace(/[^\d]/g, '');
  const matches = await db.client.findMany({
    where: {
      businessId,
      OR: [
        { name: { contains: text, mode: 'insensitive' } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ],
    },
    select: { ...SUMMARY, mergedIntoClientId: true },
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    take: 50,
  });

  return resolveTombstones(db, businessId, matches);
}

export async function findClient(db: Db, businessId: string, id: string): Promise<ClientSummary | null> {
  const row = await db.client.findFirst({
    where: { id, businessId },
    select: { ...SUMMARY, mergedIntoClientId: true },
  });
  if (!row) return null;
  const [resolved] = await resolveTombstones(db, businessId, [row]);
  return resolved ?? null;
}

/** CLIENT-03's pinned note — formula, allergies. Rendered on every appointment
 *  surface, which is why it is one field on the client and not a per-visit
 *  scribble (that is `Appointment.notes`). */
export async function setClientNotes(db: Db, businessId: string, id: string, notes: string): Promise<void> {
  await db.client.updateMany({
    where: { id, businessId },
    data: { notes: notes.trim() || null },
  });
}

export interface ClientVisit {
  appointmentId: string;
  startAt: Date;
  status: string;
  providerName: string;
  services: string[];
  /** The SNAPSHOTTED total (D-18) — what she was actually charged, not what
   *  the service costs today. */
  priceCents: number;
  notes: string | null;
}

/**
 * CLIENT-02's history: date, provider, service, price, status — **including**
 * no-shows and late cancels.
 *
 * Including them is the point. A history that hides them is a history that
 * makes the front desk look unprepared when the client who missed twice rings
 * to book a third time, and it is the same data CLIENT-04's counter is built
 * from — two sources would eventually disagree about the same appointment.
 */
export async function clientHistory(db: Db, businessId: string, clientId: string): Promise<ClientVisit[]> {
  // Tombstones' appointments were moved to the survivor at merge time, so this
  // needs no union — the merge is what makes "history follows the merge" true,
  // not a clever read.
  const rows = await db.appointment.findMany({
    where: { businessId, clientId },
    orderBy: { startAt: 'desc' },
    select: {
      id: true,
      startAt: true,
      status: true,
      notes: true,
      provider: { select: { displayName: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { priceCents: true, service: { select: { name: true } } } },
    },
  });

  return rows.map((row) => ({
    appointmentId: row.id,
    startAt: row.startAt,
    status: row.status,
    providerName: row.provider.displayName,
    services: row.lines.map((l) => l.service.name),
    priceCents: row.lines.reduce((total, l) => total + l.priceCents, 0),
    notes: row.notes,
  }));
}

export class MergeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeRefused';
  }
}

export interface MergeResult {
  survivorId: string;
  appointmentsMoved: number;
  /** Tombstones that were already pointing at the loser and now point at the
   *  survivor — the chain flattening. */
  tombstonesRepointed: number;
}

/**
 * CLIENT-01's "staff merge duplicates (history follows the merge)".
 *
 * ONE TRANSACTION, and the loser SURVIVES as a tombstone (R-10). Four things
 * move or are preserved, and each has a reason it cannot be skipped:
 *
 *  1. Appointments — "history follows the merge" is this line. Without it the
 *     survivor has half a history and CLIENT-04's no-show counter reads low.
 *  2. Waitlist entries — otherwise she is waiting under a record nobody looks
 *     at, and the offer goes nowhere.
 *  3. Notes are CONCATENATED, never replaced. The note is a safety surface
 *     (CLIENT-03): a merge that silently drops "allergic to PPD" because the
 *     survivor already had a note is the one failure here that hurts somebody.
 *  4. Contact details fill GAPS only. The survivor is the record staff chose;
 *     overwriting its phone with the loser's would move the person to the
 *     number they just decided was the old one.
 */
export async function mergeClients(
  prisma: PrismaClient,
  args: { businessId: string; survivorId: string; losingId: string },
): Promise<MergeResult> {
  if (args.survivorId === args.losingId) {
    throw new MergeRefused('A client cannot be merged into itself.');
  }

  return prisma.$transaction(async (tx) => {
    const [survivor, loser] = await Promise.all([
      tx.client.findFirst({ where: { id: args.survivorId, businessId: args.businessId } }),
      tx.client.findFirst({ where: { id: args.losingId, businessId: args.businessId } }),
    ]);

    if (!survivor || !loser) throw new MergeRefused('Both records must belong to this business.');
    // Merging INTO a tombstone would leave the survivor of that earlier merge
    // holding none of this history; merging one that is already merged is a
    // double-count of the same decision.
    if (survivor.mergedIntoClientId) throw new MergeRefused('That record has already been merged into another.');
    if (loser.mergedIntoClientId) throw new MergeRefused('That record has already been merged into another.');

    const moved = await tx.appointment.updateMany({
      where: { businessId: args.businessId, clientId: loser.id },
      data: { clientId: survivor.id },
    });
    await tx.waitlistEntry.updateMany({
      where: { businessId: args.businessId, clientId: loser.id },
      data: { clientId: survivor.id },
    });

    // Chain flattening: anything already pointing at the loser now points at
    // the survivor, so resolution stays one hop forever (see the schema note).
    const repointed = await tx.client.updateMany({
      where: { businessId: args.businessId, mergedIntoClientId: loser.id },
      data: { mergedIntoClientId: survivor.id },
    });

    await tx.client.update({
      where: { id: survivor.id },
      data: {
        notes: mergeNotes(survivor.notes, loser.notes),
        name: survivor.name ?? loser.name,
        phone: survivor.phone ?? loser.phone,
        email: survivor.email ?? loser.email,
        smsConsentAt: survivor.smsConsentAt ?? loser.smsConsentAt,
      },
    });

    await tx.client.update({
      where: { id: loser.id },
      data: {
        mergedIntoClientId: survivor.id,
        // Stamped from the database clock rather than an injected `now`: this
        // records when the row was written, not a domain instant anything
        // computes against. Nothing branches on it.
        mergedAt: new Date(),
      },
    });

    return {
      survivorId: survivor.id,
      appointmentsMoved: moved.count,
      tombstonesRepointed: repointed.count,
    };
  });
}

// ─────────────────────────── internals ───────────────────────────

/** Both notes, in full, with the older one marked. Never a replacement — see
 *  the allergy reasoning above. */
function mergeNotes(survivor: string | null, loser: string | null): string | null {
  const kept = survivor?.trim() || '';
  const brought = loser?.trim() || '';
  if (!brought) return kept || null;
  if (!kept) return brought;
  return `${kept}\n\n— merged from a duplicate record —\n${brought}`;
}

/**
 * Replaces any tombstone in the list with its survivor, flagged.
 *
 * One extra query for the whole list rather than one per row, and one hop by
 * construction: `mergeClients` re-points existing tombstones, so a survivor
 * found here can never itself be merged away.
 */
async function resolveTombstones(
  db: Db,
  businessId: string,
  rows: readonly (ClientSummary & { mergedIntoClientId: string | null })[],
): Promise<ClientSummary[]> {
  const targetIds = [...new Set(rows.filter((r) => r.mergedIntoClientId).map((r) => r.mergedIntoClientId!))];
  const survivors =
    targetIds.length === 0
      ? []
      : await db.client.findMany({ where: { businessId, id: { in: targetIds } }, select: SUMMARY });
  const byId = new Map(survivors.map((s) => [s.id, s]));

  const out: ClientSummary[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const resolved = row.mergedIntoClientId ? byId.get(row.mergedIntoClientId) : row;
    if (!resolved || seen.has(resolved.id)) continue;
    seen.add(resolved.id);
    // Rebuilt field by field rather than spread: `row` carries
    // `mergedIntoClientId`, and a summary that leaked it would put an internal
    // pointer on every screen that renders a client.
    const summary: ClientSummary = {
      id: resolved.id,
      name: resolved.name,
      phone: resolved.phone,
      email: resolved.email,
      notes: resolved.notes,
    };
    out.push(row.mergedIntoClientId ? { ...summary, reachedByOldNumber: true } : summary);
  }
  return out;
}

export interface RebookSuggestion {
  providerId: string;
  providerName: string;
  serviceIds: string[];
  serviceNames: string[];
  /** The calendar day to START the slot search on — her own rhythm applied to
   *  her last visit, never earlier than today. */
  fromDay: string;
  /** The visit this was read from, for the screen to name ("last in on …"). */
  lastVisitDay: string;
  intervalDays: number;
}

/**
 * CLIENT-02's "rebook last visit": prefills provider + service and jumps the
 * slot search to the natural interval.
 *
 * Reads the LAST visit that was actually kept. A cancelled appointment is not
 * a visit — suggesting "the same as last time" from an appointment she never
 * attended would rebook a service she may have cancelled precisely because she
 * did not want it.
 *
 * The day arithmetic is on the CALENDAR axis throughout, using the
 * denormalized `startDay` rather than converting instants: her rhythm is "six
 * weeks", which is a calendar fact.
 */
export async function rebookSuggestion(
  db: Db,
  businessId: string,
  clientId: string,
  today: string,
): Promise<RebookSuggestion | null> {
  const visits = await db.appointment.findMany({
    where: { businessId, clientId, status: { notIn: ['cancelled', 'cancelled_late'] } },
    orderBy: { startAt: 'desc' },
    take: 2,
    select: {
      startDay: true,
      provider: { select: { id: true, displayName: true } },
      lines: { orderBy: { ordinal: 'asc' }, select: { serviceId: true, service: { select: { name: true } } } },
    },
  });

  const last = visits[0];
  if (!last) return null;

  const days = visits.map((v) => calendarDay(v.startDay.trim()));
  const intervalDays = naturalIntervalDays(days);
  const suggested = addDays(days[0]!, intervalDays);

  return {
    providerId: last.provider.id,
    providerName: last.provider.displayName,
    serviceIds: last.lines.map((l) => l.serviceId),
    serviceNames: last.lines.map((l) => l.service.name),
    // Never in the past: a client who last came a year ago would otherwise
    // open the booking page on a day the salon cannot sell.
    fromDay: suggested > today ? suggested : today,
    lastVisitDay: days[0]!,
    intervalDays,
  };
}
