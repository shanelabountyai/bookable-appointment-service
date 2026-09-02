/**
 * A-069 / D-44 — giving a no-show's dead time back, against a real database.
 *
 * The two assertions that matter most are the ones that must NOT move.
 * `dashboard.ts` sums `endAt - startAt` and `reliability.ts` counts by
 * `status`, so D-44's whole claim is that a change confined to `blockedEnd`
 * cannot reach either — untouched BY CONSTRUCTION rather than by a filter
 * somebody has to remember. The tests below are the regression guard on that
 * claim, not the mechanism.
 *
 * The rest is the room: a released slot has to become genuinely bookable
 * WITHOUT an override, because a false override marker on empty time is the
 * defect this item exists to remove.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { clientReliability } from '../clients';
import { bookAppointment } from '../booking';
import { dashboardSummary } from '../reports/dashboard';
import { NotReleasable, releaseNoShowTime } from './release-time';
import { TransitionRefused, transitionAppointment } from './transition';

const prisma = new PrismaClient();
const STAFF = staffActor('staff-1');
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };

const at = (iso: string) => toDate(instantFromIso(iso));

// Tuesday 9 June 2026, Chicago.
const NOW = at('2026-06-08T08:00:00-05:00');
const TEN_AM = at('2026-06-09T10:00:00-05:00');
/** Twenty past, the moment the desk gives up on her. */
const GAVE_UP = at('2026-06-09T10:20:00-05:00');

let businessId: string;
let danaId: string;
let priyaId: string;
let colourId: string;
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
      cancellationCutoffMinutes: 120,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;
  danaId = (await prisma.provider.create({ data: { businessId, displayName: 'Dana' } })).id;
  // A-074's mirror test needs a SECOND stylist: the time she did occupy has to
  // be refused by the ROOM, and asking on Dana's own column would be refused by
  // the provider axis for the wrong reason.
  priyaId = (await prisma.provider.create({ data: { businessId, displayName: 'Priya', displayOrder: 1 } })).id;

  // UNEQUAL BUFFERS (CLAUDE.md): the release cuts at an instant, and a test
  // where both buffers are the same cannot tell whose was dropped.
  colourId = (
    await prisma.service.create({
      data: {
        businessId,
        name: 'Colour',
        durationMinutes: 90,
        priceCents: 12000,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 20,
      },
    })
  ).id;
  cutId = (
    await prisma.service.create({
      data: {
        businessId,
        name: 'Cut',
        durationMinutes: 45,
        priceCents: 5500,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 15,
      },
    })
  ).id;
  await prisma.serviceProvider.createMany({
    data: [danaId, priyaId].flatMap((providerId) =>
      [colourId, cutId].map((serviceId) => ({ businessId, serviceId, providerId })),
    ),
  });
  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;

  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
    STAFF_WINDOW,
  );
  for (const providerId of [danaId, priyaId]) {
    await createWeeklyWindow(
      prisma,
      { businessId, providerId, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
      STAFF_WINDOW,
    );
  }
});

/** Her colour: body 10:00–11:30, envelope 09:50–11:50. */
async function noShow() {
  const appointment = await bookAppointment(prisma, {
    businessId,
    providerId: danaId,
    serviceIds: [colourId],
    clientId,
    startAt: TEN_AM,
    now: NOW,
    actor: STAFF,
    audience: 'staff',
  } as Parameters<typeof bookAppointment>[1]);
  await transitionAppointment(prisma, {
    appointmentId: appointment.id,
    to: 'no_show',
    now: GAVE_UP,
    actor: STAFF,
  });
  return appointment;
}

const release = (appointmentId: string, releasedAt = GAVE_UP, reason: string | null = null) =>
  releaseNoShowTime(prisma, { businessId, appointmentId, releasedAt, actor: STAFF, reason });

const rowOf = (id: string) => prisma.appointment.findUniqueOrThrow({ where: { id } });

