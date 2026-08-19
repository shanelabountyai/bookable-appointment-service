/**
 * A-020 — CLIENT-04's block, at the write path (D-27).
 *
 * The block lives in `bookAppointment` and not on the booking screen, for the
 * same reason the cancellation cutoff lives in the transition table: a rule
 * enforced by a form is a rule that is not enforced. The customer flow, a
 * hand-made POST and a future API client all go through this one function.
 *
 * `audience` is the whole of the staff bypass. There is no `bypassBlock` flag
 * and there is not going to be one — the front desk is already the
 * unrestricted caller (operator S-3), and a second way to say "staff" is a
 * second thing to get wrong.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { staffActor, systemActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from './book';
import { SelfServeBlocked } from './errors';

const prisma = new PrismaClient();
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const STAFF = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));

/** A Monday morning, with the appointment on the Tuesday. Frozen: the rolling
 *  window's edges and the lead time both hang off it. */
const NOW = at('2026-08-17T08:00:00-05:00');
const SLOT = at('2026-08-18T10:00:00-05:00');

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
    data: { name: 'Shear Genius', timezone: 'America/Chicago', minimumLeadMinutes: 0 },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = dana.id;
  const cut = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 },
  });
  serviceId = cut.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId: cut.id, providerId: dana.id } });
  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;

  // Tuesday, 09:00–17:00 — the salon's hours and Dana's own inside them.
  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false },
    STAFF_WINDOW,
  );
  await createWeeklyWindow(
    prisma,
    { businessId, providerId: dana.id, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
    STAFF_WINDOW,
  );
});

/** No-shows in the past, written directly — the write path refuses to book
 *  backwards, which is the behaviour under test everywhere else. */
async function noShows(count: number, options: { status?: string; days?: string[] } = {}) {
  const days = options.days ?? ['2026-03-10', '2026-04-14', '2026-05-12', '2026-06-09'];
  for (const day of days.slice(0, count)) {
    const startAt = at(`${day}T15:00:00-05:00`);
    const endAt = at(`${day}T16:00:00-05:00`);
    await prisma.appointment.create({
      data: {
        businessId,
        providerId,
        clientId,
        status: (options.status ?? 'no_show') as 'no_show',
        startAt,
        endAt,
        blockedStart: startAt,
        blockedEnd: endAt,
        startDay: day,
        startWallTime: '15:00',
        lines: { create: { businessId, serviceId, ordinal: 0, priceCents: 5500, durationMinutes: 60 } },
      },
    });
  }
}

const book = (over: Record<string, unknown> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    clientId,
    startAt: SLOT,
    now: NOW,
    actor: systemActor,
    audience: 'public',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

describe('the self-serve block (CLIENT-04)', () => {
  it('refuses a customer at the threshold, carrying the counts for the log', async () => {
    await noShows(3);

    const error = await book().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SelfServeBlocked);
    expect(error).toMatchObject({ noShows: 3, threshold: 3 });
    expect(await prisma.appointment.count({ where: { status: 'booked' } })).toBe(0);
  });

  it('lets her book herself one below the threshold', async () => {
    await noShows(2);
    await expect(book()).resolves.toMatchObject({ status: 'booked' });
  });

  /** The block counts NO-SHOWS. A client who rings an hour before, four times,
   *  is flagged to staff and not shut out of the website. */
  it('does not refuse on late cancellations', async () => {
    await noShows(4, { status: 'cancelled_late' });
    await expect(book()).resolves.toMatchObject({ status: 'booked' });
  });

  /** The window is rolling, so old misses stop counting on their own — there
   *  is no forgiveness job to run and none to forget to run. */
  it('lets her back in once the old no-shows age out of the window', async () => {
    // Three of them, all older than the window — they still OCCUPY their own
    // times (D-7), so they need three different days rather than one.
    await noShows(3, { days: ['2025-01-06', '2025-02-03', '2025-03-03'] });

    await expect(book()).resolves.toMatchObject({ status: 'booked' });
  });

  /** BOOK-04's walk-in: no client record, so nothing to count and nothing to
   *  block. A null client must not be treated as a client with zero history —
   *  it must not be treated as a client at all. */
  it('never blocks a booking with no client record', async () => {
    await noShows(3);
    await expect(book({ clientId: null })).resolves.toMatchObject({ status: 'booked' });
  });
});

describe('the staff bypass (D-27)', () => {
  it('books her anyway, and puts the flag on the record', async () => {
    await noShows(3);

    const appointment = await book({ audience: 'staff', actor: STAFF });

    const event = await prisma.appointmentEvent.findFirstOrThrow({
      where: { appointmentId: appointment.id, type: 'booked' },
    });
    // The OWNER's question — "who did we book over a flag?" — has an answer
    // in the log rather than in somebody's memory.
    expect(event.payload).toMatchObject({ overNoShowFlag: { noShows: 3, threshold: 3 } });
  });

  /** The clause is written only when the flag was actually showing. An
   *  ordinary booking carrying an `overNoShowFlag: false` would make the
   *  owner's report count every booking in the salon. */
  it('writes nothing extra on an ordinary staff booking', async () => {
    const appointment = await book({ audience: 'staff', actor: STAFF });

    const event = await prisma.appointmentEvent.findFirstOrThrow({
      where: { appointmentId: appointment.id, type: 'booked' },
    });
    expect(event.payload).not.toHaveProperty('overNoShowFlag');
  });
});
