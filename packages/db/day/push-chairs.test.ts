/**
 * A-034 — THE CHAIR FOLLOWS THE MOVE (RES-03, D-26, D-30).
 *
 * The first test in this file is the one the backlog row asked for before any
 * code was written: proof that the collision is REACHABLE. Two back-to-back
 * clients in the same chair, pushed together, put the first one on top of the
 * second's chair hold mid-transaction — and until this item, the resource
 * constraint was immediate (only `appointment_block_no_overlap` was deferred),
 * so the desk got a raw `23P01` in the middle of a push the preview had just
 * promised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { previewPush, pushColumn } from './push-column';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));
const DAY = '2026-06-09'; // Tuesday
const NOW = at('2026-06-09T08:00:00-05:00');

let businessId: string;
let danaId: string;
let priyaId: string;
let marcusId: string;
let cutId: string;
let chairs: Record<string, string> = {};

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

  const chairType = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
  chairs = {};
  // TWO chairs, so the room binds inside a test rather than needing four
  // stylists to demonstrate the same thing.
  for (const name of ['Chair 1', 'Chair 2']) {
    const chair = await prisma.resource.create({ data: { businessId, resourceTypeId: chairType.id, name } });
    chairs[name] = chair.id;
  }

  const cut = await prisma.service.create({
    data: {
      businessId,
      name: 'Cut',
      durationMinutes: 60,
      priceCents: 5500,
      requiredResourceTypeId: chairType.id,
    },
  });
  cutId = cut.id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
  for (const displayName of ['Dana', 'Priya', 'Marcus']) {
    const provider = await prisma.provider.create({ data: { businessId, displayName } });
    await prisma.serviceProvider.create({ data: { businessId, serviceId: cutId, providerId: provider.id } });
    await createWeeklyWindow(prisma, { businessId, providerId: provider.id, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
    if (displayName === 'Dana') danaId = provider.id;
    if (displayName === 'Priya') priyaId = provider.id;
    if (displayName === 'Marcus') marcusId = provider.id;
  }
});

const book = (providerId: string, startIso: string) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [cutId],
    clientId: null,
    startAt: at(startIso),
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
    idempotencyKey: `${providerId}:${startIso}`,
  } as Parameters<typeof bookAppointment>[1]);

const push = (minutes: number, fromIso = '2026-06-09T14:00:00-05:00') =>
  pushColumn(prisma, {
    businessId,
    providerId: danaId,
    day: DAY,
    fromAt: at(fromIso),
    minutes,
    actor: ACTOR,
    reason: 'Dana is an hour behind',
  });

const chairOf = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { resourceId: true } })).resourceId;

describe('A-034 — the collision is reachable', () => {
  /**
   * THE FIXTURE THE BACKLOG ROW ASKED FOR FIRST. Nothing exotic: one stylist,
   * two consecutive clients, the ordinary "we are running half an hour late".
   * Both hold Chair 1 — legitimately, since half-open ranges let the 15:00
   * take the chair the 14:00 vacates — and pushing the pair moves the first
   * onto the second's hold.
   */
  it('two back-to-back clients in one chair survive a push', async () => {
    const first = await book(danaId, '2026-06-09T14:00:00-05:00');
    const second = await book(danaId, '2026-06-09T15:00:00-05:00');
    expect(await chairOf(first.id)).toBe(chairs['Chair 1']);
    expect(await chairOf(second.id)).toBe(chairs['Chair 1']);

    const result = await push(30);

    expect(result.moved).toBe(2);
    expect(result.leftBehind).toEqual([]);
    // Both keep Chair 1: a uniform shift moves the whole seating with it, and
    // a push that reshuffled the room for no reason would have the desk
    // walking clients to different chairs to no purpose.
    expect(await chairOf(first.id)).toBe(chairs['Chair 1']);
    expect(await chairOf(second.id)).toBe(chairs['Chair 1']);
  });
});

describe('A-034 — the chair follows the push', () => {
  it('moves a client to a free chair when somebody who is NOT moving holds hers', async () => {
    const priyas = await book(priyaId, '2026-06-09T15:00:00-05:00');
    const danas = await book(danaId, '2026-06-09T14:00:00-05:00');
    expect(await chairOf(priyas.id)).toBe(chairs['Chair 1']);
    expect(await chairOf(danas.id)).toBe(chairs['Chair 1']);

    const result = await push(60);

    expect(result.moved).toBe(1);
    expect(await chairOf(danas.id)).toBe(chairs['Chair 2']);
    expect(await chairOf(priyas.id)).toBe(chairs['Chair 1']);
  });

  it('says which chair in the PREVIEW, because the preview is what promised it', async () => {
    await book(priyaId, '2026-06-09T15:00:00-05:00');
    const danas = await book(danaId, '2026-06-09T14:00:00-05:00');

    const preview = await previewPush(prisma, {
      businessId,
      providerId: danaId,
      day: DAY,
      fromAt: at('2026-06-09T14:00:00-05:00'),
      minutes: 60,
    });

    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]!.appointmentId).toBe(danas.id);
    expect(preview.candidates[0]!.toResourceId).toBe(chairs['Chair 2']);
  });

  /**
   * D-26: a client with nowhere to sit STAYS, named, and the rest still go.
   * She must never come back as an exception — the preview promised this push
   * and the desk needs to know which client to deal with by hand.
   */
  it('leaves behind the client the room cannot seat, and says so', async () => {
    await book(priyaId, '2026-06-09T15:00:00-05:00');
    await book(marcusId, '2026-06-09T15:00:00-05:00');
    const danas = await book(danaId, '2026-06-09T14:00:00-05:00');
    const later = await book(danaId, '2026-06-09T16:00:00-05:00');

    const result = await push(60);

    expect(result.leftBehind).toEqual([
      expect.objectContaining({ appointmentId: danas.id, problem: 'no-chair-free' }),
    ]);
    // The one behind her still moves — a full room at 15:00 says nothing about
    // 17:00, and a push that gave up entirely would be the all-or-nothing D-26
    // rejected.
    expect(result.moved).toBe(1);
    const moved = await prisma.appointment.findUniqueOrThrow({ where: { id: later.id } });
    expect(moved.startWallTime).toBe('17:00');
    const stayed = await prisma.appointment.findUniqueOrThrow({ where: { id: danas.id } });
    expect(stayed.startWallTime).toBe('14:00');
  });

  /**
   * THE TWO AXES FEED EACH OTHER, which is why the chairs are planned in a
   * loop with the cascade rather than after it. Pulling the column an hour
   * EARLIER: the 14:00 has no chair at 13:00, so she stays — and the 15:00,
   * which would have moved onto 14:00, is now blocked by a client who is only
   * staying because of the chair axis.
   */
  it('cascades a chair failure back onto the provider axis', async () => {
    await book(priyaId, '2026-06-09T13:00:00-05:00');
    await book(marcusId, '2026-06-09T13:00:00-05:00');
    const first = await book(danaId, '2026-06-09T14:00:00-05:00');
    const second = await book(danaId, '2026-06-09T15:00:00-05:00');

    const result = await push(-60);

    expect(result.moved).toBe(0);
    expect(result.leftBehind).toEqual([
      expect.objectContaining({ appointmentId: first.id, problem: 'no-chair-free' }),
      expect.objectContaining({ appointmentId: second.id, problem: 'blocked-by-one-that-stays' }),
    ]);
  });
});