describe('the cut', () => {
  it('cuts the blocked range at the moment the desk gave up, and says how much came back', async () => {
    const appointment = await noShow();
    const before = await rowOf(appointment.id);
    expect(before.blockedEnd).toEqual(at('2026-06-09T11:50:00-05:00'));

    const released = await release(appointment.id, GAVE_UP, 'Rang twice, no answer');

    // 10:20 → 11:50 is ninety minutes: the hour and ten she had left plus the
    // twenty-minute clean-down nobody needs for a client who never sat down.
    expect(released.minutes).toBe(90);
    const after = await rowOf(appointment.id);
    expect(after.blockedEnd).toEqual(GAVE_UP);
    expect(after.releasedAt).toEqual(GAVE_UP);
    // The RECORD is untouched — this is D-7, not re-opened.
    expect(after.status).toBe('no_show');
    expect(after.startAt).toEqual(before.startAt);
    expect(after.endAt).toEqual(before.endAt);
  });

  it('drops the per-block ranges past the cut, so the constraint agrees with the row (D-29)', async () => {
    const appointment = await noShow();
    await release(appointment.id);

    const blocks = await prisma.appointmentBlock.findMany({
      where: { appointmentId: appointment.id },
      orderBy: { ordinal: 'asc' },
    });

    // The busy set and `appointment_block_no_overlap` both read these. A parent
    // saying the time is free while a block still holds it is the row and the
    // invariant disagreeing — the constraint would refuse to sell time the
    // grid was offering.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.blockedEnd).toEqual(GAVE_UP);
  });

  it('writes ONE event carrying both sides, and sends nothing', async () => {
    const appointment = await noShow();
    const sent = await prisma.notificationOutbox.count();

    await release(appointment.id, GAVE_UP, 'Rang twice, no answer');

    const events = await prisma.appointmentEvent.findMany({ where: { type: 'time_released' } });
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe('Rang twice, no answer');
    expect(events[0]!.payload).toMatchObject({
      releasedAt: GAVE_UP.toISOString(),
      // The far end, because the trigger has already overwritten `blockedEnd`
      // — this is the only surviving record of how much came back.
      fromBlockedEnd: at('2026-06-09T11:50:00-05:00').toISOString(),
    });
    // She did not come. Telling her that her slot has been resold is not a
    // message any salon sends.
    expect(await prisma.notificationOutbox.count()).toBe(sent);
  });
});

describe('what it must NOT move (D-44)', () => {
  it('leaves the client\'s no-show count exactly where it was', async () => {
    const appointment = await noShow();
    const before = await clientReliability(prisma, { businessId, clientIds: [clientId], today: '2026-06-10' });
    expect(before.get(clientId)!.noShows).toBe(1);

    await release(appointment.id);

    const after = await clientReliability(prisma, { businessId, clientIds: [clientId], today: '2026-06-10' });
    expect(after.get(clientId)!.noShows).toBe(1);
  });

  it('leaves utilization exactly where it was — she occupied that time (D-7)', async () => {
    const appointment = await noShow();
    const before = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09' });

    await release(appointment.id);

    const after = await dashboardSummary(prisma, { businessId, anyDayInWeek: '2026-06-09' });
    expect(after.utilizationByProvider).toEqual(before.utilizationByProvider);
    expect(after.noShowsByProvider).toEqual(before.noShowsByProvider);
  });
});

describe('the room it gives back (BOOK-05)', () => {
  /** THE WHOLE POINT. Before this, the walk-in at 10:25 could only be booked
   *  through an override with a typed reason — a false marker on empty time,
   *  and the fastest way to teach the desk to ignore the one D-8 rests on. */
  it('lets a walk-in be booked into the freed time with NO override', async () => {
    const appointment = await noShow();
    await release(appointment.id);

    const walkIn = await bookAppointment(prisma, {
      businessId,
      providerId: danaId,
      serviceIds: [cutId],
      clientId: null,
      startAt: at('2026-06-09T10:30:00-05:00'),
      now: GAVE_UP,
      actor: STAFF,
      audience: 'staff',
    } as Parameters<typeof bookAppointment>[1]);

    expect((await rowOf(walkIn.id)).isOverride).toBe(false);
  });

  it('still refuses the time she DID occupy — nobody wants to sell 10:00 at 10:25', async () => {
    const appointment = await noShow();
    await release(appointment.id);

    await expect(
      bookAppointment(prisma, {
        businessId,
        providerId: danaId,
        serviceIds: [cutId],
        clientId: null,
        startAt: TEN_AM,
        now: GAVE_UP,
        actor: STAFF,
        audience: 'staff',
      } as Parameters<typeof bookAppointment>[1]),
    ).rejects.toThrow();
  });
});

