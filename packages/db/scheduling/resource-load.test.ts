/**
 * A-032 — the engine stops offering a time the room cannot seat (RES-03).
 *
 * A-031 made the database refuse the fifth client in a four-chair room. That
 * refusal arrived at SUBMIT, on a time the screen had just offered: the
 * offered-then-refused defect this repo has already caught twice (the gap-vs-
 * grid seam at demo checkpoint 2, the day-view clipping bug). This is the
 * other half — the room's occupancy is applied to every candidate before it is
 * offered, so the time is never on the screen in the first place.
 *
 * A-082 (demo checkpoint 6) rewrote HOW. Until then the room's answer was a
 * count — "are all four chairs taken at some instant?" — collapsed into busy
 * intervals for the engine to subtract. That question is weaker than the one
 * `findFreeResource` asks, and the last describe in this file is the Saturday
 * where the difference showed: three chairs taken at every instant, never
 * four, no chair free start to finish, and a `NoResourceFree` on a time the
 * public page had just offered. Not a race — permanent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { staffActor } from '../../core/auth';
import { instant, instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment, findFreeResource } from '../booking';
import { rescheduleAppointment } from '../appointments';
import { computeDaySlots } from './slot-query';
import { type ChairHold, type Seating, canSeat } from './resource-load';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));

/** Tuesday 2026-06-09, America/Chicago (CDT, -05:00 all day). */
const DAY = '2026-06-09';
const NOW = at('2026-06-09T08:00:00-05:00');

/** Epoch millis, branded. The spans are instants; this suite never needs a
 *  wall clock, which is why the numbers below are bare offsets. */
const t = (ms: number) => instant(ms);

/** A hold, on a named chair, for a named holder. Body defaults to the envelope
 *  — the two differ only where buffers or A-069's release make them differ, and
 *  the cases that care say so explicitly. */
const h = (
  start: number,
  end: number,
  resourceId: string,
  holderKey = `whoever-${start}`,
  body: [number, number] = [start, end],
): ChairHold => ({
  start: t(start),
  end: t(end),
  resourceId,
  holderKey,
  bodyStart: t(body[0]),
  bodyEnd: t(body[1]),
});

const room = (chairIds: string[], holds: ChairHold[]): Seating => ({
  resourceTypeId: 'chair-type',
  chairIds,
  holds,
});

/** "Could this visit be seated?" — envelope and body are the same span unless a
 *  case is about the difference. */
const seat = (
  seating: Seating,
  start: number,
  end: number,
  holderKey: string | null = null,
  body: [number, number] = [start, end],
) => canSeat(seating, { start: t(start), end: t(end) }, { start: t(body[0]), end: t(body[1]) }, holderKey);

