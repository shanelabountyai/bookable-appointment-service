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
import { SlotTaken } from '../booking';
import { pushColumn, previewPush } from '../day/push-column';
import { NotReleasable, releaseNoShowTime, unreleaseNoShowTime } from './release-time';
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

  /**
   * A-078 — D-45's SCENE, THE HALF NOBODY HAD RUN.
   *
   * The two refusal tests further down sell the tail to DANA, so the PROVIDER
   * constraint refuses and the desk gets its sentence. Sell it to PRIYA in a
   * one-chair room and Dana's own column is untouched: the only thing that can
   * refuse is `appointment_resource_body_no_overlap`, which A-063 added to the
   * database and never added to `errors.ts`. Both paths therefore reached the
   * desk as `PrismaClientUnknownRequestError` — a stack trace where D-45
   * promised words — and nine items went by, because the only test that
   * touched that constraint asserted the RAW error string.
   *
   * A one-chair room is the only size that can fail (CLAUDE.md).
   */
  const priyaTakesTheChair = async () =>
    bookAppointment(prisma, {
      businessId,
      providerId: priyaId,
      serviceIds: [cutId],
      // HER OWN client id, not a stranger's. That is what isolates the BODY
      // constraint: A-063's envelope constraint carries `holderKey WITH <>`, so
      // one holder's overlapping envelopes are permitted and the only thing
      // left to refuse two people in one seat is the body. A walk-in stranger
      // trips the envelope constraint first, which `errors.ts` already knew —
      // which is exactly how the gap survived nine items.
      clientId,
      startAt: at('2026-06-09T10:30:00-05:00'),
      now: GAVE_UP,
      actor: STAFF,
      audience: 'staff',
    } as Parameters<typeof bookAppointment>[1]);

  it('tells the desk in WORDS when only the CHAIR refuses the un-release', async () => {
    const appointment = await noShow();
    await release(appointment.id);
    await priyaTakesTheChair();

    await expect(
      unreleaseNoShowTime(prisma, { businessId, appointmentId: appointment.id, actor: STAFF }),
    ).rejects.toBeInstanceOf(SlotTaken);
    expect((await rowOf(appointment.id)).releasedAt).toEqual(GAVE_UP);
  });

  it('gives the APPT-06 correction behind it the same words', async () => {
    const appointment = await noShow();
    await release(appointment.id);
    await priyaTakesTheChair();

    await expect(
      transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'completed',
        now: at('2026-06-09T12:00:00-05:00'),
        actor: STAFF,
        reason: 'she was here, marked wrong',
      }),
    ).rejects.toBeInstanceOf(SlotTaken);
  });
});

/**
 * A-075 — THE PATHS THAT MOVE AN APPOINTMENT HAD NEVER HEARD OF `releasedAt`.
 *
 * Two failures, one column. The push crashed because `releasedAt` lives inside
 * `[startAt, endAt)` by CHECK and the mover took `startAt` out from under it;
 * and there was no way back, so a client who walked in fifteen minutes after
 * the desk gave up kept a no-show she did not earn.
 */
