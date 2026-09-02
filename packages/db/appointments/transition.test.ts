/**
 * A-012 — transitions against the real database.
 *
 * The pure table is exhaustively tested in
 * `packages/core/scheduling/transitions.test.ts`; nothing here re-tests which
 * cells are legal. These assert the things only a database can be wrong
 * about: the busy set actually changing, the cutoff being resolved from real
 * service rows, the event log being written and append-only, actual timestamps
 * landing where D-7 says, and two front-desk taps not producing two events.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { customerTokenActor, staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { computeDaySlots } from '../scheduling';
import { saveStaffMember } from '../auth';
import { reliabilityFor } from '../clients';
import { loadAppointmentDetail } from './detail';
import { AppointmentMovedFirst, TransitionRefused, transitionAppointment } from './transition';

const prisma = new PrismaClient();
const STAFF_ROW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const STAFF = staffActor('staff-1');
const CUSTOMER = customerTokenActor('token-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const DAY = '2026-06-09'; // Tuesday
const TEN_AM = at('2026-06-09T10:00:00-05:00');
const BEFORE = at('2026-06-09T08:00:00-05:00');
/** After the appointment's scheduled end (10:00 + 60 min). */
const AFTER_END = at('2026-06-09T11:30:00-05:00');

let businessId: string;
let providerId: string;
let serviceId: string;
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

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = dana.id;

  const service = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, bufferAfterMinutes: 15 },
  });
  serviceId = service.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId } });

  const client = await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } });
  clientId = client.id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAFF_ROW);
  await createWeeklyWindow(prisma, { businessId, providerId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAFF_ROW);
});

const book = (over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    clientId,
    startAt: TEN_AM,
    now: BEFORE,
    actor: STAFF,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

const tenAmOffered = async () =>
  (await computeDaySlots(prisma, { businessId, providerId, serviceIds: [serviceId], day: DAY, now: BEFORE, audience: 'staff' })).slots.some(
    (s) => s.start === TEN_AM.getTime(),
  );

describe('D-7 — which statuses free the slot', () => {
  it('keeps the time occupied while the appointment is live', async () => {
    await book();
    expect(await tenAmOffered()).toBe(false);
  });

  it.each(['cancelled', 'cancelled_late'] as const)('frees the time on %s', async (to) => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to, actor: STAFF, now: BEFORE });
    expect(await tenAmOffered()).toBe(true);
  });

  /**
   * THE D-7 TRAP. `completed` and `no_show` are terminal but still OCCUPY.
   * Getting this wrong puts a gap in the day view where a client was actually
   * sitting, and lets the engine sell a slot that was already worked.
   */
  it('keeps the time occupied on completed', async () => {
    const appointment = await book();
    // §7 has no booked -> completed edge: a visit that was never checked in
    // cannot have finished. Routing through the real path is the point.
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: TEN_AM });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'completed', actor: STAFF, now: AFTER_END });
    expect(await tenAmOffered()).toBe(false);
  });

  it('keeps the time occupied on no_show', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'no_show', actor: STAFF, now: AFTER_END });
    expect(await tenAmOffered()).toBe(false);
  });

  it('lets a freed slot be booked by somebody else', async () => {
    const first = await book();
    await transitionAppointment(prisma, { appointmentId: first.id, to: 'cancelled', actor: STAFF, now: BEFORE });
    const second = await book({ idempotencyKey: 'second' });
    expect(second.id).not.toBe(first.id);
    expect(second.startAt.toISOString()).toBe(TEN_AM.toISOString());
  });
});

