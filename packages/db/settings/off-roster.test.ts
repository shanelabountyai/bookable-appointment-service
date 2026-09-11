/**
 * A-098 — A STYLIST OFF THE ROSTER, ASKED OF EVERY SURFACE AT ONCE.
 *
 * WHY THIS IS ONE FILE AND NOT SIX ADDITIONS TO SIX SUITES. The defect was
 * never in any one reader. `day-view.ts`, `unfinished.ts`, `opened.ts`,
 * `impact.ts` and `dashboard.ts` each filtered on `Provider.active` for a
 * reason it stated in a comment, and each reason was locally true; four of
 * them were even written by items whose own tests are green to this day. What
 * was wrong was that `active` answers ONE question — may new work be booked
 * with her — and five surfaces asked it as a proxy for five different ones.
 * A test living inside any single suite asks that suite's question and passes,
 * which is exactly what forty green runs did while the boolean quietly took
 * 106 appointments and $2,870 off the grid, off the paper, out of the
 * conflicts list and out of the week's report.
 *
 * So the shape here is the one CLAUDE.md's status-enum rule asks for: ONE
 * operational fact ("Tess has left, and her clients are still booked"),
 * asserted against every reader in the same `it`, on a fixture where the
 * departed stylist and the remaining one are DIFFERENT — a book where
 * everybody is interchangeable cannot fail any of this.
 *
 * And the other half, which is the half that keeps the fix honest: she must
 * still be UNBOOKABLE. A change that made her visible by making her available
 * would pass every assertion above and be a worse bug than the one it fixed,
 * because the offer would then be one the write refuses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate, toLabel, zoneId } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { conflictsForDay } from '../availability/impact';
import { loadDayView } from '../day/day-view';
import { listOpenedSlots } from '../appointments/opened';
import { countUnfinished, listUnfinished } from '../appointments/unfinished';
import { dashboardSummary } from '../reports/dashboard';
import { buildSlotQuery, computeSlotsIn } from '../scheduling/slot-query';
import { setProviderActive } from './providers';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const at = (iso: string) => toDate(instantFromIso(iso));

/** Tuesday 9 June 2026, and a frozen `now` on the Monday before it. Every
 *  fixture is relative to this; a test that reads the clock is wrong even when
 *  it passes (CLAUDE.md). */
const DAY = '2026-06-09';
const NOW = at('2026-06-08T08:00:00-05:00');
/** The Saturday before — inside `listUnfinished`'s default lookback, and far
 *  enough behind `NOW` that the visit has certainly ended. */
const LAST_SATURDAY = '2026-06-06';

let businessId: string;
let danaId: string;
let tessId: string;
let cutId: string;
let clientId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const business = await prisma.business.create({
    data: {
      name: 'Shear Genius',
      timezone: 'America/Chicago',
      slotIntervalMinutes: 15,
      minimumLeadMinutes: 0,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;

  danaId = (await prisma.provider.create({ data: { businessId, displayName: 'Dana', displayOrder: 0 } })).id;
  tessId = (await prisma.provider.create({ data: { businessId, displayName: 'Tess', displayOrder: 1 } })).id;

  cutId = (
    await prisma.service.create({
      data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 },
    })
  ).id;
  await prisma.serviceProvider.createMany({
    data: [
      { businessId, serviceId: cutId, providerId: danaId },
      { businessId, serviceId: cutId, providerId: tessId },
    ],
  });

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ruth Adeyemi', phone: '5125550101' } })).id;

  // Both stylists work Tuesdays and Saturdays. The HOURS ARE NOT TOUCHED by
  // anything below: deactivation writes `Provider.active` and nothing else,
  // which is the whole reason the two derived conflict causes came back empty.
  for (const providerId of [null, danaId, tessId]) {
    // `null` is the BUSINESS's own hours. A provider's window is intersected
    // with them, so without this every column resolves to no hours at all and
    // the gap assertions below pass vacuously.
    for (const weekday of [2, 6]) {
      await createWeeklyWindow(
        prisma,
        { businessId, providerId, weekday, open: '09:00', close: '17:00', endsNextDay: false },
        STAMP,
      );
    }
  }
});

/**
 * One visit, written directly.
 *
 * Not through `bookAppointment`: half of these are in the past and one is
 * cancelled, and the point of the fixture is the STATE of the book on the
 * morning somebody clicks the button, not the path that got it there.
 */
async function visit(options: {
  providerId: string;
  day: string;
  startAt: Date;
  minutes?: number;
  status?: string;
  updatedAt?: Date;
}) {
  const minutes = options.minutes ?? 60;
  const endAt = toDate(instant(fromDate(options.startAt) + minutes * 60_000));
  const row = await prisma.appointment.create({
    data: {
      businessId,
      providerId: options.providerId,
      clientId,
      startDay: options.day,
      startWallTime: toLabel(fromDate(options.startAt), zoneId('America/Chicago')).time,
      startAt: options.startAt,
      endAt,
      blockedStart: options.startAt,
      blockedEnd: endAt,
      status: (options.status ?? 'booked') as 'booked',
      lines: { create: [{ businessId, serviceId: cutId, ordinal: 0, durationMinutes: minutes, priceCents: 5500 }] },
    },
  });
  // `updatedAt` is `@updatedAt`, so a cancellation's recency — the bound
  // `/staff/opened` uses in the absence of a `cancelledAt` column — has to be
  // written after the fact.
  if (options.updatedAt) {
    await prisma.$executeRaw`UPDATE "Appointment" SET "updatedAt" = ${options.updatedAt} WHERE id = ${row.id}`;
  }
  return row;
}

/** The book on the morning Tess leaves: one visit behind her that nobody ever
 *  closed out, one still ahead of her, and one she has just lost. */