describe('canSeat — the question the chair chooser asks', () => {
  it('seats it while a chair remains', () => {
    expect(seat(room(['c1', 'c2'], [h(0, 100, 'c1')]), 0, 100)).toBe(true);
  });

  it('refuses once the last chair goes, and seats it again in the gap', () => {
    const r = room(['c1', 'c2'], [h(0, 100, 'c1'), h(40, 60, 'c2')]);
    expect(seat(r, 40, 60)).toBe(false);
    expect(seat(r, 100, 160)).toBe(true);
  });

  it('does NOT stack a hold ending at t with one starting at t — half-open, or the salon loses a seating', () => {
    // With '[]' semantics the 50 boundary would read as occupied and the salon
    // would lose a seating at every hand-over.
    expect(seat(room(['c1'], [h(0, 50, 'c1')]), 50, 100)).toBe(true);
  });

  it('a type with no chairs in service seats nothing — ALWAYS full, not never', () => {
    expect(seat(room([], []), 0, 100)).toBe(false);
  });

  /**
   * CHECKPOINT 5, FINDING 3 — one client, one chair, two holds.
   *
   * A-063 made her cut and her colour share ONE chair through the buffers
   * between them. From that moment "how many holds overlap" and "how many
   * chairs are taken" stopped being the same number.
   */
  it('counts CHAIRS, not holds — one client on one chair does not fill a two-chair room', () => {
    const r = room(['c1', 'c2'], [h(0, 60, 'c1', 'ada'), h(50, 120, 'c1', 'ada')]);
    expect(seat(r, 0, 120)).toBe(true);
  });

  it('a shared chair still fills a ONE-chair room for anybody else', () => {
    const r = room(['c1'], [h(0, 60, 'c1', 'ada'), h(50, 120, 'c1', 'ada')]);
    expect(seat(r, 0, 120, 'someone-new')).toBe(false);
  });

  it('two clients on two chairs fill a two-chair room exactly as before', () => {
    expect(seat(room(['c1', 'c2'], [h(0, 60, 'c1'), h(50, 120, 'c2')]), 50, 60)).toBe(false);
  });

  /**
   * A-063's OTHER half, and the reason this function takes a holder at all.
   *
   * Her colour's envelope and her blow-dry's envelope overlap through the
   * buffers between them; the BODIES do not. The chooser gives her the chair
   * she is already sitting in, so an offer that refused it would be stricter
   * than the constraint — which CLAUDE.md is explicit does not fail safe.
   */
  it('seats her in the chair she is already in, even in a one-chair room', () => {
    const r = room(['c1'], [h(0, 60, 'c1', 'ada', [5, 55])]);
    expect(seat(r, 50, 120, 'ada', [60, 115])).toBe(true);
  });

  it('never seats two BODIES on one chair, however the phone number reads', () => {
    // D-17's mother and daughter: one client record, two people, two chairs.
    const r = room(['c1'], [h(0, 60, 'c1', 'ada', [5, 55])]);
    expect(seat(r, 30, 90, 'ada', [30, 90])).toBe(false);
  });

  /**
   * DEMO CHECKPOINT 6 (A-082) — THE FINDING, AS A UNIT TEST.
   *
   * Three of four chairs taken at every instant and never four, so the room was
   * never "full" by the old cardinality question — and there is no single chair
   * free for the whole envelope, so the chooser returns null and the write
   * refuses with `NoResourceFree` on a time the screen had just offered.
   *
   * Wanted 14:15-14:40 (t 15..40 below, minutes past 14:00):
   *   chair 1  30..65   chair 2  15..40   chair 3  5..155   chair 4  -15..20
   */
  it('refuses a staircase that never fills the room but leaves no chair free start to finish', () => {
    const r = room(
      ['c1', 'c2', 'c3', 'c4'],
      [h(30, 65, 'c1'), h(15, 40, 'c2'), h(5, 155, 'c3'), h(-15, 20, 'c4')],
    );
    expect(seat(r, 15, 40)).toBe(false);
    // And the count really does stay below capacity throughout: a shorter
    // visit inside the same staircase is still seatable, on chair 4 then
    // chair 1 — this is not "the room is full", it is "no ONE chair fits".
    expect(seat(r, 20, 30)).toBe(true);
  });
});

describe('the room in the busy set (RES-03)', () => {
  let businessId: string;
  let chairTypeId: string;
  let serviceId: string;
  let providerIds: string[] = [];

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

    const chairType = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
    chairTypeId = chairType.id;
    // TWO chairs and THREE stylists, so the room binds without needing the
    // full sample salon — the same shape A-031's suite uses.
    for (const name of ['Chair 1', 'Chair 2']) {
      await prisma.resource.create({ data: { businessId, resourceTypeId: chairTypeId, name } });
    }

    const service = await prisma.service.create({
      data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, requiredResourceTypeId: chairTypeId },
    });
    serviceId = service.id;

    providerIds = [];
    await createWeeklyWindow(
      prisma,
      { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
      STAMP,
    );
    for (const displayName of ['Dana', 'Priya', 'Marcus']) {
      const provider = await prisma.provider.create({ data: { businessId, displayName } });
      providerIds.push(provider.id);
      await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId: provider.id } });
      await createWeeklyWindow(
        prisma,
        { businessId, providerId: provider.id, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
        STAMP,
      );
    }
  });

  const book = (over: Record<string, unknown> = {}) =>
    bookAppointment(prisma, {
      businessId,
      providerId: providerIds[0]!,
      serviceIds: [serviceId],
      clientId: null,
      startAt: at('2026-06-09T10:00:00-05:00'),
      now: NOW,
      actor: ACTOR,
      audience: 'staff',
      ...over,
    } as Parameters<typeof bookAppointment>[1]);

  const slotsFor = async (providerId: string, over: Record<string, unknown> = {}) =>
    computeDaySlots(prisma, {
      businessId,
      providerId,
      serviceIds: [serviceId],
      day: DAY,
      now: NOW,
      audience: 'public',
      ...over,
    });

  const fillTheRoom = async () => {
    await book();
    await book({ providerId: providerIds[1]! });
  };

  it('stops offering the hour to an idle stylist once both chairs are held', async () => {
    await fillTheRoom();
    const { slots } = await slotsFor(providerIds[2]!);
    const labels = slots.map((s) => s.label.time);
    expect(labels).not.toContain('10:00');
    // ...and the times either side are untouched: this removes an hour, not a day.
    expect(labels).toContain('12:00');
  });

  it('names the RIGHT reason for staff — she is free, the room is not', async () => {
    await fillTheRoom();
    const { excluded } = await slotsFor(providerIds[2]!, { audience: 'staff' });
    const reasonsAt = (time: string) => excluded.find((e) => e.label.time === time)?.reasons ?? [];
    // Not `overlaps-booking`: Marcus has no client at all, and telling the desk
    // he does is the wrong-explanation failure every other kind has its own
    // reason to avoid.
    expect(reasonsAt('10:00')).toEqual(['no-resource-free']);
  });

  it('offers the hour again the moment a chair frees', async () => {
    await fillTheRoom();
    const [first] = await prisma.appointment.findMany({ orderBy: { createdAt: 'asc' }, take: 1 });
    await prisma.appointment.update({ where: { id: first!.id }, data: { status: 'cancelled' } });

    const { slots } = await slotsFor(providerIds[2]!);
    expect(slots.map((s) => s.label.time)).toContain('10:00');
  });

  it('does not count the appointment being MOVED against its own destination', async () => {
    await fillTheRoom();
    const moving = await prisma.appointment.findFirstOrThrow({
      where: { providerId: providerIds[1]! },
    });

    // Without the exclusion, a full room makes every reschedule inside the
    // hour impossible — the appointment's own chair blocks its own move.
    const { slots } = await slotsFor(providerIds[1]!, {
      audience: 'staff',
      excludeAppointmentId: moving.id,
    });
    expect(slots.map((s) => s.label.time)).toContain('10:15');
  });

  it('leaves a service that needs no chair alone', async () => {
    await fillTheRoom();
    const consult = await prisma.service.create({
      data: { businessId, name: 'Phone consult', durationMinutes: 30, priceCents: 0 },
    });
    await prisma.serviceProvider.create({
      data: { businessId, serviceId: consult.id, providerId: providerIds[2]! },
    });

    const { slots } = await slotsFor(providerIds[2]!, { serviceIds: [consult.id] });
    expect(slots.map((s) => s.label.time)).toContain('10:00');
  });
});