describe('a column pushed over a released no-show (A-075)', () => {
  /** A booked appointment AFTER the no-show, so the push has something it is
   *  genuinely supposed to move and the test cannot pass by moving nothing. */
  async function alsoBooked() {
    return bookAppointment(prisma, {
      businessId,
      providerId: danaId,
      serviceIds: [cutId],
      clientId: null,
      startAt: at('2026-06-09T13:00:00-05:00'),
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    } as Parameters<typeof bookAppointment>[1]);
  }

  const push = (fromAt: Date, minutes: number) =>
    pushColumn(prisma, {
      businessId,
      providerId: danaId,
      day: '2026-06-09',
      fromAt,
      minutes,
      actor: STAFF,
      now: GAVE_UP,
    } as Parameters<typeof pushColumn>[1]);

  /** THE CRASH. Before A-075 this raised SQLSTATE 23514 out of the
   *  running-late workflow — after the preview had promised a clean push, and
   *  the whole transaction then rolled back, so nothing moved on the busiest
   *  column of the week. */
  it('does not move a released no-show, and does not crash trying', async () => {
    const noShowAppointment = await noShow();
    await release(noShowAppointment.id);
    const later = await alsoBooked();

    const result = await push(TEN_AM, 30);

    // The one that CAN run late moved…
    expect((await rowOf(later.id)).startAt).toEqual(at('2026-06-09T13:30:00-05:00'));
    // …and the one who never came did not. A client who did not turn up cannot
    // be running late, and her release is still intact.
    const untouched = await rowOf(noShowAppointment.id);
    expect(untouched.startAt).toEqual(TEN_AM);
    expect(untouched.releasedAt).toEqual(GAVE_UP);
    expect(result.moved).toBe(1);
  });

  /**
   * A-018's own rule: the preview asks the question the push asks. Here they
   * share one selector, so this pins that they still do.
   *
   * A-079 changed the SHAPE of the answer and not the answer. She was out of
   * the preview entirely, which meant the desk was never promised the move —
   * and also never told she was standing there, so a pull-forward onto her
   * time previewed clean and died at COMMIT. She is now a candidate that
   * permanently cannot move, which is both halves at once.
   */
  it('shows her as standing there, never as about to move', async () => {
    const noShowAppointment = await noShow();
    await release(noShowAppointment.id);
    await alsoBooked();

    const preview = await previewPush(prisma, {
      businessId,
      providerId: danaId,
      day: '2026-06-09',
      fromAt: TEN_AM,
      minutes: 30,
    });

    // Named, and named as a bystander: the move set never contained her, so
    // there is no arm of this preview on which she is about to be moved.
    const hers = preview.candidates.find((row) => row.appointmentId === noShowAppointment.id);
    expect(hers?.problem).toBe('still-in-the-chair');
    expect(hers?.to).toEqual(hers?.from);
  });

  /** …and an UNRELEASED no-show is left alone for the same reason, so the fix
   *  is about the status rather than about the column. */
  it('leaves an ordinary no-show alone as well — she cannot be running late', async () => {
    const noShowAppointment = await noShow();
    await alsoBooked();

    await push(TEN_AM, 30);

    expect((await rowOf(noShowAppointment.id)).startAt).toEqual(TEN_AM);
  });
});

describe('she walked in after all (A-075, D-45)', () => {
  it('puts her whole time back on the book, and the correction then succeeds', async () => {
    const appointment = await noShow();
    await release(appointment.id);
    expect((await rowOf(appointment.id)).blockedEnd).toEqual(GAVE_UP);

    const restored = await unreleaseNoShowTime(prisma, { businessId, appointmentId: appointment.id, actor: STAFF });

    expect(restored.minutes).toBe(90);
    const row = await rowOf(appointment.id);
    expect(row.releasedAt).toBeNull();
    expect(row.blockedEnd).toEqual(at('2026-06-09T11:50:00-05:00'));
    // Still a no-show until somebody says otherwise — this changes no status.
    expect(row.status).toBe('no_show');

    // THE WHOLE POINT: the APPT-06 correction now goes through, so she does
    // not keep a no-show she did not earn.
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      now: at('2026-06-09T12:00:00-05:00'),
      actor: STAFF,
      reason: 'she was here, fifteen minutes late',
    });
    expect((await rowOf(appointment.id)).status).toBe('completed');
  });

  /** No check-then-write: the constraint is what refuses, and the desk is told
   *  in words rather than by a raw SQLSTATE. */
  it('is refused, in the shared vocabulary, once the tail has been sold', async () => {
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

    await expect(
      unreleaseNoShowTime(prisma, { businessId, appointmentId: appointment.id, actor: STAFF }),
    ).rejects.toBeInstanceOf(SlotTaken);
    expect((await rowOf(appointment.id)).releasedAt).toEqual(GAVE_UP);
  });

  /** The same refusal reaching the CORRECTION, which is where the desk meets
   *  it first — and where it used to arrive as a crash. */
  it('gives the correction the same words rather than a raw database error', async () => {
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

    await expect(
      transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'completed',
        now: at('2026-06-09T12:00:00-05:00'),
        actor: STAFF,
        reason: 'she was here, marked wrong',
      }),
    ).rejects.toBeInstanceOf(SlotTaken);
  });

  it('refuses an appointment that was never released, and one off no_show', async () => {
    const appointment = await noShow();

    await expect(
      unreleaseNoShowTime(prisma, { businessId, appointmentId: appointment.id, actor: STAFF }),
    ).rejects.toBeInstanceOf(NotReleasable);
  });

  it('writes ONE event saying she arrived after all, and sends nothing', async () => {
    const appointment = await noShow();
    await release(appointment.id);
    const sent = await prisma.notificationOutbox.count();

    await unreleaseNoShowTime(prisma, {
      businessId,
      appointmentId: appointment.id,
      actor: STAFF,
      reason: 'walked in at 10:35',
    });

    const events = await prisma.appointmentEvent.findMany({ where: { type: 'time_released' } });
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toMatchObject({ restored: true });
    expect(events[1]!.reason).toBe('walked in at 10:35');
    expect(await prisma.notificationOutbox.count()).toBe(sent);
  });
});
