/**
 * A-151 (D-74) — who the salon owes a rebook.
 *
 * Most of these are about WHEN she leaves the list, because a debt list that
 * keeps a client after she has been rebooked is a list the desk rings twice,
 * and one that drops her early is the silent loss the item exists to stop.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { customerTokenActor, staffActor } from '../../core/auth';
import { fromDate, instant, instantFromIso, toDate, toLabel, zoneId } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { listOwedRebooks } from './owed';
import { transitionAppointment } from './transition';

const prisma = new PrismaClient();
const STAFF = staffActor('staff-1');
const at = (iso: string) => toDate(instantFromIso(iso));

/** Saturday evening. Her Tuesday visit, next week, is still ahead. */
const NOW = at('2026-06-13T18:00:00-05:00');
const NEXT_TUESDAY = at('2026-06-16T10:00:00-05:00');

let businessId: string;
let providerId: string;
let cutId: string;
let colourId: string;
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
  colourId = (
    await prisma.service.create({ data: { businessId, name: 'Colour', durationMinutes: 90, priceCents: 12000 } })
  ).id;
  clientId = (await prisma.client.create({ data: { businessId, name: 'Ada Chen', phone: '5125550101' } })).id;
});

/** Every visit gets its own three hours (the visit is 135 min), so two fixtures never collide on the
 *  provider's exclusion constraint. */
async function visit(options: { startAt: Date; status?: string; client?: string }) {
  const startAt = toDate(instant(fromDate(options.startAt) + seeded++ * 3 * 60 * 60_000));
  const endAt = toDate(instant(fromDate(startAt) + 135 * 60_000));
  const label = toLabel(fromDate(startAt), zoneId('America/Chicago'));
  return prisma.appointment.create({
    data: {
      businessId,
      providerId,
      clientId: options.client ?? clientId,
      status: (options.status ?? 'booked') as 'booked',
      startAt,
      endAt,
      blockedStart: startAt,
      blockedEnd: endAt,
      startDay: label.day,
      startWallTime: label.time,
      // Two lines, colour FIRST: the prefill must keep the order (VISIT-01).
      lines: {
        create: [
          { businessId, serviceId: colourId, ordinal: 0, priceCents: 12000, durationMinutes: 90 },
          { businessId, serviceId: cutId, ordinal: 1, priceCents: 5500, durationMinutes: 45 },
        ],
      },
    },
  });
}

/** The conflicts screen's cancel: `cancelled`, hardcoded, flagged. */
const salonCancel = (appointmentId: string, now = NOW) =>
  transitionAppointment(prisma, {
    businessId,
    appointmentId,
    to: 'cancelled',
    actor: STAFF,
    now,
    reason: 'Dana off sick',
    salonInitiated: true,
  });

const list = () => listOwedRebooks(prisma, { businessId, now: NOW });

describe('who is owed', () => {
  it('lists a salon cancel with nothing since, carrying what the rebook needs', async () => {
    const appointment = await visit({ startAt: NEXT_TUESDAY });
    await salonCancel(appointment.id);

    const [row, ...rest] = await list();

    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      appointmentId: appointment.id,
      clientId,
      name: 'Ada Chen',
      phone: '+15125550101',
      providerId,
      providerName: 'Dana',
      serviceIds: [colourId, cutId],
      serviceNames: ['Colour', 'Cut'],
      reason: 'Dana off sick',
      startDay: '2026-06-16',
      // Her own day is still ahead, so the search starts on it.
      rebookFromDay: '2026-06-16',
    });
  });

  it('starts the search today when her original day has passed', async () => {
    const appointment = await visit({ startAt: at('2026-06-10T10:00:00-05:00') });
    await salonCancel(appointment.id, at('2026-06-09T09:00:00-05:00'));

    const [row] = await list();

    expect(row?.startDay).toBe('2026-06-10');
    expect(row?.rebookFromDay).toBe('2026-06-13');
  });

  it('is one row per client — her latest salon cancel — however many there were', async () => {
    const first = await visit({ startAt: NEXT_TUESDAY });
    const second = await visit({ startAt: NEXT_TUESDAY });
    await salonCancel(first.id);
    await salonCancel(second.id);

    const rows = await list();

    expect(rows.map((r) => r.appointmentId)).toEqual([second.id]);
  });
});

