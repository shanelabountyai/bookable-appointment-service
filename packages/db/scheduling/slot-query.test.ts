/**
 * A-026 — the availability → SlotQuery adapter, against the real database.
 *
 * The two assertions that matter most are the ones the Milestone 1 operator
 * review predicted would be missed: an override must still occupy its time in
 * the busy set (D-16), and the query must be an instant-overlap predicate
 * rather than a date filter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow, createTimeOff, upsertDateOverride, createAdHocBlock } from '../availability';
import { findBusyAppointments } from './busy-set';
import { SlotQueryUnavailable, buildSlotQuery, computeDaySlots, daysWithAvailability } from './slot-query';

const prisma = new PrismaClient();
const STAFF = { createdByActor: 'staff' as const, actorRef: 'staff-1' };

let businessId: string;
let providerId: string;
let serviceId: string;

/** Tuesday 2026-06-09, America/Chicago (CDT, -05:00 all day). */
const DAY = '2026-06-09';
const NOW = toDate(instantFromIso('2026-06-09T00:00:00-05:00'));
const at = (iso: string) => toDate(instantFromIso(iso));

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
      bookingHorizonDays: 90,
    },
  });
  businessId = business.id;

  const provider = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = provider.id;

  const service = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 },
  });
  serviceId = service.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId } });

  // Business 09:00–18:00, provider 09:00–17:00, both Tuesdays.
  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
    STAFF,
  );
  await createWeeklyWindow(
    prisma,
    { businessId, providerId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
    STAFF,
  );
});

/** Inserts an appointment directly — A-009's write path does not exist yet.
 *  blockedStart/blockedEnd are trigger-written (A-003). */