describe('APPT-07 — the event log', () => {
  it('appends one event per transition, with actor and both sides', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'confirmed', actor: CUSTOMER, now: BEFORE });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: BEFORE });

    const events = await prisma.appointmentEvent.findMany({
      where: { appointmentId: appointment.id },
      orderBy: { createdAt: 'asc' },
    });
    // The booking itself wrote the first one (A-009).
    expect(events.map((e) => e.type)).toEqual(['booked', 'status_changed', 'status_changed']);
    expect(events[1]!.actor).toBe('customer_token');
    expect(events[1]!.actorRef).toBe('token-1');
    expect(events[1]!.payload).toMatchObject({ from: 'booked', to: 'confirmed' });
    expect(events[2]!.actor).toBe('staff');
    expect(events[2]!.payload).toMatchObject({ from: 'confirmed', to: 'checked_in' });
  });

  it('records a terminal correction as a correction, not an ordinary change', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'no_show', actor: STAFF, now: AFTER_END });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      actor: STAFF,
      now: AFTER_END,
      reason: 'she was here, I tapped the wrong row',
    });

    const last = await prisma.appointmentEvent.findFirstOrThrow({
      where: { appointmentId: appointment.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(last.type).toBe('status_corrected');
    expect(last.reason).toBe('she was here, I tapped the wrong row');
  });

  it('cannot be rewritten afterwards — the log is append-only by trigger', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled', actor: STAFF, now: BEFORE });
    const event = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: appointment.id } });
    await expect(
      prisma.appointmentEvent.update({ where: { id: event.id }, data: { reason: 'rewritten' } }),
    ).rejects.toThrow();
  });

  it('writes no event when the transition is refused', async () => {
    const appointment = await book();
    const before = await prisma.appointmentEvent.count({ where: { appointmentId: appointment.id } });
    await expect(
      transitionAppointment(prisma, { appointmentId: appointment.id, to: 'completed', actor: STAFF, now: BEFORE }),
    ).rejects.toBeInstanceOf(TransitionRefused);
    expect(await prisma.appointmentEvent.count({ where: { appointmentId: appointment.id } })).toBe(before);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.status).toBe('booked');
  });
});

describe('D-7 — actual timestamps, not scheduled ones', () => {
  it('stamps each arrival step with when it really happened', async () => {
    const appointment = await book();
    const late = at('2026-06-09T10:12:00-05:00');
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: late });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'in_progress',
      actor: STAFF,
      now: at('2026-06-09T10:20:00-05:00'),
    });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'completed', actor: STAFF, now: AFTER_END });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    // Scheduled times are untouched — "she was twelve minutes late" is the
    // difference between the two, and needs both.
    expect(row.startAt.toISOString()).toBe(TEN_AM.toISOString());
    expect(row.checkedInAt?.toISOString()).toBe(late.toISOString());
    expect(row.startedAt?.toISOString()).toBe(at('2026-06-09T10:20:00-05:00').toISOString());
    expect(row.endedAt?.toISOString()).toBe(AFTER_END.toISOString());
  });

  it('clears the arrival timestamps when a completed visit is corrected to a no-show', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: TEN_AM });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'completed', actor: STAFF, now: AFTER_END });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'no_show',
      actor: STAFF,
      now: AFTER_END,
      reason: 'wrong row',
    });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    // A client who never arrived cannot have a check-in time.
    expect(row.checkedInAt).toBeNull();
    expect(row.endedAt).toBeNull();
    // ...and the log still knows they existed.
    const event = await prisma.appointmentEvent.findFirstOrThrow({
      where: { appointmentId: appointment.id, type: 'status_corrected' },
    });
    expect(event.payload).toMatchObject({ clearedCheckedInAt: TEN_AM.toISOString() });
  });

  /** Correcting a no-show to completed must NOT invent an end time: the
   *  correction happens days later, and `now` would be a fabricated
   *  measurement that a utilization report would then average in. */
  it('invents no end time when a no-show is corrected to completed', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'no_show', actor: STAFF, now: AFTER_END });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      actor: STAFF,
      now: at('2026-06-14T09:00:00-05:00'),
      reason: 'she was here',
    });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.status).toBe('completed');
    expect(row.endedAt).toBeNull();
  });
});

