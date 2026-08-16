/**
 * A-007 — availability against the real database (AVAIL-01..04).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidAvailability } from '../../core/availability';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import {
  type ActorStamp,
  createAdHocBlock,
  createTimeOff,
  createWeeklyWindow,
  findAbsences,
  listWeeklyWindows,
  resolveDayWindows,
  upsertDateOverride,
} from './availability';

const prisma = new PrismaClient();
let businessId: string;
let providerId: string;
let otherProviderId: string;

const STAFF: ActorStamp = { createdByActor: 'staff', actorRef: 'staff-1' };
/** 2026-06-09 is a Tuesday (weekday 2). */
const TUESDAY = { day: '2026-06-09', weekday: 2 };

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const b = await prisma.business.create({ data: { name: 'Shear Genius', timezone: 'America/Chicago' } });
  businessId = b.id;
  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  const priya = await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } });
  providerId = dana.id;
  otherProviderId = priya.id;
});

const businessHours = (open = '09:00', close = '18:00') =>
  createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open, close, endsNextDay: false }, STAFF);

const providerHours = (open = '09:00', close = '17:00', breaks?: { open: string; close: string }[]) =>
  createWeeklyWindow(
    prisma,
    { businessId, providerId, weekday: 2, open, close, endsNextDay: false, ...(breaks ? { breaks } : {}) },
    STAFF,
  );

const resolve = () => resolveDayWindows(prisma, { businessId, providerId, ...TUESDAY });

describe('AVAIL-01 — weekly windows', () => {
  it('stores a window with its breaks and reads it back', async () => {
    await providerHours('09:00', '17:00', [{ open: '12:00', close: '13:00' }]);
    const [row] = await listWeeklyWindows(prisma, businessId, providerId);
    expect(row!.open.trim()).toBe('09:00');
    expect(row!.breaks).toHaveLength(1);
  });

  it('REFUSES close <= open without endsNextDay, writing nothing', async () => {
    await expect(
      createWeeklyWindow(
        prisma,
        { businessId, providerId, weekday: 2, open: '17:00', close: '09:00', endsNextDay: false },
        STAFF,
      ),
    ).rejects.toThrow(InvalidAvailability);
    expect(await prisma.weeklyWindow.count()).toBe(0);
  });

  it('refuses a break outside its window, writing nothing', async () => {
    await expect(
      createWeeklyWindow(
        prisma,
        {
          businessId,
          providerId,
          weekday: 2,
          open: '09:00',
          close: '17:00',
          endsNextDay: false,
          breaks: [{ open: '18:00', close: '19:00' }],
        },
        STAFF,
      ),
    ).rejects.toThrow(InvalidAvailability);
    expect(await prisma.weeklyWindow.count()).toBe(0);
    expect(await prisma.windowBreak.count()).toBe(0);
  });

  it('refuses an out-of-range weekday', async () => {
    await expect(
      createWeeklyWindow(
        prisma,
        { businessId, providerId, weekday: 7, open: '09:00', close: '17:00', endsNextDay: false },
        STAFF,
      ),
    ).rejects.toThrow(InvalidAvailability);
  });

  // Operator R-8: "who blocked Dana's 2-4 and why?" had no answer.
  it('stamps the actor on every write', async () => {
    await providerHours();
    const [row] = await listWeeklyWindows(prisma, businessId, providerId);
    expect(row!.createdByActor).toBe('staff');
    expect(row!.actorRef).toBe('staff-1');
  });
});

