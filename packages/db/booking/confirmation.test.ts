/**
 * A-009's confirmation outbox row (BOOK-06, D-14) — the SEAM, not the parts.
 *
 * Written because demo checkpoint 1 found that nothing tested it. A-003 added
 * `NotificationOutbox.appointmentId` and its index; A-004 built a correct
 * enqueue; A-009 correctly enqueued a confirmation inside the booking
 * transaction. Every one of those items was right, every test passed, and the
 * foreign key between them was never written — 228 seeded outbox rows all
 * carried `appointmentId = NULL`, so the one lookup the column exists for
 * ("was she actually told?", operator R-4) returned nothing.
 *
 * So these assert the property a LATER SCREEN will depend on — find the
 * confirmation *by appointment* — rather than that a row exists somewhere.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instantFromIso, toDate } from '../../core/time';
import { staffActor } from '../../core/auth';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from './book';

const prisma = new PrismaClient();
const STAFF = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const TEN_AM = at('2026-06-09T10:00:00-05:00'); // Tuesday
const NOW = at('2026-06-09T08:00:00-05:00');

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
    data: { name: 'Shear Genius', timezone: 'America/Chicago', minimumLeadMinutes: 0, bookingHorizonDays: 365 },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana' } });
  providerId = dana.id;

  const service = await prisma.service.create({
    data: { businessId, name: 'Cut', durationMinutes: 60, priceCents: 5500, bufferAfterMinutes: 15 },
  });
  serviceId = service.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId } });

  const client = await prisma.client.create({
    data: { businessId, name: 'Ada Chen', phone: '5125550101', email: 'ada@example.test' },
  });
  clientId = client.id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAFF);
  await createWeeklyWindow(prisma, { businessId, providerId, weekday: 2, open: '09:00', close: '17:00', endsNextDay: false }, STAFF);
});

const book = (over: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(prisma, {
    businessId,
    providerId,
    serviceIds: [serviceId],
    clientId,
    startAt: TEN_AM,
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
    ...over,
  } as Parameters<typeof bookAppointment>[1]);

describe('the booking confirmation is reachable FROM the appointment', () => {
  // THE regression test. Everything else here was already true when the
  // defect existed.
  it('links the confirmation to its appointment by foreign key, not only in the payload', async () => {
    const appointment = await book();

    const rows = await prisma.notificationOutbox.findMany({ where: { appointmentId: appointment.id } });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.template).toBe('appointment.confirmed');
  });

  it('reaches the appointment back through the relation', async () => {
    const appointment = await book();
    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { appointmentId: appointment.id },
      include: { appointment: { select: { id: true, startAt: true } } },
    });
    expect(row.appointment?.id).toBe(appointment.id);
    expect(row.appointment?.startAt.toISOString()).toBe(appointment.startAt.toISOString());
  });

  /* DELIBERATELY ABSENT: "refuses to delete an announced appointment".
   *
   * It was written, it passed, and mutation testing showed it passed with the
   * fix reverted — `AppointmentEvent`'s own `onDelete: Restrict` blocks the
   * delete first, and events are append-only by trigger, so the outbox's
   * restrict can never be observed in isolation. The assertion was true and
   * proved nothing about this file's subject. Do not re-add it. */

  it('carries the manage link and the instant in the payload', async () => {
    const appointment = await book();
    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { appointmentId: appointment.id } });
    const payload = row.payload as { manageUrl?: string; startAt?: string };
    expect(payload.manageUrl).toContain('/manage/');
    // D-4: the instant, never a {date, time} pair.
    expect(payload.startAt).toBe(appointment.startAt.toISOString());
  });

  it('writes exactly one confirmation when the same booking is retried', async () => {
    const first = await book({ idempotencyKey: 'retry-me' });
    const second = await book({ idempotencyKey: 'retry-me' });
    expect(second.id).toBe(first.id);
    expect(await prisma.notificationOutbox.count({ where: { appointmentId: first.id } })).toBe(1);
  });

  // BOOK-04: no phone, no email, still a booking — and still an auditable
  // record of why nothing was sent.
  it('records a suppressed confirmation for a walk-in with no contact details', async () => {
    const walkIn = await prisma.client.create({ data: { businessId, name: 'Walk-in' } });
    const appointment = await book({ clientId: walkIn.id, startAt: at('2026-06-09T14:00:00-05:00') });

    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { appointmentId: appointment.id } });
    expect(row.status).toBe('suppressed');
    expect(row.lastError).toBe('suppressed:no_recipient');
  });
});