describe('the refusals', () => {
  it('refuses anything that is not a no-show', async () => {
    const appointment = await bookAppointment(prisma, {
      businessId,
      providerId: danaId,
      serviceIds: [colourId],
      clientId,
      startAt: TEN_AM,
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    } as Parameters<typeof bookAppointment>[1]);

    // Shortening a visit somebody IS having is A-055's job, not this one.
    await expect(release(appointment.id)).rejects.toBeInstanceOf(NotReleasable);
  });

  it('refuses a second release — one-shot, by design', async () => {
    const appointment = await noShow();
    await release(appointment.id);

    await expect(release(appointment.id, at('2026-06-09T10:40:00-05:00'))).rejects.toBeInstanceOf(NotReleasable);
    expect((await rowOf(appointment.id)).releasedAt).toEqual(GAVE_UP);
  });

  /** The whole-minutes CHECK is on `blockedEnd`, and `releasedAt` becomes it —
   *  so an unfloored `new Date()`, which is what the desk's button passes,
   *  reached Postgres as a raw 23514 before this. Found by an e2e fixture,
   *  which is the only place a real clock got near this write. */
  it('floors a released instant carrying seconds, because it becomes blockedEnd', async () => {
    const appointment = await noShow();

    const released = await release(appointment.id, at('2026-06-09T10:20:37.412-05:00'));

    expect(released.releasedAt).toEqual(GAVE_UP);
    expect((await rowOf(appointment.id)).blockedEnd).toEqual(GAVE_UP);
    expect(released.minutes).toBe(90);
  });

  it('refuses an instant before she was due, and one after her time was over', async () => {
    const appointment = await noShow();

    await expect(release(appointment.id, at('2026-06-09T09:30:00-05:00'))).rejects.toBeInstanceOf(NotReleasable);
    await expect(release(appointment.id, at('2026-06-09T12:00:00-05:00'))).rejects.toBeInstanceOf(NotReleasable);
    expect((await rowOf(appointment.id)).releasedAt).toBeNull();
  });
});

/**
 * The trigger honours `releasedAt` only while the status IS `no_show`, so a
 * correction off it restores the full range with no transition path having to
 * remember. Structural, which is the reason it is here and not a rule in
 * `transition.ts` that a future fourth status change could miss.
 *
 * `completed` is the only edge leaving `no_show` (APPT-06's mis-tap fix), and
 * it is the right one: "she was here, I marked the wrong chip."
 */
describe('correcting her back (APPT-06)', () => {
  it('restores the full blocked range', async () => {
    const appointment = await noShow();
    await release(appointment.id);
    expect((await rowOf(appointment.id)).blockedEnd).toEqual(GAVE_UP);

    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      now: at('2026-06-09T12:00:00-05:00'),
      actor: STAFF,
      reason: 'she was here, marked wrong',
    });

    const row = await rowOf(appointment.id);
    expect(row.status).toBe('completed');
    expect(row.blockedEnd).toEqual(at('2026-06-09T11:50:00-05:00'));
    // The column keeps the record of what was done, and the trigger simply
    // stops reading it — the release is not silently erased.
    expect(row.releasedAt).toEqual(GAVE_UP);
  });

  it('is refused outright when the freed time has since been sold', async () => {
    const appointment = await noShow();
    await release(appointment.id);
    await bookAppointment(prisma, {
      businessId,
      providerId: danaId,
      serviceIds: [cutId],
      clientId: null,
      startAt: at('2026-06-09T10:30:00-05:00'),
      now: GAVE_UP,
      actor: STAFF,
      audience: 'staff',
    } as Parameters<typeof bookAppointment>[1]);

    // The CONSTRAINT is the answer to "put her back", not a screen's guess —
    // so the refusal must not be a transition-table one, which would pass this
    // test while proving nothing about the room.
    const refusal = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      now: at('2026-06-09T12:00:00-05:00'),
      actor: STAFF,
      reason: 'she was here, marked wrong',
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(TransitionRefused);
    expect((await rowOf(appointment.id)).status).toBe('no_show');
  });
});