describe('AVAIL-04 — business ∩ provider', () => {
  it('clips the provider to business hours', async () => {
    await businessHours('10:00', '16:00');
    await providerHours('09:00', '18:00');
    const { windows, closed } = await resolve();
    expect(closed).toBe(false);
    expect(windows).toEqual([{ open: '10:00', close: '16:00', endsNextDay: false, breaks: [] }]);
  });

  it('is closed when the business has no hours that weekday', async () => {
    await providerHours(); // provider works, salon does not open
    expect((await resolve()).closed).toBe(true);
  });

  it('is closed when the provider has no hours that weekday', async () => {
    await businessHours();
    expect((await resolve()).closed).toBe(true);
  });

  // AVAIL-04's explicit acceptance criterion.
  it('A BUSINESS HOLIDAY CLOSES EVERY PROVIDER', async () => {
    await businessHours();
    await providerHours();
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: otherProviderId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
      STAFF,
    );
    await upsertDateOverride(
      prisma,
      { businessId, providerId: null, day: TUESDAY.day, isClosed: true, reason: 'Independence Day' },
      STAFF,
    );

    expect((await resolve()).closed).toBe(true);
    const other = await resolveDayWindows(prisma, { businessId, providerId: otherProviderId, ...TUESDAY });
    expect(other.closed).toBe(true);
  });

  it('carries breaks from both sides into the intersection', async () => {
    await createWeeklyWindow(
      prisma,
      {
        businessId,
        providerId: null,
        weekday: 2,
        open: '09:00',
        close: '18:00',
        endsNextDay: false,
        breaks: [{ open: '13:00', close: '14:00' }],
      },
      STAFF,
    );
    await providerHours('09:00', '17:00', [{ open: '12:00', close: '12:30' }]);
    const { windows } = await resolve();
    expect(windows[0]!.breaks).toEqual([
      { open: '12:00', close: '12:30' },
      { open: '13:00', close: '14:00' },
    ]);
  });
});

describe('AVAIL-02 — date overrides', () => {
  beforeEach(async () => {
    await businessHours('09:00', '20:00');
    await providerHours('09:00', '17:00');
  });

  it('REPLACES the weekly pattern, never merges with it', async () => {
    await upsertDateOverride(
      prisma,
      {
        businessId,
        providerId,
        day: TUESDAY.day,
        isClosed: false,
        windows: [{ open: '10:00', close: '14:00', endsNextDay: false }],
      },
      STAFF,
    );
    const { windows } = await resolve();
    expect(windows).toEqual([{ open: '10:00', close: '14:00', endsNextDay: false, breaks: [] }]);
  });

  it('closes only the day it names, leaving other days alone', async () => {
    await upsertDateOverride(prisma, { businessId, providerId, day: TUESDAY.day, isClosed: true }, STAFF);
    expect((await resolve()).closed).toBe(true);
    // The following Tuesday still uses the weekly pattern.
    const nextWeek = await resolveDayWindows(prisma, { businessId, providerId, day: '2026-06-16', weekday: 2 });
    expect(nextWeek.closed).toBe(false);
  });

  it('upserts rather than creating a second override for the same day', async () => {
    await upsertDateOverride(prisma, { businessId, providerId, day: TUESDAY.day, isClosed: true }, STAFF);
    await upsertDateOverride(
      prisma,
      {
        businessId,
        providerId,
        day: TUESDAY.day,
        isClosed: false,
        windows: [{ open: '11:00', close: '15:00', endsNextDay: false }],
      },
      STAFF,
    );
    expect(await prisma.dateOverride.count({ where: { providerId } })).toBe(1);
    expect((await resolve()).windows[0]!.open).toBe('11:00');
    // The replaced child windows are gone, not accumulated.
    expect(await prisma.dateOverrideWindow.count()).toBe(1);
  });

  it('refuses a closed override that also carries hours', async () => {
    await expect(
      upsertDateOverride(
        prisma,
        {
          businessId,
          providerId,
          day: TUESDAY.day,
          isClosed: true,
          windows: [{ open: '10:00', close: '14:00', endsNextDay: false }],
        },
        STAFF,
      ),
    ).rejects.toThrow(InvalidAvailability);
  });

  it('refuses an open override with no hours — that is what isClosed is for', async () => {
    await expect(
      upsertDateOverride(prisma, { businessId, providerId, day: TUESDAY.day, isClosed: false, windows: [] }, STAFF),
    ).rejects.toThrow(InvalidAvailability);
  });
});

