/**
 * A-020 against a real database (CLIENT-04, D-27).
 *
 * The counters are DERIVED, so the interesting cases are all about what the
 * window includes rather than about any stored number: the day the window
 * opens, the late cancellation whose appointment is still in the future, and
 * the household (D-17) whose two members must be counted separately.
 *
 * Every appointment here is written directly rather than booked: these are in
 * the PAST, which the write path refuses by design, and the alternative would
 * be a clock the test does not own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { clientReliability, missedAppointments, reliabilityFor } from './reliability';
import { mergeClients } from './clients';

const prisma = new PrismaClient();

const at = (iso: string) => toDate(instantFromIso(iso));

/** The day every test asks the question on. Fixed, so the window's edges are
 *  fixed too — a test that asked "today" would drift out of its own fixtures. */
const TODAY = '2026-08-19';

const SHARED_PHONE = '5125550101';

let businessId: string;
let providerId: string;
let serviceId: string;
let mumId: string;
let daughterId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const business = await prisma.business.create({
    data: { name: 'Shear Genius', timezone: 'America/Chicago' },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = dana.id;
  const cut = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 },
  });
  serviceId = cut.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId: cut.id, providerId: dana.id } });

  // D-17's household: one number, two people, two counters.
  mumId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: SHARED_PHONE } })).id;
  daughterId = (await prisma.client.create({ data: { businessId, name: 'Mei Chen', phone: SHARED_PHONE } })).id;
});

/** An appointment in whatever state, on a given business day. */
async function history(options: { clientId: string; day: string; status: string; hour?: string }) {
  const hour = options.hour ?? '15:00';
  const startAt = at(`${options.day}T${hour}:00-05:00`);
  const endAt = at(`${options.day}T${hour === '15:00' ? '16:00' : '17:00'}:00-05:00`);
  const appointment = await prisma.appointment.create({
    data: {
      businessId,
      providerId,
      clientId: options.clientId,
      status: options.status as 'no_show',
      startAt,
      endAt,
      blockedStart: startAt,
      blockedEnd: endAt,
      startDay: options.day,
      startWallTime: hour,
      lines: {
        create: { businessId, serviceId, ordinal: 0, priceCents: 5500, durationMinutes: 60 },
      },
    },
  });
  return appointment.id;
}

const countsFor = (clientId: string, today = TODAY) =>
  reliabilityFor(prisma, { businessId, clientId, today });

describe('the rolling counters (CLIENT-04)', () => {
  it('counts no-shows and late cancels separately, and leaves everything else out', async () => {
    await history({ clientId: mumId, day: '2026-03-10', status: 'no_show' });
    await history({ clientId: mumId, day: '2026-04-14', status: 'no_show' });
    await history({ clientId: mumId, day: '2026-05-12', status: 'cancelled_late' });
    // Neither of these is a missed appointment: one happened, and one was
    // cancelled with the notice the salon asks for.
    await history({ clientId: mumId, day: '2026-06-09', status: 'completed' });
    await history({ clientId: mumId, day: '2026-07-07', status: 'cancelled' });

    expect(await countsFor(mumId)).toMatchObject({ noShows: 2, lateCancels: 1 });
  });

  /**
   * THE WINDOW EDGE, asserted on both sides of one day. A no-show exactly a
   * year ago is still inside the rolling 12 months; the day before it has aged
   * out. This is the boundary a client argues about at the desk.
   */
  it('includes the first day of the window and excludes the day before it', async () => {
    await history({ clientId: mumId, day: '2025-08-19', status: 'no_show' });
    expect((await countsFor(mumId)).noShows).toBe(1);

    await history({ clientId: daughterId, day: '2025-08-18', status: 'no_show' });
    expect((await countsFor(daughterId)).noShows).toBe(0);
  });

  /**
   * A late cancellation is made INSIDE the cutoff, so the appointment it
   * belongs to is usually still in the FUTURE when it is counted. Capping the
   * window at today would drop exactly the one the front desk is looking at.
   */
  it('counts a late cancellation of an appointment that has not happened yet', async () => {
    await history({ clientId: mumId, day: '2026-08-22', status: 'cancelled_late' });
    expect((await countsFor(mumId)).lateCancels).toBe(1);
  });

  /** D-17, the whole reason the phone number is not unique: the daughter's
   *  no-shows must not block the mother. */
  it('counts each member of a household separately', async () => {
    await history({ clientId: daughterId, day: '2026-03-10', status: 'no_show' });
    await history({ clientId: daughterId, day: '2026-04-14', status: 'no_show' });
    await history({ clientId: daughterId, day: '2026-05-12', status: 'no_show' });

    expect((await countsFor(daughterId)).selfServeBlocked).toBe(true);
    expect(await countsFor(mumId)).toMatchObject({ noShows: 0, selfServeBlocked: false });
  });

  it('never counts another salon’s appointments', async () => {
    const rival = await prisma.business.create({ data: { name: 'Rival', timezone: 'America/Chicago' } });
    await prisma.client.create({ data: { businessId: rival.id, name: 'Ada Chen', phone: SHARED_PHONE } });
    await history({ clientId: mumId, day: '2026-03-10', status: 'no_show' });

    const counts = await clientReliability(prisma, { businessId: rival.id, clientIds: [mumId], today: TODAY });
    expect(counts.get(mumId)!.noShows).toBe(0);
  });

  it('answers for several clients in one call, including the ones with nothing', async () => {
    await history({ clientId: mumId, day: '2026-03-10', status: 'no_show' });

    const counts = await clientReliability(prisma, {
      businessId,
      clientIds: [mumId, daughterId],
      today: TODAY,
    });
    expect(counts.get(mumId)!.noShows).toBe(1);
    // Present, not absent: a surface asking about a client with a clean record
    // must get an answer rather than an undefined it has to interpret.
    expect(counts.get(daughterId)).toMatchObject({ noShows: 0, lateCancels: 0, selfServeBlocked: false });
  });

  /** A-015's merge moves the appointments to the survivor, so the counters
   *  follow with no code of their own — and two half-counts become one true
   *  one, which is the point of merging. */
  it('follows a merge: the survivor carries both records’ misses', async () => {
    await history({ clientId: mumId, day: '2026-03-10', status: 'no_show' });
    await history({ clientId: daughterId, day: '2026-04-14', status: 'no_show' });

    await mergeClients(prisma, { businessId, survivorId: mumId, losingId: daughterId });

    expect((await countsFor(mumId)).noShows).toBe(2);
  });
});