describe('D-47 — `now` is a measurement only while the visit is plausibly still happening (A-080)', () => {
  /** THE ITEM'S SCENE. She sat down on Saturday and somebody tapped
   *  "checked in"; nobody ever tapped anything else. `/staff/unfinished`
   *  closes it on Tuesday. The finish time is unknowable, so it stays NULL —
   *  and `checkedInAt` is UNTOUCHED, because that one was a real measurement
   *  taken while she was standing at the desk. */
  it('invents no finish time when a checked-in visit is closed three days later', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: TEN_AM });

    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      actor: STAFF,
      now: at('2026-06-12T09:40:00-05:00'),
    });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.status).toBe('completed');
    expect(row.endedAt).toBeNull();
    expect(row.checkedInAt?.toISOString()).toBe(TEN_AM.toISOString());
  });

  /** The sibling D-46 never reached, and the one the day grid drives: check-in
   *  itself. Tapped days later it is not an arrival time, it is a note about
   *  when somebody remembered. */
  it('invents no arrival or start time when the taps come days late', async () => {
    const appointment = await book();
    const tuesday = at('2026-06-12T09:40:00-05:00');
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: tuesday });
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'in_progress',
      actor: STAFF,
      now: tuesday,
    });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.status).toBe('in_progress');
    expect(row.checkedInAt).toBeNull();
    expect(row.startedAt).toBeNull();
  });

  /** …and the reason the bound is a generous two hours rather than one. A
   *  sixty-minute colour that ran eighty minutes over is the measurement the
   *  owner most wants — throwing it away as "late" would blind the one figure
   *  that says what her colourist's colours really take. */
  it('keeps the finish time of a visit that overran its slot', async () => {
    const appointment = await book();
    const overran = at('2026-06-09T12:20:00-05:00'); // 80 minutes past an 11:00 end.
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'in_progress', actor: STAFF, now: TEN_AM });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'completed', actor: STAFF, now: overran });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.endedAt?.toISOString()).toBe(overran.toISOString());
  });

  /** Confirming is deliberately outside the bound: "she rang on Thursday to
   *  say she is coming" is a true record of a late confirmation, not a guess
   *  about a visit. Here it is the other direction — a confirmation arriving
   *  after the appointment has been and gone still records when it arrived. */
  it('still stamps a confirmation whenever it arrives', async () => {
    const appointment = await book();
    const late = at('2026-06-12T09:40:00-05:00');
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'confirmed', actor: STAFF, now: late });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.confirmedAt?.toISOString()).toBe(late.toISOString());
  });
});

describe('D-19 — the cutoff comes from the rows, most restrictive first', () => {
  it('uses the service cutoff when it demands more notice than the business', async () => {
    // Business says 120 minutes; this service says a full day.
    await prisma.service.update({ where: { id: serviceId }, data: { cancellationCutoffMinutes: 24 * 60 } });
    const appointment = await book();

    // Three hours before: outside the business cutoff, INSIDE the service's.
    const threeHoursBefore = at('2026-06-09T07:00:00-05:00');
    await expect(
      transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'cancelled',
        actor: CUSTOMER,
        now: threeHoursBefore,
      }),
    ).rejects.toMatchObject({ refusal: 'inside-cancellation-cutoff' });

    // The same moment is a legitimate LATE cancellation.
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled_late',
      actor: CUSTOMER,
      now: threeHoursBefore,
    });
    expect(result.to).toBe('cancelled_late');
  });

  it('falls back to the business cutoff when the service defers', async () => {
    const appointment = await book();
    // 121 minutes before start: outside the business's 120.
    const outside = at('2026-06-09T07:59:00-05:00');
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      actor: CUSTOMER,
      now: outside,
    });
    expect(result.to).toBe('cancelled');
  });

  it('lets staff cancel inside the cutoff when the customer cannot', async () => {
    const appointment = await book();
    const inside = at('2026-06-09T09:30:00-05:00');
    await expect(
      transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled', actor: CUSTOMER, now: inside }),
    ).rejects.toMatchObject({ refusal: 'inside-cancellation-cutoff' });
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      actor: STAFF,
      now: inside,
    });
    expect(result.to).toBe('cancelled');
  });
});

