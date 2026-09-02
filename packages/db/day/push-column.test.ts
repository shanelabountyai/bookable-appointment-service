/**
 * A-079 — THE PUSH PLANS AGAINST THE WHOLE COLUMN, NOT ONLY THE ROWS IT MOVES.
 *
 * Saturday, quarter past twelve, the ten o'clock never came and Dana has
 * caught up: "pull everyone forward twenty." The move set is narrow twice over
 * and rightly so — pushable statuses (A-075), and `startAt >= fromAt` — but
 * the planner used to model the column as if that narrow set were all of it.
 * Everything else standing in the day was invisible: the visit still running,
 * the no-show still holding its ninety minutes (D-7), the one that started
 * before here. The preview said `canPush: true` and the transaction died at
 * COMMIT on `appointment_block_no_overlap`, in the middle of the workflow
 * whose entire purpose is that the desk is told what happened.
 *
 * The fixtures the backlog row asked for: A STATIONARY OCCUPIED ROW ON BOTH
 * SIDES OF `fromAt` — before it for a pull-forward, after it for a push.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { transitionAppointment } from '../appointments';
import { previewPush, pushColumn } from './push-column';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));
const DAY = '2026-06-09'; // Tuesday
const NOW = at('2026-06-09T08:00:00-05:00');

let businessId: string;
let danaId: string;
let cutId: string;
/** A colour, with UNEQUAL buffers — the front one is what a pull-forward runs
 *  into, and equal buffers hide whose buffer was measured. */
let colourId: string;

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

  /**
   * A ROOM, and deliberately TWO chairs (A-069's rule: an item that changes
   * occupancy needs a fixture with a room in it).
   *
   * Two rather than one, because the chair axis has been right since A-034 and
   * would MASK this defect: with a single chair the pull-forward comes back
   * `no-chair-free` and the provider axis is never reached. It was verified —
   * one chair, and the old code returned `canPush: false` for the wrong
   * reason. Two chairs is what the salon actually has, and it leaves the
   * provider's own day as the only thing that can refuse.
   */
  const chairType = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
  for (const name of ['Chair 1', 'Chair 2']) {
    await prisma.resource.create({ data: { businessId, resourceTypeId: chairType.id, name } });
  }

  const cut = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, requiredResourceTypeId: chairType.id },
  });
  cutId = cut.id;
  const colour = await prisma.service.create({
    data: {
      businessId,
      name: 'Colour',
      durationMinutes: 60,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 5,
      priceCents: 9500,
      requiredResourceTypeId: chairType.id,
    },
  });
  colourId = colour.id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  danaId = dana.id;
  for (const serviceId of [cutId, colourId]) {
    await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId: dana.id } });
  }
  await createWeeklyWindow(prisma, { businessId, providerId: dana.id, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
});

const book = (startIso: string, serviceId = cutId) =>
  bookAppointment(prisma, {
    businessId,
    providerId: danaId,
    serviceIds: [serviceId],
    clientId: null,
    startAt: at(startIso),
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
    idempotencyKey: `${serviceId}:${startIso}`,
  } as Parameters<typeof bookAppointment>[1]);

const preview = (minutes: number, fromIso: string) =>
  previewPush(prisma, { businessId, providerId: danaId, day: DAY, fromAt: at(fromIso), minutes });

const push = (minutes: number, fromIso: string) =>
  pushColumn(prisma, {
    businessId,
    providerId: danaId,
    day: DAY,
    fromAt: at(fromIso),
    minutes,
    actor: ACTOR,
    reason: 'Dana has caught up',
  });

const problemOf = (rows: { appointmentId: string; problem?: string }[], id: string) =>
  rows.find((r) => r.appointmentId === id)?.problem;

const startOf = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { startAt: true } })).startAt.toISOString();

