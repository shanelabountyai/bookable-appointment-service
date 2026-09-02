/**
 * A-073 — the clients who have stopped coming (RPT-01, CLIENT-02).
 *
 * Almost every test here is an EXCLUSION, on purpose. The list's value is
 * entirely in who is NOT on it: an owner who rings a client with a colour on
 * Thursday, or a client the salon has blocked from booking online, stops
 * trusting the list after one afternoon — and a list nobody trusts is the
 * client record being read one page at a time again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { LAPSED_WEEKS, listLapsedClients } from './lapsed';

const prisma = new PrismaClient();
const at = (iso: string) => toDate(instantFromIso(iso));

/** Frozen, and every fixture is relative to it (CLAUDE.md). */
const NOW = at('2026-06-09T10:00:00-05:00');
/** Comfortably past the twelve-week default. */
const LONG_AGO = at('2026-01-06T10:00:00-05:00');
/** Three weeks ago — inside it. */
const RECENTLY = at('2026-05-19T10:00:00-05:00');

let businessId: string;
let providerId: string;
let cutId: string;
let colourId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  seeded = 0;
  const business = await prisma.business.create({ data: { name: 'Shear Genius', timezone: 'America/Chicago' } });
  businessId = business.id;
  providerId = (await prisma.provider.create({ data: { businessId, displayName: 'Dana' } })).id;
  cutId = (
    await prisma.service.create({ data: { businessId, name: 'Cut', durationMinutes: 45, priceCents: 5500 } })
  ).id;
  colourId = (
    await prisma.service.create({ data: { businessId, name: 'Colour', durationMinutes: 90, priceCents: 12000 } })
  ).id;
});

async function client(name: string, phone = '5125550101') {
  return (await prisma.client.create({ data: { businessId, name, phone } })).id;
}

/**
 * Written directly: the point of every fixture is one axis (when she last
 * came, what is in the book, whether she is flagged), and `bookAppointment`
 * would drag windows and lead times in.
 *
 * EVERY VISIT GETS ITS OWN HOUR. One provider and one instant is one
 * appointment — `appointment_block_no_overlap` says so — so two clients seeded
 * "long ago" collide, and the failure reads as a Prisma error rather than as a
 * fixture that asked for something impossible. The counter is the cheapest
 * thing that cannot collide, and the hour is never what any of these tests
 * assert on.
 */
let seeded = 0;

async function visit(options: {
  clientId: string;
  startAt: Date;
  status?: string;
  serviceId?: string;
  priceCents?: number;
}) {
  const startAt = toDate(instant(fromDate(options.startAt) + seeded++ * 60 * 60_000));
  const endAt = toDate(instant(fromDate(startAt) + 45 * 60_000));
  return prisma.appointment.create({
    data: {
      businessId,
      providerId,
      clientId: options.clientId,
      status: (options.status ?? 'completed') as 'completed',
      startAt,
      endAt,
      blockedStart: startAt,
      blockedEnd: endAt,
      startDay: '2026-01-06',
      startWallTime: '10:00',
      lines: {
        create: {
          businessId,
          serviceId: options.serviceId ?? cutId,
          ordinal: 0,
          priceCents: options.priceCents ?? 5500,
          durationMinutes: 45,
        },
      },
    },
  });
}

const list = (weeks?: number) =>
  listLapsedClients(prisma, { businessId, now: NOW, ...(weeks === undefined ? {} : { weeks }) });