describe('two people at the front desk', () => {
  it('lets exactly one of two simultaneous check-ins win, and writes one event', async () => {
    const appointment = await book();
    const attempt = () =>
      transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: TEN_AM });

    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(AppointmentMovedFirst);

    // One status, ONE event. Two events for one real-world act is what makes
    // the detail panel read like a lie.
    expect(
      await prisma.appointmentEvent.count({ where: { appointmentId: appointment.id, type: 'status_changed' } }),
    ).toBe(1);
  });

  it('reports what the appointment actually became when the caller guessed wrong', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled', actor: STAFF, now: BEFORE });

    await expect(
      transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'checked_in',
        actor: STAFF,
        now: TEN_AM,
        expectedFrom: 'booked',
      }),
    ).rejects.toMatchObject({ name: 'AppointmentMovedFirst', expected: 'booked', actual: 'cancelled' });
  });
});

/**
 * A-036 (operator P-5) — A STAFF CANCELLATION TELLS THE CLIENT.
 *
 * The other half of "nothing is silently cancelled, moved or hidden". It lives
 * here rather than at the conflicts screen because this is the ONE place a
 * status is written (A-012), so the detail panel's cancel and the day-grid
 * chip's get it too — patching only the caller the operator named would leave
 * every sibling caller still silent.
 */
describe('A-036 — the cancellation notice', () => {
  const notices = () => prisma.notificationOutbox.findMany({ where: { template: 'appointment.cancelled' } });

  it('enqueues one notice carrying the reason the desk gave', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      actor: STAFF,
      now: BEFORE,
      reason: 'Salon closed Saturday',
    });

    const [notice, ...rest] = await notices();
    expect(rest).toHaveLength(0);
    if (!notice) throw new Error('no notice was enqueued');
    expect(notice.appointmentId).toBe(appointment.id);
    expect(notice.recipient).toBe('5125550101');
    expect(notice.payload).toMatchObject({ reason: 'Salon closed Saturday' });
  });

  /** Inside the cutoff is still a cancellation she has to hear about — the
   *  split is about who wears the cost, not about who gets told. */
  it('tells her about a late cancellation too', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled_late', actor: STAFF, now: TEN_AM });
    expect(await notices()).toHaveLength(1);
  });

  it('sends nothing when the desk says it already rang her', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      actor: STAFF,
      now: BEFORE,
      notify: false,
    });
    expect(await notices()).toHaveLength(0);
  });

  /** She does not need telling what she just did on her own manage link. */
  it('says nothing when the client cancels herself', async () => {
    const appointment = await book();
    // The day before: BEFORE is exactly 120 minutes out, which is the cutoff
    // boundary a customer is refused at and staff walk straight through.
    const dayBefore = at('2026-06-08T08:00:00-05:00');
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled', actor: CUSTOMER, now: dayBefore });
    expect(await notices()).toHaveLength(0);
  });

  /** Only the two statuses that free the slot, derived from the status module
   *  — a check-in is not something to text anybody about. */
  it('says nothing for a status change that is not a cancellation', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: TEN_AM });
    expect(await notices()).toHaveLength(0);
  });

  /** The notice is written in the same transaction as the status, so a
   *  cancellation that lost the race leaves no message promising it won. */
  it('leaves no notice behind when the transition is refused', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled', actor: STAFF, now: BEFORE });

    await expect(
      transitionAppointment(prisma, { appointmentId: appointment.id, to: 'cancelled', actor: STAFF, now: BEFORE }),
    ).rejects.toBeInstanceOf(TransitionRefused);

    expect(await notices()).toHaveLength(1);
  });
});

/**
 * A-037 — THE LOG SAYS WHO, NOT "THE FRONT DESK".
 *
 * `actorRef` has carried the StaffUser id on every mutation since A-005 and
 * nothing could render it, so all four people at the terminal read identically
 * — and the brief's rule is that "who moved this appointment and when" always
 * has an answer.
 */