describe('A-079 — a stationary occupied row BEFORE fromAt (the pull-forward)', () => {
  it('names the row it would land on, and refuses instead of dying at COMMIT', async () => {
    // 13:00 started before the desk's chosen point, so it is not in the move
    // set — and it is exactly what the 14:00 is about to be pulled onto.
    const one = await book('2026-06-09T13:00:00-05:00');
    const two = await book('2026-06-09T14:00:00-05:00');

    const result = await preview(-60, '2026-06-09T14:00:00-05:00');

    // Before this item the 13:00 was not in `candidates` AT ALL and this said
    // `canPush: true`; the push then raised a raw 23P01 with nothing moved.
    expect(problemOf(result.candidates, one.id)).toBe('still-in-the-chair');
    expect(problemOf(result.candidates, two.id)).toBe('blocked-by-one-that-stays');
    expect(result.canPush).toBe(false);

    const done = await push(-60, '2026-06-09T14:00:00-05:00');
    expect(done.moved).toBe(0);
    // The bystander is NOT a casualty of the push: it was never asked to move,
    // so it is not in `leftBehind` and does not stand the delta (D-43).
    expect(done.leftBehind.map((c) => c.appointmentId)).toEqual([two.id]);
    expect(await startOf(two.id)).toBe(at('2026-06-09T14:00:00-05:00').toISOString());
  });

  it('measures the bystander from its STORED blocked range, buffers included', async () => {
    // The colour's 15-minute buffer BEFORE means it occupies from 12:45, not
    // 13:00. Re-deriving the range as `startAt`..`endAt + bufferAfter` — the
    // second copy A-069 warned about — would miss the front and let a -75 land
    // inside the buffer the database refuses.
    const colour = await book('2026-06-09T13:00:00-05:00', colourId);
    const later = await book('2026-06-09T15:00:00-05:00');

    // -60 puts the 15:00 at 14:00, clear of the colour's BODY (which ends at
    // 14:00) and NOT of its blocked range, which runs to 14:05. That five
    // minutes is the whole test: it exists only in the stored range.
    const tight = await preview(-60, '2026-06-09T15:00:00-05:00');
    expect(problemOf(tight.candidates, colour.id)).toBe('still-in-the-chair');
    expect(problemOf(tight.candidates, later.id)).toBe('blocked-by-one-that-stays');

    // -55 starts at 14:05 exactly. Half-open: touching is not overlapping.
    const clear = await preview(-55, '2026-06-09T15:00:00-05:00');
    expect(problemOf(clear.candidates, later.id)).toBeUndefined();
    expect((await push(-55, '2026-06-09T15:00:00-05:00')).moved).toBe(1);
    expect(await startOf(later.id)).toBe(at('2026-06-09T14:05:00-05:00').toISOString());
  });
});

describe('A-079 — a stationary occupied row AFTER fromAt (the push)', () => {
  it('sees a terminal row standing mid-column and still moves what it can', async () => {
    const first = await book('2026-06-09T14:00:00-05:00');
    const missed = await book('2026-06-09T15:00:00-05:00');
    const last = await book('2026-06-09T16:00:00-05:00');

    // She did not come, and D-7 says the slot stays hers: `no_show` still
    // occupies 15:00–16:00, and it is not pushable (A-075).
    await transitionAppointment(prisma, {
      appointmentId: missed.id,
      to: 'no_show',
      now: at('2026-06-09T15:30:00-05:00'),
      actor: ACTOR,
    });

    const result = await preview(30, '2026-06-09T14:00:00-05:00');
    expect(problemOf(result.candidates, missed.id)).toBe('still-in-the-chair');
    expect(problemOf(result.candidates, first.id)).toBe('blocked-by-one-that-stays');
    expect(problemOf(result.candidates, last.id)).toBeUndefined();
    expect(result.canPush).toBe(true);

    // D-26's partial push, which used to be `AFTER: nothing moved` and a 500.
    const done = await push(30, '2026-06-09T14:00:00-05:00');
    expect(done.moved).toBe(1);
    expect(done.leftBehind.map((c) => c.problem)).toEqual(['blocked-by-one-that-stays']);
    expect(await startOf(last.id)).toBe(at('2026-06-09T16:30:00-05:00').toISOString());
    expect(await startOf(first.id)).toBe(at('2026-06-09T14:00:00-05:00').toISOString());
    expect(await startOf(missed.id)).toBe(at('2026-06-09T15:00:00-05:00').toISOString());
  });

  it('leaves the ordinary push alone — nothing standing, everything moves', async () => {
    const first = await book('2026-06-09T14:00:00-05:00');
    const second = await book('2026-06-09T15:00:00-05:00');

    const result = await preview(30, '2026-06-09T14:00:00-05:00');
    expect(result.candidates.map((c) => c.problem)).toEqual([undefined, undefined]);

    const done = await push(30, '2026-06-09T14:00:00-05:00');
    expect(done.moved).toBe(2);
    expect(done.leftBehind).toEqual([]);
    expect(await startOf(first.id)).toBe(at('2026-06-09T14:30:00-05:00').toISOString());
    expect(await startOf(second.id)).toBe(at('2026-06-09T15:30:00-05:00').toISOString());
  });
});
