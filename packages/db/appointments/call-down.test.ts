/**
 * A-021 against a real database (APPT-02).
 *
 * The list is DERIVED from `status`, so the interesting case is which
 * statuses count as "not yet confirmed" — `booked` and nothing else, in
 * particular not `confirmed` itself and not any of the ways an appointment
 * can already be off tomorrow's book.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { saveStaffMember } from '../auth';
import { staffActor } from '../../core/auth';
import { clearCallAttempt, listUnconfirmedTomorrow, recordCallAttempt } from './call-down';

const prisma = new PrismaClient();

const at = (iso: string) => toDate(instantFromIso(iso));

const TOMORROW = '2026-08-20';
const ELSEWHERE = '2026-08-21';

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

  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;
});

async function seed(options: { day: string; status: string; hour: string }) {
  const startAt = at(`${options.day}T${options.hour}:00-05:00`);
  const endAt = at(`${options.day}T${options.hour === '09:00' ? '10:00' : '16:00'}:00-05:00`);
  return prisma.appointment.create({
    data: {
      businessId,
      providerId,
      clientId,
      status: options.status as 'booked',
      startAt,
      endAt,
      blockedStart: startAt,
      blockedEnd: endAt,
      startDay: options.day,
      startWallTime: options.hour,
      lines: { create: { businessId, serviceId, ordinal: 0, priceCents: 5500, durationMinutes: 60 } },
    },
  });
}

describe('listUnconfirmedTomorrow', () => {
  it('finds a booked appointment on the given day', async () => {
    await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });

    const rows = await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerName: 'Dana',
      clientName: 'Ada Chen',
      clientPhone: '5125550101',
      serviceNames: ['Cut'],
    });
  });

  it('excludes confirmed — she already had her call', async () => {
    await seed({ day: TOMORROW, status: 'confirmed', hour: '15:00' });

    expect(await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW })).toHaveLength(0);
  });

  it.each(['cancelled', 'cancelled_late', 'no_show', 'completed'])(
    'excludes %s — not tomorrow’s problem anymore',
    async (status) => {
      await seed({ day: TOMORROW, status, hour: '15:00' });

      expect(await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW })).toHaveLength(0);
    },
  );

  it('excludes a booked appointment on a different day', async () => {
    await seed({ day: ELSEWHERE, status: 'booked', hour: '15:00' });

    expect(await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW })).toHaveLength(0);
  });

  it('sorts by time', async () => {
    await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });
    await seed({ day: TOMORROW, status: 'booked', hour: '09:00' });

    const rows = await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW });

    expect(rows.map((r) => r.startAt.getTime())).toEqual([...rows.map((r) => r.startAt.getTime())].sort((a, b) => a - b));
    expect(rows[0]!.startAt.getTime()).toBeLessThan(rows[1]!.startAt.getTime());
  });
});

/**
 * A-061 — "we already rang her" (APPT-02).
 *
 * The exception to operator R-7, and the tests below are mostly about keeping
 * it an exception: the mark is stored because nothing else can produce it, and
 * everything about WHEN IT IS VISIBLE stays derived.
 */