describe('A-037 — the event log names the person', () => {
  const eventsFor = async (appointmentId: string) =>
    (await loadAppointmentDetail(prisma, { businessId, appointmentId }))!.events;

  it('resolves a staff actorRef to the name on the roster', async () => {
    const { id: priyaId } = await saveStaffMember(prisma, { businessId, name: 'Priya', pin: '4821' });
    const appointment = await book();
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'checked_in',
      actor: staffActor(priyaId),
      now: TEN_AM,
    });

    const changed = (await eventsFor(appointment.id)).find((e) => e.type === 'status_changed');
    expect(changed?.actorName).toBe('Priya');
  });

  /** The reason off-boarding deactivates instead of deleting: the answer has
   *  to outlive the person's last shift. */
  it('still names somebody who has left the roster', async () => {
    const { id: samId } = await saveStaffMember(prisma, { businessId, name: 'Sam', pin: '5150' });
    const appointment = await book();
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'checked_in',
      actor: staffActor(samId),
      now: TEN_AM,
    });
    await saveStaffMember(prisma, { businessId, id: samId, name: 'Sam', active: false });

    const changed = (await eventsFor(appointment.id)).find((e) => e.type === 'status_changed');
    expect(changed?.actorName).toBe('Sam');
  });

  /** A customer's `actorRef` is a manage-token id, not a staff id — looking it
   *  up in the roster must not produce a name, and must not produce a crash. */
  it('names nobody for a customer acting on her own link', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      actor: CUSTOMER,
      now: at('2026-06-08T08:00:00-05:00'),
    });

    const changed = (await eventsFor(appointment.id)).find((e) => e.type === 'status_changed');
    expect(changed?.actorName).toBeNull();
  });

  /** Every event written before this item carries an actorRef that matches no
   *  StaffUser. The log has to keep reading, in the old words. */
  it('falls back for a staff id that is not on any roster', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'checked_in',
      actor: STAFF,
      now: TEN_AM,
    });

    const changed = (await eventsFor(appointment.id)).find((e) => e.type === 'status_changed');
    expect(changed?.actorName).toBeNull();
  });
});

/**
 * A-060 — THE DESK PRESSES ONE BUTTON (APPT-06, D-19).
 *
 * Against the real database because the whole point is that the classification
 * is made from ROWS: the business default, the service that demands more
 * notice, and the clock. A pure test of the derivation cannot see the cutoff
 * being resolved wrongly, which is the way this gets quietly broken.
 */