async function insertAppointment(opts: {
  id: string;
  start: string;
  end: string;
  status?: string;
  isOverride?: boolean;
  bufferAfter?: number;
}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Appointment"
       (id,"businessId","providerId",status,"startAt","endAt","bufferBeforeMinutes","bufferAfterMinutes",
        "isOverride","blockedStart","blockedEnd","startDay","startWallTime","updatedAt")
     VALUES ($1,$2,$3,$4::"AppointmentStatus",$5::timestamptz,$6::timestamptz,0,$7,$8,'epoch','epoch',$9,'00:00', now())`,
    opts.id,
    businessId,
    providerId,
    opts.status ?? 'booked',
    opts.start,
    opts.end,
    opts.bufferAfter ?? 0,
    opts.isOverride ?? false,
    DAY,
  );
}

const build = (over: Partial<Parameters<typeof buildSlotQuery>[1]> = {}) =>
  buildSlotQuery(prisma, { businessId, providerId, serviceId, day: DAY, now: NOW, ...over });

const slotsAt = async (over = {}) => (await computeDaySlots(prisma, { businessId, providerId, serviceId, day: DAY, now: NOW, ...over })).slots;

describe('window resolution (A-007 chain → SlotQuery)', () => {
  it('intersects business and provider hours', async () => {
    const { query } = await build();
    expect(query.windows).toEqual([{ open: '09:00', close: '17:00', endsNextDay: false, breaks: [] }]);
    expect(query.businessZone).toBe('America/Chicago');
    expect(query.grid).toEqual({ intervalMinutes: 15, anchor: 'window-open' });
  });

  it('is empty on a business holiday, so no slots are offered at all', async () => {
    await upsertDateOverride(prisma, { businessId, providerId: null, day: DAY, isClosed: true }, STAFF);
    const { query } = await build();
    expect(query.windows).toEqual([]);
    expect(await slotsAt()).toEqual([]);
  });

  it('uses the provider duration override when one exists (SVC-02)', async () => {
    await prisma.serviceProvider.updateMany({ where: { serviceId, providerId }, data: { durationOverrideMinutes: 90 } });
    const { query } = await build();
    expect(query.service.durationMinutes).toBe(90);
  });

  it('refuses a provider who is not qualified for the service (SVC-02)', async () => {
    const other = await prisma.provider.create({ data: { businessId, displayName: 'Priya' } });
    await expect(build({ providerId: other.id })).rejects.toThrow(SlotQueryUnavailable);
  });

  it('offers nothing for a deactivated provider or service', async () => {
    await prisma.provider.update({ where: { id: providerId }, data: { active: false } });
    expect((await build()).query.windows).toEqual([]);
  });
});

describe('the busy set — D-16, the override hole', () => {
  it('subtracts an ordinary booking', async () => {
    await insertAppointment({ id: 'a', start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00' });
    const starts = (await slotsAt()).map((s) => s.label.time);
    expect(starts).not.toContain('10:00');
    expect(starts).toContain('11:00');
  });

  /**
   * THE ONE THIS ITEM EXISTS FOR.
   *
   * A staff override stores a ZERO-WIDTH blocked range so the exclusion
   * constraint stays absolute without refusing the override (D-8). Reading
   * blockedStart/blockedEnd alone would return an interval that blocks
   * nothing, and the public flow would offer the exact slot staff knowingly
   * double-booked — letting a customer create the accidental conflict Goal 2
   * promises is impossible.
   */
  it('an OVERRIDE still occupies its time, via overriddenFromRange', async () => {
    await insertAppointment({
      id: 'override',
      start: '2026-06-09T14:00:00-05:00',
      end: '2026-06-09T15:00:00-05:00',
      isOverride: true,
    });

    // The row's own blocked range really is empty — this is not a test that
    // passes because the fixture was written wrong.
    const raw = await prisma.$queryRawUnsafe<{ empty: boolean; hasRange: boolean }[]>(
      `SELECT isempty(tstzrange("blockedStart","blockedEnd",'[)')) AS "empty",
              ("overriddenFromRange" IS NOT NULL) AS "hasRange"
         FROM "Appointment" WHERE id='override'`,
    );
    expect(raw[0]).toEqual({ empty: true, hasRange: true });

    const busy = await findBusyAppointments(prisma, {
      providerId,
      windowStart: at('2026-06-09T00:00:00-05:00'),
      windowEnd: at('2026-06-10T00:00:00-05:00'),
    });
    expect(busy).toHaveLength(1);
    expect(busy[0]!.end.getTime() - busy[0]!.start.getTime()).toBe(60 * 60 * 1000);

    const starts = (await slotsAt()).map((s) => s.label.time);
    expect(starts).not.toContain('14:00');
    expect(starts).toContain('15:00');
  });

  it('frees the slot for cancelled and cancelled_late, and holds it for no_show and completed', async () => {
    for (const status of ['cancelled', 'cancelled_late'] as const) {
      await prisma.$executeRawUnsafe(`DELETE FROM "Appointment"`);
      await insertAppointment({ id: `x-${status}`, start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00', status });
      expect((await slotsAt()).map((s) => s.label.time)).toContain('10:00');
    }
    for (const status of ['no_show', 'completed'] as const) {
      await prisma.$executeRawUnsafe(`DELETE FROM "Appointment"`);
      await insertAppointment({ id: `y-${status}`, start: '2026-06-09T10:00:00-05:00', end: '2026-06-09T11:00:00-05:00', status });
      expect((await slotsAt()).map((s) => s.label.time)).not.toContain('10:00');
    }
  });

  /**
   * The other way this query is silently wrong: `WHERE date(startAt) = day`
   * drops a booking that starts at 23:30 the night before and runs past
   * midnight, and the engine then offers 00:00 to the next customer.
   */
  it('finds a booking that STARTED the previous evening and runs past midnight', async () => {
    // Provider works overnight so 00:00 is genuinely offerable.
    await prisma.weeklyWindow.deleteMany({ where: { providerId } });
    await prisma.weeklyWindow.deleteMany({ where: { providerId: null } });
    await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '00:00', close: '23:45', endsNextDay: false }, STAFF);
    await createWeeklyWindow(prisma, { businessId, providerId, weekday: 2, open: '00:00', close: '23:45', endsNextDay: false }, STAFF);

    await insertAppointment({ id: 'overnight', start: '2026-06-08T23:30:00-05:00', end: '2026-06-09T00:30:00-05:00' });

    const busy = await findBusyAppointments(prisma, {
      providerId,
      windowStart: at('2026-06-09T00:00:00-05:00'),
      windowEnd: at('2026-06-10T00:00:00-05:00'),
    });
    expect(busy).toHaveLength(1);

    const starts = (await slotsAt()).map((s) => s.label.time);
    expect(starts).not.toContain('00:00');
  });

  it('includes time off and ad-hoc blocks, each keeping its own kind', async () => {
    await createTimeOff(
      prisma,
      { businessId, providerId, startAt: at('2026-06-09T10:00:00-05:00'), endAt: at('2026-06-09T11:00:00-05:00') },
      STAFF,
    );
    await createAdHocBlock(
      prisma,
      { businessId, providerId, startAt: at('2026-06-09T13:00:00-05:00'), endAt: at('2026-06-09T14:00:00-05:00') },
      STAFF,
    );
    const { query } = await build();
    expect(query.busy.map((b) => b.kind).sort()).toEqual(['ad_hoc_block', 'time_off']);

    // The engine reports them with DIFFERENT reasons — conflating them tells
    // the front desk a stylist is away when she is standing right there.
    const result = await computeDaySlots(prisma, {
      businessId, providerId, serviceId, day: DAY, now: NOW, audience: 'staff',
    });
    const reasonAt = (time: string) =>
      result.excluded.find((e) => e.label.time === time)?.reasons ?? [];
    expect(reasonAt('10:00')).toContain('overlaps-time-off');
    expect(reasonAt('13:00')).toContain('overlaps-block');
  });

  it('catches a booking that only collides through the service buffer', async () => {
    // Booking 11:15-12:15 with its own 15-minute trailing buffer, so it is
    // blocked to 12:30 — outside the body of any 11:00 candidate, inside its
    // blocked range once the service adds a buffer.
    await prisma.service.update({ where: { id: serviceId }, data: { bufferAfterMinutes: 20 } });
    await insertAppointment({
      id: 'buffered',
      start: '2026-06-09T11:15:00-05:00',
      end: '2026-06-09T12:15:00-05:00',
      bufferAfter: 15,
    });
    const starts = (await slotsAt()).map((s) => s.label.time);
    expect(starts).not.toContain('10:15');
  });
});

describe('D-21 — the booking horizon caps SELF-SERVE only', () => {
  const farDay = '2026-12-01'; // well past 90 days from 2026-06-09

  it('offers nothing to the public beyond the horizon', async () => {
    await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAFF);
    const { beyondHorizon, query } = await build({ day: farDay, audience: 'public' });
    expect(beyondHorizon).toBe(true);
    expect(query.windows).toEqual([]);
  });

  it('does NOT cap staff — the front desk pre-books a wedding a year out', async () => {
    await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAFF);
    await createWeeklyWindow(prisma, { businessId, providerId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAFF);
    const { beyondHorizon, query } = await build({ day: farDay, audience: 'staff' });
    expect(beyondHorizon).toBe(false);
    expect(query.windows.length).toBeGreaterThan(0);
  });
});

describe('explain is never exposed to the public (spec §1.3)', () => {
  it('omits explain for the public audience, and defaults to public', async () => {
    expect((await build({ audience: 'public' })).query.explain).toBeUndefined();
    // A route that FORGETS to pass an audience must get the safe treatment.
    expect((await build()).query.explain).toBeUndefined();
    expect((await computeDaySlots(prisma, { businessId, providerId, serviceId, day: DAY, now: NOW })).excluded).toEqual([]);
  });

  it('enables explain for staff', async () => {
    expect((await build({ audience: 'staff' })).query.explain).toBe(true);
  });
});

describe('SLOT-07 — daysWithAvailability', () => {
  it('returns only the days that genuinely have a slot', async () => {
    // Provider works Tuesdays only, so within one week exactly one day has slots.
    const days = await daysWithAvailability(prisma, {
      businessId,
      providerId,
      serviceId,
      now: NOW,
      fromDay: '2026-06-08',
      toDay: '2026-06-14',
    });
    expect(days).toEqual(['2026-06-09']);
  });

  it('drops a day whose only window is fully booked', async () => {
    await insertAppointment({ id: 'allday', start: '2026-06-09T09:00:00-05:00', end: '2026-06-09T17:00:00-05:00' });
    const days = await daysWithAvailability(prisma, {
      businessId, providerId, serviceId, now: NOW, fromDay: '2026-06-08', toDay: '2026-06-14',
    });
    expect(days).toEqual([]);
  });

  it('walks days on the CALENDAR axis across a DST transition', async () => {
    // 2026-11-01 is the fall-back Sunday; make Sundays workable.
    await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 0, open: '09:00', close: '18:00', endsNextDay: false }, STAFF);
    await createWeeklyWindow(prisma, { businessId, providerId, weekday: 0, open: '09:00', close: '17:00', endsNextDay: false }, STAFF);
    const days = await daysWithAvailability(prisma, {
      businessId,
      providerId,
      serviceId,
      now: toDate(instantFromIso('2026-10-25T00:00:00-05:00')),
      fromDay: '2026-10-31',
      toDay: '2026-11-02',
    });
    expect(days).toEqual(['2026-11-01']);
  });

  it('returns nothing for an inverted range rather than spinning', async () => {
    const days = await daysWithAvailability(prisma, {
      businessId, providerId, serviceId, now: NOW, fromDay: '2026-06-14', toDay: '2026-06-08',
    });
    expect(days).toEqual([]);
  });
});
