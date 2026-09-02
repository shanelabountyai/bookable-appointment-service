/**
 * A-072 — who has already been offered this freed slot (WAIT-02, D-37(b)).
 *
 * The two assertions that carry the item are the two it is defined by: the
 * mark is a RECORD and not a hold, so the slot stays bookable by anybody
 * throughout; and it SENDS NOTHING, which is what keeps it on the right side
 * of OQ-4's still-blocked soft-hold offer and nowhere near `deliveryWord()`
 * (D-41).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor, systemActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { clearFreedOffer, listFreedOffers, recordFreedOffer } from './offers';

const prisma = new PrismaClient();
const STAFF_WINDOW = { createdByActor: 'staff' as const, actorRef: 'staff-1' };

const at = (iso: string) => toDate(instantFromIso(iso));
const NOW = at('2026-06-08T08:00:00-05:00');
const TWO = at('2026-06-09T14:00:00-05:00');

let businessId: string;
let providerId: string;
let cutId: string;
let patelId: string;
let hallId: string;
let appointmentId: string;
let staffId: string;
let STAFF: ReturnType<typeof staffActor>;

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
      slotIntervalMinutes: 30,
      minimumLeadMinutes: 0,
      cancellationCutoffMinutes: 120,
      bookingHorizonDays: 365,
    },
  });
  businessId = business.id;
  providerId = (await prisma.provider.create({ data: { businessId, displayName: 'Dana' } })).id;
  cutId = (
    await prisma.service.create({ data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500 } })
  ).id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId: cutId, providerId } });

  patelId = (await prisma.client.create({ data: { businessId, name: 'Mrs Patel', phone: '5125550111' } })).id;
  hallId = (await prisma.client.create({ data: { businessId, name: 'Mrs Hall', phone: '5125550222' } })).id;

  // D-9: "who rang her?" has to have an answer, and the name has to resolve.
  staffId = (
    await prisma.staffUser.create({
      data: { businessId, name: 'Priya', email: 'priya@example.test', passwordHash: 'x', role: 'staff' },
    })
  ).id;
  STAFF = staffActor(staffId);

  await createWeeklyWindow(
    prisma,
    { businessId, providerId: null, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
    STAFF_WINDOW,
  );
  await createWeeklyWindow(
    prisma,
    { businessId, providerId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false },
    STAFF_WINDOW,
  );

  const appointment = await bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [cutId],
    clientId: hallId,
    startAt: TWO,
    now: NOW,
    actor: systemActor,
    audience: 'staff',
  } as Parameters<typeof bookAppointment>[1]);
  appointmentId = appointment.id;
});

const KEY = () => `cancelled:${appointmentId}`;

const offer = (clientId: string, outcome: 'no_answer' | 'left_message' | 'thinking' | 'took_it') =>
  recordFreedOffer(prisma, { businessId, freedKey: KEY(), appointmentId, clientId, outcome, actor: STAFF });

const listed = async () => (await listFreedOffers(prisma, { businessId, freedKeys: [KEY()] })).get(KEY()) ?? [];

describe('the mark', () => {
  it('records who was asked, what she said, and who asked her', async () => {
    const recorded = await offer(patelId, 'thinking');

    expect(recorded).toMatchObject({ clientId: patelId, clientName: 'Mrs Patel', outcome: 'thinking' });
    // D-9. "The front desk" is four people, and at 4pm that is not an answer.
    expect(recorded!.offeredByName).toBe('Priya');
    expect(await listed()).toHaveLength(1);
  });

  /** A-061's shape, reused rather than re-invented: the useful fact is the
   *  most recent attempt, not a history of them. */
  it('RE-STAMPS a second call rather than appending', async () => {
    await offer(patelId, 'no_answer');
    await offer(patelId, 'thinking');

    const rows = await listed();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('thinking');
  });

  it('keeps two clients apart on the same slot', async () => {
    await offer(patelId, 'thinking');
    await offer(hallId, 'no_answer');

    expect((await listed()).map((row) => row.outcome).sort()).toEqual(['no_answer', 'thinking']);
  });

  /** A mis-tap on a SHARED screen marks the wrong client as asked, which
   *  silently skips her — the harm this exists to prevent, inverted. */
  it('is a toggle, not a one-way tick', async () => {
    await offer(patelId, 'left_message');
    await clearFreedOffer(prisma, { businessId, freedKey: KEY(), clientId: patelId });

    expect(await listed()).toHaveLength(0);
  });

  it('refuses a client from another business', async () => {
    const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
    const stranger = await prisma.client.create({ data: { businessId: other.id, name: 'Nobody' } });

    expect(
      await recordFreedOffer(prisma, {
        businessId,
        freedKey: KEY(),
        appointmentId,
        clientId: stranger.id,
        outcome: 'thinking',
        actor: STAFF,
      }),
    ).toBeNull();
    expect(await listed()).toHaveLength(0);
  });
});

describe('what makes it a RECORD and not a hold (D-37(b))', () => {
  /** THE DEFINING PROPERTY, and the reason this is buildable while OQ-4's
   *  soft-hold offer is correctly still blocked. */
  it('leaves the slot bookable by anybody, including somebody else', async () => {
    await offer(patelId, 'thinking');

    // The freed 15:00 is still there for whoever rings next.
    const walkIn = await bookAppointment(prisma, {
      businessId,
      providerId,
      serviceIds: [cutId],
      clientId: null,
      startAt: at('2026-06-09T15:00:00-05:00'),
      now: NOW,
      actor: STAFF,
      audience: 'staff',
    } as Parameters<typeof bookAppointment>[1]);

    expect(walkIn.id).toBeTruthy();
    // …and the mark is untouched by the booking. Nothing clears it, because
    // nothing has to: `/staff/opened` is derived and simply stops reading it.
    expect(await listed()).toHaveLength(1);
  });

  /** D-41's line, held: it sends nothing, and it must appear nowhere near
   *  `deliveryWord()`. A-059 and A-061 assert the same thing about their own
   *  marks, for the same reason. */
  it('sends nothing at all', async () => {
    const sent = await prisma.notificationOutbox.count();

    await offer(patelId, 'left_message');
    await offer(hallId, 'took_it');
    await clearFreedOffer(prisma, { businessId, freedKey: KEY(), clientId: hallId });

    expect(await prisma.notificationOutbox.count()).toBe(sent);
  });
});

describe('the key it hangs off', () => {
  /** A span freed twice is two rounds of phone calls. The key A-067 derives
   *  differs, so the second round starts clean with no clearing code. */
  it('keeps two freed spans of one appointment apart', async () => {
    await offer(patelId, 'thinking');
    await recordFreedOffer(prisma, {
      businessId,
      freedKey: `services_changed:${appointmentId}-later`,
      appointmentId,
      clientId: patelId,
      outcome: 'no_answer',
      actor: STAFF,
    });

    const both = await listFreedOffers(prisma, {
      businessId,
      freedKeys: [KEY(), `services_changed:${appointmentId}-later`],
    });
    expect(both.get(KEY())![0]!.outcome).toBe('thinking');
    expect(both.get(`services_changed:${appointmentId}-later`)![0]!.outcome).toBe('no_answer');
  });

  it('returns an empty map for a slot nobody has been asked about', async () => {
    expect(await listFreedOffers(prisma, { businessId, freedKeys: [] })).toEqual(new Map());
    expect((await listFreedOffers(prisma, { businessId, freedKeys: [KEY()] })).size).toBe(0);
  });
});