describe('A-060 — one cancel button, the machine classifies', () => {
  /** 121 minutes before a 10:00 start: outside the business's 120. */
  const OUTSIDE = at('2026-06-09T07:59:00-05:00');
  /** 119 minutes before: inside it. */
  const INSIDE = at('2026-06-09T08:01:00-05:00');

  const payloadOf = async (appointmentId: string) => {
    const event = await prisma.appointmentEvent.findFirstOrThrow({
      where: { appointmentId, type: 'status_changed' },
      orderBy: { createdAt: 'desc' },
    });
    return { ...event, payload: event.payload as Record<string, unknown> };
  };

  it('writes an ordinary cancellation outside the cutoff', async () => {
    const appointment = await book();
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      cancellation: 'derive',
      actor: STAFF,
      now: OUTSIDE,
    });
    expect(result.to).toBe('cancelled');
  });

  it('writes a late cancellation inside it, whatever `to` said', async () => {
    const appointment = await book();
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      // The surface always posts `cancelled`; the machine upgrades it. If this
      // were honoured the whole item would be decorative.
      to: 'cancelled',
      cancellation: 'derive',
      actor: STAFF,
      now: INSIDE,
    });
    expect(result.to).toBe('cancelled_late');
    const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(stored.status).toBe('cancelled_late');
  });

  it('uses the SERVICE cutoff, not the business default (D-19)', async () => {
    await prisma.service.update({ where: { id: serviceId }, data: { cancellationCutoffMinutes: 24 * 60 } });
    const appointment = await book();
    // Outside the business's two hours, well inside the service's full day.
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      cancellation: 'derive',
      actor: STAFF,
      now: OUTSIDE,
    });
    expect(result.to).toBe('cancelled_late');
  });

  it('never derives a status §7 refuses — she is in the chair', async () => {
    const appointment = await book();
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'checked_in', actor: STAFF, now: INSIDE });
    await transitionAppointment(prisma, { appointmentId: appointment.id, to: 'in_progress', actor: STAFF, now: TEN_AM });

    // The clock says "inside the cutoff" and §7 permits `cancelled` only. A
    // walk-out mid-colour must not error, and must not count against her.
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'cancelled',
      cancellation: 'derive',
      actor: STAFF,
      now: TEN_AM,
      reason: 'she walked out',
    });
    expect(result.to).toBe('cancelled');
  });

  describe('the escape beside it', () => {
    it('downgrades a late one and records what it overruled', async () => {
      const appointment = await book();
      const result = await transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'cancelled',
        cancellation: 'override',
        actor: STAFF,
        now: INSIDE,
        reason: 'our fault, we moved her twice',
      });
      expect(result.to).toBe('cancelled');

      const event = await payloadOf(appointment.id);
      expect(event.payload.to).toBe('cancelled');
      // The record is the whole point: without it "we let this one off" is
      // indistinguishable from the cutoff never having applied.
      expect(event.payload.overruled).toBe('cancelled_late');
      expect(event.reason).toBe('our fault, we moved her twice');
    });

    it('refuses without a reason', async () => {
      const appointment = await book();
      await expect(
        transitionAppointment(prisma, {
          appointmentId: appointment.id,
          to: 'cancelled',
          cancellation: 'override',
          actor: STAFF,
          now: INSIDE,
        }),
      ).rejects.toMatchObject({ refusal: 'reason-required' });
      const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      expect(stored.status).toBe('booked');
    });

    it('does NOT demand a reason when there was nothing to overrule', async () => {
      // She gave a fortnight's notice. Pressing the escape is a no-op on the
      // classification, and asking for a reason here would train the desk to
      // type "." into the box that has to mean something.
      const appointment = await book();
      const result = await transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'cancelled',
        cancellation: 'override',
        actor: STAFF,
        now: OUTSIDE,
      });
      expect(result.to).toBe('cancelled');
      expect((await payloadOf(appointment.id)).payload.overruled).toBeUndefined();
    });

    it('leaves nothing on the rolling late-cancel count', async () => {
      const late = await book();
      await transitionAppointment(prisma, {
        appointmentId: late.id,
        to: 'cancelled',
        cancellation: 'derive',
        actor: STAFF,
        now: INSIDE,
      });
      const forgiven = await book({ idempotencyKey: 'forgiven', startAt: at('2026-06-09T13:00:00-05:00') });
      await transitionAppointment(prisma, {
        appointmentId: forgiven.id,
        to: 'cancelled',
        cancellation: 'override',
        actor: STAFF,
        now: at('2026-06-09T12:00:00-05:00'),
        reason: 'Dana was off sick when she rang',
      });

      // `reliability.ts` counts by STATUS alone and cannot tell an overruled
      // cancellation from one that was always on time — which is exactly why
      // the escape has to write `cancelled` rather than annotate
      // `cancelled_late`.
      const counts = await reliabilityFor(prisma, { businessId, clientId, today: DAY });
      expect(counts.lateCancels).toBe(1);
    });
  });

  it('leaves every other transition alone', async () => {
    const appointment = await book();
    const result = await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'confirmed',
      actor: STAFF,
      now: BEFORE,
    });
    expect(result.to).toBe('confirmed');
    expect((await payloadOf(appointment.id)).payload.overruled).toBeUndefined();
  });
});