async function tessLeaves() {
  const unfinished = await visit({
    providerId: tessId,
    day: LAST_SATURDAY,
    startAt: at('2026-06-06T10:00:00-05:00'),
  });
  const stillBooked = await visit({
    providerId: tessId,
    day: DAY,
    startAt: at('2026-06-09T14:00:00-05:00'),
  });
  const freed = await visit({
    providerId: tessId,
    day: DAY,
    startAt: at('2026-06-09T16:00:00-05:00'),
    status: 'cancelled',
    updatedAt: at('2026-06-07T09:00:00-05:00'),
  });
  // Dana's own Tuesday, so every assertion below can tell "Tess is missing"
  // from "the query returned nothing".
  await visit({ providerId: danaId, day: DAY, startAt: at('2026-06-09T11:00:00-05:00') });

  await setProviderActive(prisma, tessId, false);
  return { unfinished, stillBooked, freed };
}

const dayView = () => loadDayView(prisma, { businessId, day: DAY, now: NOW });
const columnFor = async (providerId: string) => (await dayView()).columns.find((c) => c.providerId === providerId);

describe('a stylist taken off the roster', () => {
  it('IS STILL BOOKED, and every surface that shows the book still shows her', async () => {
    const { unfinished, stillBooked, freed } = await tessLeaves();

    // 1. THE DAY GRID — and therefore the printed sheet, which renders the
    //    same `GridModel`. `active: true` here removed the COLUMN rather than
    //    emptying it, which is how two booked clients left the building.
    const column = await columnFor(tessId);
    expect(column, 'Tess has clients on this day and must have a column').toBeDefined();
    expect(column!.offRoster).toBe(true);
    expect(column!.appointments.map((a) => a.id)).toContain(stillBooked.id);

    // 2. CONFLICTS. There is no absence and no hours change to derive from —
    //    that is the whole trap — so "nobody is coming in to do this" has to
    //    be a cause of its own or the screen reports 0 stranded.
    const conflicts = await conflictsForDay(prisma, { businessId, day: DAY });
    expect(conflicts.map((c) => c.id)).toContain(stillBooked.id);
    // …with the phone number, because the resolution to this is a phone call.
    expect(conflicts.find((c) => c.id === stillBooked.id)!.clientPhone).toBe('+15125550101');

    // 3. CLOSING OUT. Her last Saturday is a visit that HAPPENED; leaving it
    //    unfinishable freezes it at `booked` forever and poisons the no-show
    //    counts, the lapsed report and CLIENT-04's reliability flag with it.
    const open = await listUnfinished(prisma, { businessId, now: NOW });
    expect(open.map((a) => a.id)).toContain(unfinished.id);
    expect(await countUnfinished(prisma, { businessId, now: NOW })).toBe(open.length);

    // 4. SELLING THE TIME SHE GIVES BACK. The week a stylist leaves is the
    //    week her book gets cancelled, so this screen goes quiet exactly when
    //    it has the most to sell.
    const opened = await listOpenedSlots(prisma, { businessId, now: NOW });
    const span = opened.find((s) => s.appointmentId === freed.id);
    expect(span, 'the Saturday she frees is the salon’s most valuable thing').toBeDefined();
    // …and the row carries WHY it cannot be sold with her, so the offer the
    // desk makes is one the write will honour.
    expect(span!.providerActive).toBe(false);

    // 5. THE WEEK'S REPORT. Retiring never rewrites history — `room.ts` says
    //    so about a chair, and a report is where it has to be literally true.
    const summary = await dashboardSummary(prisma, { businessId, anyDayInWeek: DAY, now: NOW });
    expect(summary.utilizationByProvider.map((p) => p.providerName)).toContain('Tess');
  });

  it('IS NOT BOOKABLE, which is the only thing `active` was ever answering', async () => {
    await tessLeaves();

    // The engine refuses her outright…
    const built = await buildSlotQuery(prisma, {
      businessId,
      providerId: tessId,
      serviceIds: [cutId],
      day: DAY,
      now: NOW,
      audience: 'staff',
    });
    expect(computeSlotsIn(built).slots).toEqual([]);

    // …so the grid must not offer her time either. THIS IS THE PAIR THAT
    // MATTERS: her hours are untouched by the departure, so every free minute
    // between her remaining appointments is a bookable-looking gap carrying a
    // `/staff/book?provider=…` link, and an offer the write refuses is the
    // failure mode this repo has caught four times. Asserting the engine
    // alone, or the column alone, cannot see the disagreement between them.
    const column = await columnFor(tessId);
    expect(column!.gaps).toEqual([]);
    // Dana, on the same day and the same hours, still has hers — otherwise
    // this test passes against a grid that has stopped offering anything.
    const dana = await columnFor(danaId);
    expect(dana!.offRoster).toBe(false);
    expect(dana!.gaps.length).toBeGreaterThan(0);
  });

  it('keeps her column only while she still has work on the day', async () => {
    await tessLeaves();
    // The asymmetry `room.ts` draws for a retired chair, in the other
    // direction: she is on Tuesday's grid because Tuesday has her clients on
    // it. A Tuesday in July does not, and a roster full of everyone who ever
    // worked here is the noise that stops the screen being read.
    const july = await loadDayView(prisma, { businessId, day: '2026-07-07', now: NOW });
    expect(july.columns.map((c) => c.providerName)).toEqual(['Dana']);
  });

  it('goes back to an ordinary column when she is put back on the roster', async () => {
    await tessLeaves();
    await setProviderActive(prisma, tessId, true);

    const column = await columnFor(tessId);
    expect(column!.offRoster).toBe(false);
    expect(column!.gaps.length).toBeGreaterThan(0);
    expect((await conflictsForDay(prisma, { businessId, day: DAY })).map((c) => c.providerId)).not.toContain(tessId);
  });
});