/**
 * DEMO CHECKPOINT 6 (A-082) — THE STAIRCASE, END TO END.
 *
 * Found by walking the seeded book: 169 offers taken at random, three of them
 * refused at the write with `NoResourceFree` on a time the public page had
 * just listed. Not a lost race — nothing else was booking. The room was never
 * full, and no ONE chair was free for the whole envelope:
 *
 *   Chair 1  ▓▓▓▓▓▓▓ 13:45-14:20
 *   Chair 2  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 14:05-16:35
 *   Chair 3  ▓▓▓▓▓▓ 14:15-14:40
 *   Chair 4          ▓▓▓▓▓▓▓ 14:30-15:05
 *   wanted   ▓▓▓▓▓▓ 14:15-14:40
 *
 * Three chairs occupied at every instant of the envelope and never four. A
 * count says "not full"; the chooser says "nowhere to sit".
 *
 * The fixture reaches that state the way a Saturday does — four bookings that
 * DO overlap (so first-fit puts each on its own chair) and then one client
 * moved twenty-five minutes earlier, which keeps her chair (A-034) and takes
 * the room back below capacity. That order matters: pairwise-overlapping
 * envelopes always share a common instant, so a room reached only by
 * first-fit booking can never show this. Something has to MOVE.
 */
describe('a room that is never full and still cannot seat her (A-082)', () => {
  let businessId: string;
  let chairTypeId: string;
  let short: string;
  let mid: string;
  let long: string;
  let providers: string[] = [];

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

    const chairType = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
    chairTypeId = chairType.id;
    // FOUR chairs, because the whole point is a room with a chair to spare at
    // every instant. A one- or two-chair fixture cannot express it.
    for (const name of ['Chair 1', 'Chair 2', 'Chair 3', 'Chair 4']) {
      await prisma.resource.create({ data: { businessId, resourceTypeId: chairTypeId, name } });
    }

    // Zero buffers, so the envelope IS the body and the arithmetic above is
    // readable. The staircase is about the chairs, not about whose buffer.
    const mk = async (name: string, durationMinutes: number) =>
      (
        await prisma.service.create({
          data: {
            businessId,
            name,
            durationMinutes,
            priceCents: 5500,
            requiredResourceTypeId: chairTypeId,
          },
        })
      ).id;
    // Every start below lands on the 15-minute grid; the ENDS deliberately do
    // not, which is what makes the staircase a staircase.
    short = await mk('Treatment', 25);
    mid = await mk('Blow-dry', 35);
    long = await mk('Balayage', 150);

    await createWeeklyWindow(
      prisma,
      { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
      STAMP,
    );
    providers = [];
    // Five stylists: four to fill the chairs, one standing idle at 14:15 —
    // which is the whole complaint. The room refuses her, not the diary.
    for (const displayName of ['Dana', 'Priya', 'Marcus', 'Tess', 'Nadia']) {
      const provider = await prisma.provider.create({ data: { businessId, displayName } });
      providers.push(provider.id);
      for (const serviceId of [short, mid, long]) {
        await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId: provider.id } });
      }
      await createWeeklyWindow(
        prisma,
        { businessId, providerId: provider.id, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
        STAMP,
      );
    }
  });

  const book = (providerIndex: number, serviceId: string, start: string) =>
    bookAppointment(prisma, {
      businessId,
      providerId: providers[providerIndex]!,
      serviceIds: [serviceId],
      clientId: null,
      startAt: at(`2026-06-09T${start}:00-05:00`),
      now: NOW,
      actor: ACTOR,
      audience: 'staff',
    } as Parameters<typeof bookAppointment>[1]);

  /** The staircase. Returns nothing; the room is the assertion. */
  const buildTheStaircase = async () => {
    // 14:15-14:50, and it MOVES to 13:45-14:20 below. Booked first, so it takes
    // Chair 1 and keeps it through the move (A-034).
    const mover = await book(0, mid, '14:15');
    await book(1, long, '14:00'); // Chair 2 — 14:00-16:30
    await book(2, short, '14:15'); // Chair 3 — 14:15-14:40
    await book(3, mid, '14:30'); // Chair 4 — overlaps all three above
    // She rang and asked to come in earlier. Her chair follows her, and the
    // room drops back below capacity.
    await rescheduleAppointment(prisma, {
      appointmentId: mover.id,
      startAt: at('2026-06-09T13:45:00-05:00'),
      now: NOW,
      actor: ACTOR,
      audience: 'staff',
    });
  };

  const chairsAt = async () => {
    const holds = await prisma.appointmentResourceHold.findMany({
      select: { resourceId: true, blockedStart: true, blockedEnd: true },
    });
    return new Set(holds.map((h) => h.resourceId)).size;
  };

  it('puts each of the four on its own chair, and the mover keeps hers', async () => {
    await buildTheStaircase();
    expect(await chairsAt()).toBe(4);
  });

  it('does not offer 14:15 to the idle stylist, because no chair is free start to finish', async () => {
    await buildTheStaircase();
    const { slots } = await computeDaySlots(prisma, {
      businessId,
      providerId: providers[4]!,
      serviceIds: [short],
      day: DAY,
      now: NOW,
      audience: 'public',
    });
    expect(slots.map((s) => s.label.time)).not.toContain('14:15');
  });

  it('says WHY to staff — she is free, the room is not', async () => {
    await buildTheStaircase();
    const { excluded } = await computeDaySlots(prisma, {
      businessId,
      providerId: providers[4]!,
      serviceIds: [short],
      day: DAY,
      now: NOW,
      audience: 'staff',
    });
    const at1415 = excluded.find((e) => e.label.time === '14:15');
    // The REASON, not merely the absence: an absence assertion passes for a
    // dozen wrong causes, and three write paths read this exact string to
    // reach RES-04's override.
    expect(at1415?.reasons).toEqual(['no-resource-free']);
  });

  it('EVERY time it offers can actually be seated — the invariant the walk broke', async () => {
    await buildTheStaircase();
    const { slots } = await computeDaySlots(prisma, {
      businessId,
      providerId: providers[4]!,
      serviceIds: [short],
      day: DAY,
      now: NOW,
      audience: 'public',
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const chair = await findFreeResource(prisma, {
        businessId,
        resourceTypeId: chairTypeId,
        start: toDate(slot.blockedStart),
        end: toDate(slot.blockedEnd),
      });
      expect(chair, `offered ${slot.label.time} with no chair to put her in`).not.toBeNull();
    }
  });

  it('still offers the times the room CAN seat — it refuses the visit, not the afternoon', async () => {
    await buildTheStaircase();
    const { slots } = await computeDaySlots(prisma, {
      businessId,
      providerId: providers[4]!,
      serviceIds: [short],
      day: DAY,
      now: NOW,
      audience: 'public',
    });
    // Chair 1 is free from 14:10 and Chair 3 from 14:40; a 25-minute visit at
    // 14:45 fits both. A reader stricter than the constraint refuses work the
    // salon needs, which is the other half of this fix.
    expect(slots.map((s) => s.label.time)).toContain('14:45');
  });

  it('and the write agrees with the offer, which is the whole complaint', async () => {
    await buildTheStaircase();
    await expect(book(4, short, '14:45')).resolves.toBeTruthy();
  });
});