describe('AVAIL-03 — time off and ad-hoc blocks', () => {
  const start = toDate(instantFromIso('2026-06-09T14:00:00Z'));
  const end = toDate(instantFromIso('2026-06-09T16:00:00Z'));

  it('records time off with its actor and reason', async () => {
    await createTimeOff(prisma, { businessId, providerId, startAt: start, endAt: end, reason: 'Dentist' }, STAFF);
    const found = await findAbsences(prisma, {
      providerId,
      windowStart: toDate(instantFromIso('2026-06-09T00:00:00Z')),
      windowEnd: toDate(instantFromIso('2026-06-10T00:00:00Z')),
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'time_off', reason: 'Dentist' });
    const row = await prisma.timeOff.findFirstOrThrow();
    expect(row.createdByActor).toBe('staff');
    expect(row.actorRef).toBe('staff-1');
  });

  it('distinguishes an ad-hoc block from time off', async () => {
    await createAdHocBlock(prisma, { businessId, providerId, startAt: start, endAt: end, reason: 'Stock take' }, STAFF);
    const [found] = await findAbsences(prisma, {
      providerId,
      windowStart: toDate(instantFromIso('2026-06-09T00:00:00Z')),
      windowEnd: toDate(instantFromIso('2026-06-10T00:00:00Z')),
    });
    // The engine reports these with DIFFERENT exclusion reasons — conflating
    // them tells the front desk a stylist is away when she is standing there.
    expect(found!.kind).toBe('ad_hoc_block');
  });

  it('refuses an interval that ends before it starts', async () => {
    await expect(
      createTimeOff(prisma, { businessId, providerId, startAt: end, endAt: start }, STAFF),
    ).rejects.toThrow(InvalidAvailability);
  });

  // An INSTANT-overlap predicate, never a date filter: a block running
  // 23:30-00:30 belongs to both days.
  it('finds an absence that straddles midnight from either side', async () => {
    await createTimeOff(
      prisma,
      {
        businessId,
        providerId,
        startAt: toDate(instantFromIso('2026-06-09T23:30:00Z')),
        endAt: toDate(instantFromIso('2026-06-10T00:30:00Z')),
      },
      STAFF,
    );
    const dayBefore = await findAbsences(prisma, {
      providerId,
      windowStart: toDate(instantFromIso('2026-06-09T00:00:00Z')),
      windowEnd: toDate(instantFromIso('2026-06-10T00:00:00Z')),
    });
    const dayAfter = await findAbsences(prisma, {
      providerId,
      windowStart: toDate(instantFromIso('2026-06-10T00:00:00Z')),
      windowEnd: toDate(instantFromIso('2026-06-11T00:00:00Z')),
    });
    expect(dayBefore).toHaveLength(1);
    expect(dayAfter).toHaveLength(1);
  });

  it('excludes an absence that merely touches the window edge (half-open)', async () => {
    await createTimeOff(
      prisma,
      {
        businessId,
        providerId,
        startAt: toDate(instantFromIso('2026-06-10T00:00:00Z')),
        endAt: toDate(instantFromIso('2026-06-10T01:00:00Z')),
      },
      STAFF,
    );
    const dayBefore = await findAbsences(prisma, {
      providerId,
      windowStart: toDate(instantFromIso('2026-06-09T00:00:00Z')),
      windowEnd: toDate(instantFromIso('2026-06-10T00:00:00Z')),
    });
    expect(dayBefore).toEqual([]);
  });

  it('scopes absences to their own provider', async () => {
    await createTimeOff(prisma, { businessId, providerId, startAt: start, endAt: end }, STAFF);
    const other = await findAbsences(prisma, {
      providerId: otherProviderId,
      windowStart: toDate(instantFromIso('2026-06-09T00:00:00Z')),
      windowEnd: toDate(instantFromIso('2026-06-10T00:00:00Z')),
    });
    expect(other).toEqual([]);
  });

  /**
   * D-2, deliberately: time off lives OUTSIDE the exclusion constraint's
   * table so that blocking over an existing booking SURFACES the conflict for
   * a human (AVAIL-05 / A-019) rather than being refused by the database.
   * "Dana called in sick" must always succeed, even with nine appointments on
   * the book — what happens to those nine is a person's decision.
   */
  it('ACCEPTS time off that covers an existing appointment — refusing it is not the design', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Appointment"
         (id,"businessId","providerId",status,"startAt","endAt","blockedStart","blockedEnd","startDay","startWallTime","updatedAt")
       VALUES ('appt1',$1,$2,'booked','2026-06-09T14:30:00Z','2026-06-09T15:30:00Z','epoch','epoch','2026-06-09','09:30', now())`,
      businessId,
      providerId,
    );
    await expect(
      createTimeOff(prisma, { businessId, providerId, startAt: start, endAt: end, reason: 'Sick' }, STAFF),
    ).resolves.toBeDefined();
    // And the appointment is untouched — nothing is ever silently cancelled.
    expect(await prisma.appointment.count({ where: { status: 'booked' } })).toBe(1);
  });
});