describe('who is on it', () => {
  it('lists a client whose last completed visit is past the cutoff, with the call in front of the owner', async () => {
    const ada = await client('Ada Chen');
    await visit({ clientId: ada, startAt: LONG_AGO, serviceId: colourId, priceCents: 14000 });

    const [row, ...rest] = await list();

    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      clientId: ada,
      name: 'Ada Chen',
      phone: '5125550101',
      lastProviderName: 'Dana',
      lastServiceNames: ['Colour'],
      // Her OWN line price (D-16) — the catalogue has moved since, and "she
      // was worth $140" has to mean what she actually paid.
      lastSpendCents: 14000,
    });
    expect(row!.weeksSince).toBe(22);
  });

  it('orders longest-lapsed first — that is the one you have most likely lost', async () => {
    const older = await client('Older Olive');
    const newer = await client('Newer Nell');
    await visit({ clientId: older, startAt: at('2025-11-04T10:00:00-06:00') });
    await visit({ clientId: newer, startAt: LONG_AGO });

    expect((await list()).map((row) => row.name)).toEqual(['Older Olive', 'Newer Nell']);
  });

  /** N is a number ON THE REPORT, not a setting nobody will tune: a six-week
   *  cycle and a twelve-week one both want to slide it while looking. */
  it('takes the cutoff as an argument, and defaults to twelve weeks', async () => {
    const ada = await client('Ada Chen');
    await visit({ clientId: ada, startAt: RECENTLY });

    expect(LAPSED_WEEKS).toBe(12);
    expect(await list()).toHaveLength(0);
    // Three weeks ago is lapsed at a two-week cutoff.
    expect(await list(2)).toHaveLength(1);
  });
});

describe('who is deliberately NOT on it', () => {
  it('drops a client with something in the book ahead — ringing her is the careless call', async () => {
    const ada = await client('Ada Chen');
    await visit({ clientId: ada, startAt: LONG_AGO });
    await visit({ clientId: ada, startAt: at('2026-06-16T10:00:00-05:00'), status: 'booked' });

    expect(await list()).toHaveLength(0);
  });

  /** …and a CANCELLED future appointment does not save her: she is exactly
   *  the person to ring. Derived from the status module, never hand-typed. */
  it('keeps a client whose only future appointment was cancelled', async () => {
    const ada = await client('Ada Chen');
    await visit({ clientId: ada, startAt: LONG_AGO });
    await visit({ clientId: ada, startAt: at('2026-06-16T10:00:00-05:00'), status: 'cancelled' });

    expect(await list()).toHaveLength(1);
  });

  /** The row's own words: "a no-show-blocked client is not who you ring to
   *  fill a Tuesday". */
  it('drops a client who has missed something in the last twelve months', async () => {
    const ada = await client('Ada Chen');
    await visit({ clientId: ada, startAt: LONG_AGO });
    await visit({ clientId: ada, startAt: at('2026-03-03T10:00:00-06:00'), status: 'no_show' });

    expect(await list()).toHaveLength(0);
  });

  /**
   * "Last visit" is computed from `completed` ALONE. A recent appointment she
   * did not attend must not make her look like somebody who was in three weeks
   * ago — that would hide the client this report exists to surface behind the
   * very evidence that she has stopped coming.
   *
   * Proved with a CANCELLATION rather than a no-show, deliberately: a no-show
   * also flags her, so it would pass through the exclusion above and prove
   * nothing about the arithmetic.
   */
  it('counts only completed visits as visits', async () => {
    const beth = await client('Beth Waits', '5125550199');
    await visit({ clientId: beth, startAt: LONG_AGO });
    await visit({ clientId: beth, startAt: RECENTLY, status: 'cancelled' });

    const [row] = await list();
    expect(row!.name).toBe('Beth Waits');
    // Her January visit, not her May cancellation.
    expect(row!.weeksSince).toBeGreaterThan(20);
  });

  it('drops a client who has been merged away — a tombstone is not somebody to ring', async () => {
    const survivor = await client('Ada Chen');
    const loser = await client('Ada C', '5125550101');
    await visit({ clientId: loser, startAt: LONG_AGO });
    await prisma.client.update({ where: { id: loser }, data: { mergedIntoClientId: survivor } });

    expect(await list()).toHaveLength(0);
  });

  it('drops a client who has never completed anything at all', async () => {
    const ada = await client('Ada Chen');
    await visit({ clientId: ada, startAt: LONG_AGO, status: 'cancelled' });

    expect(await list()).toHaveLength(0);
  });

  it('is scoped to the business', async () => {
    const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
    const ada = await client('Ada Chen');
    await visit({ clientId: ada, startAt: LONG_AGO });

    expect(await listLapsedClients(prisma, { businessId: other.id, now: NOW })).toHaveLength(0);
  });
});