describe('who is not', () => {
  it('leaves off a cancel the desk made without the salon flag — a client ringing in', async () => {
    const appointment = await visit({ startAt: NEXT_TUESDAY });
    await transitionAppointment(prisma, { businessId, appointmentId: appointment.id, to: 'cancelled', actor: STAFF, now: NOW });

    expect(await list()).toEqual([]);
  });

  it('leaves off a cancel through her own manage link', async () => {
    const appointment = await visit({ startAt: NEXT_TUESDAY });
    await transitionAppointment(prisma, {
      businessId,
      appointmentId: appointment.id,
      to: 'cancelled',
      actor: customerTokenActor('tok-1'),
      now: NOW,
    });

    expect(await list()).toEqual([]);
  });

  it('drops her when something active is ahead, booked before or after', async () => {
    await visit({ startAt: at('2026-06-20T10:00:00-05:00') });
    const cancelled = await visit({ startAt: NEXT_TUESDAY });
    await salonCancel(cancelled.id);

    expect(await list()).toEqual([]);
  });

  // The Wednesday bug: rebooked for Tuesday, in on Tuesday, nothing ahead on
  // Wednesday. "Nothing active ahead" alone would put her back on the list.
  it('drops her once rebooked, even after that visit is in the past', async () => {
    const cancelled = await visit({ startAt: NEXT_TUESDAY });
    await salonCancel(cancelled.id);
    await visit({ startAt: at('2026-06-12T10:00:00-05:00'), status: 'completed' });

    expect(await list()).toEqual([]);
  });

  it('drops her once rebooked, even if she then cancelled that herself — her cancel is not the salon debt', async () => {
    const cancelled = await visit({ startAt: NEXT_TUESDAY });
    await salonCancel(cancelled.id);
    await visit({ startAt: at('2026-06-20T10:00:00-05:00'), status: 'cancelled' });

    expect(await list()).toEqual([]);
  });

  it('reads the cancel that STANDS: reinstated, then cancelled by her link, is hers', async () => {
    const appointment = await visit({ startAt: NEXT_TUESDAY });
    await salonCancel(appointment.id);
    await transitionAppointment(prisma, {
      businessId,
      appointmentId: appointment.id,
      to: 'booked',
      actor: STAFF,
      now: NOW,
      reason: 'Dana is back',
    });
    await transitionAppointment(prisma, {
      businessId,
      appointmentId: appointment.id,
      to: 'cancelled',
      actor: customerTokenActor('tok-1'),
      now: NOW,
    });

    expect(await list()).toEqual([]);
  });

  it('leaves off a salon cancel older than the window — the lapsed report owns her now', async () => {
    const appointment = await visit({ startAt: at('2026-02-10T10:00:00-06:00'), status: 'cancelled' });
    await prisma.appointmentEvent.create({
      data: {
        businessId,
        appointmentId: appointment.id,
        type: 'status_changed',
        actor: 'staff',
        reason: 'Dana off sick',
        payload: { from: 'booked', to: 'cancelled', salonInitiated: true },
        // Thirteen weeks before NOW; the window is twelve.
        createdAt: toDate(instant(fromDate(NOW) - 13 * 7 * 86_400_000)),
      },
    });

    expect(await list()).toEqual([]);
  });

  it('never lists another salon’s debts', async () => {
    const appointment = await visit({ startAt: NEXT_TUESDAY });
    await salonCancel(appointment.id);
    const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });

    expect(await listOwedRebooks(prisma, { businessId: other.id, now: NOW })).toEqual([]);
  });
});
