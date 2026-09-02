/**
 * A-076 / D-46 — what is still open (APPT-01, APPT-03).
 *
 * Eleven of twenty-nine Saturday appointments sit on `booked` or `checked_in`
 * forever, and three readers are wrong because of it. The tests below are
 * mostly about WHICH rows belong on the list, because a list that includes a
 * visit still running at six o'clock, or one from three months ago nobody will
 * ever reconstruct, is a list the desk stops opening — which is the same
 * failure `/staff/opened` and the lapsed report each had to be bounded against.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '../../core/auth';
import { fromDate, instant, instantFromIso, toDate, toLabel, zoneId } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { countUnfinished, listUnfinished } from './unfinished';
import { transitionAppointment } from './transition';

const prisma = new PrismaClient();
const STAFF = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));

/** Six o'clock on the Saturday being closed out. */
const NOW = at('2026-06-13T18:00:00-05:00');

let businessId: string;
let providerId: string;
let cutId: string;
let clientId: string;
let seeded = 0;

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
  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;
});

/** Every visit gets its own hour: one provider at one instant is one
 *  appointment, and two fixtures on the same Saturday would collide with
 *  `appointment_block_no_overlap` (A-073's lesson). */
async function visit(options: { startAt: Date; status?: string; priceCents?: number }) {
  const startAt = toDate(instant(fromDate(options.startAt) + seeded++ * 60 * 60_000));
  const endAt = toDate(instant(fromDate(startAt) + 45 * 60_000));
  const label = toLabel(fromDate(startAt), zoneId('America/Chicago'));
  return prisma.appointment.create({
    data: {
      businessId,
      providerId,
      clientId,
      status: (options.status ?? 'booked') as 'booked',
      startAt,
      endAt,
      blockedStart: startAt,
      blockedEnd: endAt,
      // Derived from the instant, never a constant — A-077's fixture lesson.
      startDay: label.day,
      startWallTime: label.time,
      lines: {
        create: {
          businessId,
          serviceId: cutId,
          ordinal: 0,
          priceCents: options.priceCents ?? 5500,
          durationMinutes: 45,
        },
      },
    },
  });
}

const list = () => listUnfinished(prisma, { businessId, now: NOW });

describe('what is on it', () => {
  it('lists a past appointment nobody ever closed, with what it was worth', async () => {
    await visit({ startAt: at('2026-06-13T10:00:00-05:00'), priceCents: 14000 });

    const [row, ...rest] = await list();

    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      clientName: 'Ada Chen',
      providerName: 'Dana',
      serviceNames: ['Cut'],
      status: 'booked',
      startDay: '2026-06-13',
      // The money the utilization number is missing, from her OWN line price.
      valueCents: 14000,
    });
  });

  it.each(['booked', 'confirmed', 'checked_in', 'in_progress'])(
    'includes %s — none of them is an end state',
    async (status) => {
      await visit({ startAt: at('2026-06-13T10:00:00-05:00'), status });

      expect(await list()).toHaveLength(1);
    },
  );

  it('counts the same rows it lists, because the badge is what makes it findable', async () => {
    await visit({ startAt: at('2026-06-13T10:00:00-05:00') });
    await visit({ startAt: at('2026-06-13T14:00:00-05:00'), status: 'checked_in' });

    expect(await countUnfinished(prisma, { businessId, now: NOW })).toBe((await list()).length);
    expect(await countUnfinished(prisma, { businessId, now: NOW })).toBe(2);
  });
});