/**
 * A-074 — THE CHAIR, which A-069 shipped without a fixture for at all.
 *
 * This file created no `ResourceType`, no `Resource` and no
 * `requiredResourceTypeId`, so the entire release item was tested with the room
 * switched off — and the room is enforced by TWO exclusion constraints, one of
 * which (`appointment_resource_body_no_overlap`) is unconditional on the
 * holder. A-069 told the two triggers that write the blocked range and not the
 * one that writes the chair's BODY, so the grid offered the freed tail and the
 * room refused it: `NoResourceFree` on a chair with nobody in it, which is
 * A-063's stated harm word for word.
 *
 * ONE CHAIR IS THE ONLY SIZE THAT CAN FAIL. With two, the walk-in simply takes
 * the other one and the bug is invisible — which is exactly how a fixture
 * passes while the salon cannot sell the slot.
 */
describe('the chair it gives back (A-074, RES-02)', () => {
  let chairId: string;

  beforeEach(async () => {
    const type = await prisma.resourceType.create({ data: { businessId, name: 'Chair' } });
    chairId = (await prisma.resource.create({ data: { businessId, resourceTypeId: type.id, name: 'Chair 1' } })).id;
    await prisma.service.updateMany({ where: { businessId }, data: { requiredResourceTypeId: type.id } });
  });

  const holdOf = (appointmentId: string) =>
    prisma.appointmentResourceHold.findFirstOrThrow({ where: { appointmentId } });

  it('cuts the chair BODY at the release, not only the envelope', async () => {
    const appointment = await noShow();
    expect((await holdOf(appointment.id)).bodyEnd).toEqual(at('2026-06-09T11:30:00-05:00'));

    await release(appointment.id);

    const hold = await holdOf(appointment.id);
    // The envelope followed on its own — the trigger copies it off the row.
    expect(hold.blockedEnd).toEqual(GAVE_UP);
    // The body did NOT, until A-074. `blockedEnd` and `bodyEnd` are the same
    // fact under two names, and only one of them was told.
    expect(hold.bodyEnd).toEqual(GAVE_UP);
    expect(hold.resourceId).toBe(chairId);
  });

  /** THE DEFECT, end to end, on the one-chair room that is the only fixture
   *  that can fail. The day grid paints this slot as bookable because gaps
   *  derive from the busy set; before A-074 the room then refused it. */
  it('sells the released tail to a walk-in, on the only chair in the room', async () => {
    const appointment = await noShow();
    await release(appointment.id);

    const walkIn = await bookAppointment(prisma, {
      businessId,
      providerId: danaId,
      serviceIds: [cutId],
      clientId: null,
      startAt: at('2026-06-09T10:30:00-05:00'),
      now: GAVE_UP,
      actor: STAFF,
      audience: 'staff',
    } as Parameters<typeof bookAppointment>[1]);

    // The same chair she stopped sitting in, and NOT an override — the whole
    // point of A-069 was that this needs no BOOK-05 marker.
    expect((await holdOf(walkIn.id)).resourceId).toBe(chairId);
    expect((await rowOf(walkIn.id)).isOverride).toBe(false);
  });

  /** The mirror, so the fix cannot overshoot: the twenty minutes she DID hold
   *  is still hers, and the room still says so. */
  it('still refuses a body over the time she actually occupied', async () => {
    const appointment = await noShow();
    await release(appointment.id);

    await expect(
      bookAppointment(prisma, {
        businessId,
        providerId: priyaId,
        serviceIds: [cutId],
        clientId: null,
        startAt: TEN_AM,
        now: NOW,
        actor: STAFF,
        audience: 'staff',
      } as Parameters<typeof bookAppointment>[1]),
    ).rejects.toThrow();
  });

  /** Correcting her back restores the whole body, by the same status guard the
   *  blocked range uses — so no transition path has to remember, and the
   *  constraint is what refuses if the time has since been sold. */
  it('restores the body when she is corrected off no_show', async () => {
    const appointment = await noShow();
    await release(appointment.id);

    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      now: at('2026-06-09T12:00:00-05:00'),
      actor: STAFF,
      reason: 'she was here, marked wrong',
    });

    expect((await holdOf(appointment.id)).bodyEnd).toEqual(at('2026-06-09T11:30:00-05:00'));
  });
});