describe('the block (CLIENT-04, D-27)', () => {
  it('blocks self-serve at the salon’s threshold and not before it', async () => {
    await history({ clientId: mumId, day: '2026-03-10', status: 'no_show' });
    await history({ clientId: mumId, day: '2026-04-14', status: 'no_show' });
    expect((await countsFor(mumId)).selfServeBlocked).toBe(false);

    await history({ clientId: mumId, day: '2026-05-12', status: 'no_show' });
    expect((await countsFor(mumId)).selfServeBlocked).toBe(true);
  });

  /** Late cancels are COUNTED and SHOWN, but they do not block: the PRD's
   *  lever is "after N no-shows", and blocking on late cancels would punish
   *  the client who did the more considerate thing. */
  it('does not block on late cancellations, however many', async () => {
    for (const day of ['2026-03-10', '2026-04-14', '2026-05-12', '2026-06-09']) {
      await history({ clientId: mumId, day, status: 'cancelled_late' });
    }
    expect(await countsFor(mumId)).toMatchObject({ lateCancels: 4, selfServeBlocked: false });
  });

  it('follows the salon’s own threshold when the owner changes it', async () => {
    await history({ clientId: mumId, day: '2026-03-10', status: 'no_show' });
    await prisma.business.update({ where: { id: businessId }, data: { noShowBlockThreshold: 1 } });

    expect(await countsFor(mumId)).toMatchObject({ threshold: 1, selfServeBlocked: true });
  });

  it('treats a threshold of zero as the lever switched off', async () => {
    await history({ clientId: mumId, day: '2026-03-10', status: 'no_show' });
    await history({ clientId: mumId, day: '2026-04-14', status: 'no_show' });
    await prisma.business.update({ where: { id: businessId }, data: { noShowBlockThreshold: 0 } });

    expect((await countsFor(mumId)).selfServeBlocked).toBe(false);
  });
});

describe('the references (CLIENT-04)', () => {
  it('names each missed appointment, newest first, with a link to it', async () => {
    const older = await history({ clientId: mumId, day: '2026-03-10', status: 'no_show' });
    const newer = await history({ clientId: mumId, day: '2026-05-12', status: 'cancelled_late' });
    await history({ clientId: mumId, day: '2026-06-09', status: 'completed' });

    const missed = await missedAppointments(prisma, { businessId, clientId: mumId, today: TODAY });

    expect(missed.map((m) => m.appointmentId)).toEqual([newer, older]);
    expect(missed[0]).toMatchObject({
      startDay: '2026-05-12',
      status: 'cancelled_late',
      providerName: 'Dana',
      services: ['Cut'],
    });
  });

  it('leaves out the ones that have aged out of the window', async () => {
    await history({ clientId: mumId, day: '2025-08-18', status: 'no_show' });
    expect(await missedAppointments(prisma, { businessId, clientId: mumId, today: TODAY })).toEqual([]);
  });
});
