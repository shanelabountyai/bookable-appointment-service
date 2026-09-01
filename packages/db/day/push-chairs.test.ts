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

/**
 * CHECKPOINT 5, FINDING 2 — the seam between this planner and A-063.
 *
 * A-063 taught the DATABASE that one client's two appointments may share a
 * chair through the buffers between them, and split the one chair invariant
 * into two: envelopes may overlap for the same holder, bodies never overlap
 * for anyone. It left this planner behind, recorded as "strictly stricter than
 * the database, a seating cosmetic — nothing refuses".
 *
 * It refuses. A planner that counts one woman as needing two chairs reports
 * `no-chair-free` on a full Saturday and leaves her behind — for a chair she
 * is sitting in — which is exactly when a running-late column most needs to
 * move. Stricter than the constraint does not fail safe here.
 *
 * Strangers are not re-tested: the constraint itself refuses them and A-063's
 * own database tests pin that. What these pin is the planner agreeing with the
 * constraint in BOTH directions — sharing where it is allowed, and refusing on
 * the body axis where the relaxation does not reach.
 */
describe('checkpoint 5 — the push and the shared chair', () => {
  /** Nadia's cut and colour: overlapping buffers, a clear gap between bodies.
   *  Buffers are deliberately UNEQUAL (30 after the cut, 15 before the colour)
   *  — equal ones hide whose-buffer bugs. */
  const nadiasTwoVisits = async () => {
    const chairType = await prisma.resourceType.findFirstOrThrow({ where: { businessId } });
    const colour = await prisma.service.create({
      data: {
        businessId,
        name: 'Colour',
        durationMinutes: 60,
        priceCents: 12000,
        bufferBeforeMinutes: 15,
        requiredResourceTypeId: chairType.id,
      },
    });
    await prisma.serviceProvider.create({ data: { businessId, serviceId: colour.id, providerId: priyaId } });
    await prisma.service.update({ where: { id: cutId }, data: { bufferAfterMinutes: 30 } });
    const nadia = await prisma.client.create({ data: { businessId, name: 'Nadia Okafor' } });

    // Cut    14:00-15:00, envelope 14:00-15:30.
    const cut = await bookAppointment(prisma, {
      businessId, providerId: danaId, serviceIds: [cutId], clientId: nadia.id,
      startAt: at('2026-06-09T14:00:00-05:00'), now: NOW, actor: ACTOR, audience: 'staff',
    });
    // Colour 15:30-16:30, envelope 15:15-16:30 — the buffers overlap by 15
    // minutes, the bodies do not touch. A-063 seats both in one chair.
    const colour2 = await bookAppointment(prisma, {
      businessId, providerId: priyaId, serviceIds: [colour.id], clientId: nadia.id,
      startAt: at('2026-06-09T15:30:00-05:00'), now: NOW, actor: ACTOR, audience: 'staff',
    });
    expect(await chairOf(cut.id)).toBe(await chairOf(colour2.id));

    // The OTHER chair is genuinely taken, so her own is the only answer left.
    await book(marcusId, '2026-06-09T15:00:00-05:00');
    return { cut, colour: colour2 };
  };

  it('moves a client whose own colour is holding the chair she needs', async () => {
    const { cut, colour } = await nadiasTwoVisits();

    const preview = await previewPush(prisma, {
      businessId, providerId: danaId, day: DAY,
      fromAt: at('2026-06-09T14:00:00-05:00'), minutes: 5,
    });
    expect(preview.candidates.map((c) => c.problem)).toEqual([undefined]);
    expect(preview.canPush).toBe(true);

    const result = await push(5);
    expect(result.moved).toBe(1);
    expect(result.leftBehind).toEqual([]);
    // She keeps the chair she is in — sharing is a preference, not a shuffle.
    expect(await chairOf(cut.id)).toBe(await chairOf(colour.id));
  });

  it('still refuses when the shift would put her own two bodies in one chair', async () => {
    await nadiasTwoVisits();

    // +40 drags the cut's BODY (14:40-15:40) across the colour's (15:30-16:30).
    // The relaxation is on the envelope only: she cannot be in two chairs, and
    // she cannot be in one chair twice either.
    const preview = await previewPush(prisma, {
      businessId, providerId: danaId, day: DAY,
      fromAt: at('2026-06-09T14:00:00-05:00'), minutes: 40,
    });
    expect(preview.candidates[0]!.problem).toBe('no-chair-free');
  });
});

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