describe('A-061 — the record of who has been rung', () => {
  let priya: string;

  beforeEach(async () => {
    priya = (await saveStaffMember(prisma, { businessId, name: 'Priya', pin: '4321' })).id;
  });

  const list = () => listUnconfirmedTomorrow(prisma, { businessId, tomorrow: TOMORROW });

  it('is null until somebody rings', async () => {
    await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });

    expect((await list())[0]!.attempt).toBeNull();
  });

  it('survives the next read, with the outcome, the person and the time', async () => {
    const appointment = await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });

    await recordCallAttempt(prisma, {
      businessId,
      appointmentId: appointment.id,
      outcome: 'no_answer',
      actor: staffActor(priya),
    });

    const row = (await list())[0]!;
    expect(row.attempt).toMatchObject({ outcome: 'no_answer', triedByName: 'Priya' });
    expect(row.attempt!.triedAt).toBeInstanceOf(Date);
  });

  it('RE-STAMPS rather than appending — no answer at 2, left a message at 4', async () => {
    const appointment = await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });

    for (const outcome of ['no_answer', 'left_message'] as const) {
      await recordCallAttempt(prisma, { businessId, appointmentId: appointment.id, outcome, actor: staffActor(priya) });
    }

    // One row, and its state is the LATEST call — which is the fact the next
    // person at the desk needs.
    expect(await prisma.callDownAttempt.count()).toBe(1);
    expect((await list())[0]!.attempt).toMatchObject({ outcome: 'left_message' });
  });

  it('does not disturb the time order (D-37(b))', async () => {
    const three = await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });
    await seed({ day: TOMORROW, status: 'booked', hour: '09:00' });

    await recordCallAttempt(prisma, {
      businessId,
      appointmentId: three.id,
      outcome: 'no_answer',
      actor: staffActor(priya),
    });

    const rows = await list();
    // The tried row is still SECOND, because it is still at three o'clock. A
    // list that re-sorted would move rows under the cursor of the person
    // pressing the buttons.
    expect(rows.map((r) => r.attempt?.outcome ?? null)).toEqual([null, 'no_answer']);
  });

  it('can be undone — a mis-tap otherwise silently skips a client', async () => {
    const appointment = await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });
    await recordCallAttempt(prisma, {
      businessId,
      appointmentId: appointment.id,
      outcome: 'no_answer',
      actor: staffActor(priya),
    });

    await clearCallAttempt(prisma, { businessId, appointmentId: appointment.id });

    expect((await list())[0]!.attempt).toBeNull();
  });

  describe('"cleared when the appointment confirms or the day rolls" needs no clearing code', () => {
    it('goes with her when she confirms, because the row leaves the list', async () => {
      const appointment = await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });
      await recordCallAttempt(prisma, {
        businessId,
        appointmentId: appointment.id,
        outcome: 'left_message',
        actor: staffActor(priya),
      });

      await prisma.appointment.update({ where: { id: appointment.id }, data: { status: 'confirmed' } });

      expect(await list()).toHaveLength(0);
    });

    it('does NOT follow a reschedule to another day', async () => {
      const appointment = await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });
      await recordCallAttempt(prisma, {
        businessId,
        appointmentId: appointment.id,
        outcome: 'no_answer',
        actor: staffActor(priya),
      });

      // D-6: reschedule is a same-row UPDATE, so the appointment keeps its id
      // and its attempt row. Without `forDay` the desk would open next
      // fortnight's call-down and read a "no answer" from today.
      //
      // `endAt` moves with it: `seed()` books a 1-hour visit, and
      // `appointment_end_after_start` is enforced on every row regardless of
      // which columns an UPDATE names — a start-only move leaves the OLD
      // (earlier) end in place and the constraint rejects the write.
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          startDay: ELSEWHERE,
          startAt: at(`${ELSEWHERE}T15:00:00-05:00`),
          endAt: at(`${ELSEWHERE}T16:00:00-05:00`),
        },
      });

      expect((await listUnconfirmedTomorrow(prisma, { businessId, tomorrow: ELSEWHERE }))[0]!.attempt).toBeNull();
    });
  });

  describe('what it refuses to record', () => {
    it('refuses once she has left `booked` — she confirmed while the desk was dialling', async () => {
      const appointment = await seed({ day: TOMORROW, status: 'confirmed', hour: '15:00' });

      expect(
        await recordCallAttempt(prisma, {
          businessId,
          appointmentId: appointment.id,
          outcome: 'no_answer',
          actor: staffActor(priya),
        }),
      ).toBeNull();
      expect(await prisma.callDownAttempt.count()).toBe(0);
    });

    it('refuses another business’s appointment', async () => {
      const appointment = await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });
      const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });

      expect(
        await recordCallAttempt(prisma, {
          businessId: other.id,
          appointmentId: appointment.id,
          outcome: 'no_answer',
          actor: staffActor(priya),
        }),
      ).toBeNull();
      expect(await prisma.callDownAttempt.count()).toBe(0);
    });
  });

  it('SENDS NOTHING — the whole point is that a person made the call', async () => {
    const appointment = await seed({ day: TOMORROW, status: 'booked', hour: '15:00' });

    await recordCallAttempt(prisma, {
      businessId,
      appointmentId: appointment.id,
      outcome: 'left_message',
      actor: staffActor(priya),
    });

    // A-044: a message row rendering as "queued" beside a client's name is
    // read by staff as "no need to call her" — the exact inversion of what
    // this list is for.
    expect(await prisma.notificationOutbox.count()).toBe(0);
  });
});