describe('what is deliberately NOT on it', () => {
  it.each(['completed', 'no_show', 'cancelled', 'cancelled_late'])(
    'drops %s — somebody already said what happened',
    async (status) => {
      await visit({ startAt: at('2026-06-13T10:00:00-05:00'), status });

      expect(await list()).toHaveLength(0);
    },
  );

  /** Bounded on the appointment's own END: a visit still running at six is not
   *  unfinished, it is in progress, and putting it on the list would have the
   *  desk closing out a client who is still in the chair. */
  it('drops one that has not finished yet', async () => {
    await visit({ startAt: at('2026-06-13T17:45:00-05:00'), status: 'in_progress' });

    expect(await list()).toHaveLength(0);
  });

  it('drops one older than the lookback — a backlog is a list the desk stops opening', async () => {
    await visit({ startAt: at('2026-04-01T10:00:00-05:00') });

    expect(await list()).toHaveLength(0);
    expect(await listUnfinished(prisma, { businessId, now: NOW, lookbackDays: 365 })).toHaveLength(1);
  });

  it('drops one on a provider who has since left', async () => {
    await visit({ startAt: at('2026-06-13T10:00:00-05:00') });
    await prisma.provider.update({ where: { id: providerId }, data: { active: false } });

    expect(await list()).toHaveLength(0);
  });

  it('is scoped to the business', async () => {
    const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
    await visit({ startAt: at('2026-06-13T10:00:00-05:00') });

    expect(await listUnfinished(prisma, { businessId: other.id, now: NOW })).toHaveLength(0);
  });
});

/**
 * D-46's two new edges, and the timestamps they must NOT invent. This is the
 * half that makes the list actionable: without them, closing Saturday on Monday
 * meant tapping `checked_in` first and writing a Monday check-in onto a client
 * who sat down on Saturday.
 */
describe('closing one out (D-46)', () => {
  it.each(['booked', 'confirmed'])('closes a %s appointment in ONE tap', async (status) => {
    const appointment = await visit({ startAt: at('2026-06-13T10:00:00-05:00'), status });

    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      now: NOW,
      actor: STAFF,
    });

    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status).toBe('completed');
    expect(await list()).toHaveLength(0);
  });

  /** THE HONEST TIMESTAMP. Nobody knows when she sat down or when she got up,
   *  and `now` is Monday morning. A missing timestamp is honest; a fabricated
   *  one makes "she was forty minutes late" — D-7's whole point — unanswerable
   *  for every retrospectively closed visit. */
  it('invents no arrival or finish time when nobody saw her', async () => {
    const appointment = await visit({ startAt: at('2026-06-13T10:00:00-05:00') });

    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      now: at('2026-06-15T09:40:00-05:00'),
      actor: STAFF,
    });

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(row.checkedInAt).toBeNull();
    expect(row.startedAt).toBeNull();
    expect(row.endedAt).toBeNull();
  });

  /** …and the ordinary tap at the till still stamps, because she WAS seen —
   *  AND because the tap happens while she is still standing there. A-080
   *  (D-47): a row still on `in_progress` when this list is read at six is on
   *  the list precisely because nobody tapped at the time, so the `now` that
   *  closes it is no longer a measurement either. `endedAt` is stamped from
   *  the till, not from the list. */
  it('still stamps the finish when she was in the chair', async () => {
    const appointment = await visit({ startAt: at('2026-06-13T10:00:00-05:00'), status: 'in_progress' });
    const atTheTill = toDate(instant(fromDate(appointment.endAt) + 10 * 60_000));

    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      now: atTheTill,
      actor: STAFF,
    });

    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).endedAt).toEqual(atTheTill);
  });

  /** `after-start`, for the same reason `no_show` carries it: an appointment
   *  that has not begun cannot have been finished. */
  it('refuses to close one that has not started', async () => {
    const appointment = await visit({ startAt: at('2026-06-20T10:00:00-05:00') });

    await expect(
      transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'completed',
        now: NOW,
        actor: STAFF,
      }),
    ).rejects.toThrow();
  });

  it('records who closed it, as an ordinary event', async () => {
    const appointment = await visit({ startAt: at('2026-06-13T10:00:00-05:00') });

    await transitionAppointment(prisma, {
      appointmentId: appointment.id,
      to: 'completed',
      now: NOW,
      actor: STAFF,
    });

    const events = await prisma.appointmentEvent.findMany({ where: { appointmentId: appointment.id } });
    expect(events.map((e) => e.type)).toContain('status_changed');
  });
});
