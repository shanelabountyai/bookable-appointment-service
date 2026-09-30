/**
 * A-149 (C8) — `processingGapAt`, the booking panel's single-instant door
 * into the same fact `loadDayView` annotates its gaps with. Against a real
 * database because the query is what is under test, not the pure matcher
 * (`processingGapContaining` is exercised in `day-view.test.ts` already,
 * through the whole-column path).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { createWeeklyWindow } from '../availability';
import { bookAppointment } from '../booking';
import { processingGapAt } from './free-runs';

const prisma = new PrismaClient();
const STAMP = { createdByActor: 'staff' as const, actorRef: 'staff-1' };
const ACTOR = staffActor('staff-1');

const at = (iso: string) => toDate(instantFromIso(iso));
const NOW = at('2026-06-08T08:00:00-05:00'); // Monday; the book below is Tuesday 2026-06-09.

let businessId: string;
let danaId: string;
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
    data: { name: 'Shear Genius', timezone: 'America/Chicago', slotIntervalMinutes: 15, minimumLeadMinutes: 0, bookingHorizonDays: 365 },
  });
  businessId = business.id;

  const dana = await prisma.provider.create({ data: { businessId, displayName: 'Dana', displayOrder: 0 } });
  danaId = dana.id;

  const service = await prisma.service.create({
    data: { businessId, name: 'Colour', durationMinutes: 120, priceCents: 14000 },
  });
  serviceId = service.id;
  await prisma.serviceProvider.create({ data: { businessId, serviceId, providerId: dana.id } });
  await prisma.serviceSegment.createMany({
    data: [
      { businessId, serviceId, ordinal: 0, durationMinutes: 45, isGap: false },
      { businessId, serviceId, ordinal: 1, durationMinutes: 40, isGap: true },
      { businessId, serviceId, ordinal: 2, durationMinutes: 35, isGap: false },
    ],
  });

  clientId = (await prisma.client.create({ data: { businessId, name: 'Robin Colour', phone: '5125550142' } })).id;

  await createWeeklyWindow(prisma, { businessId, providerId: null, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);
  await createWeeklyWindow(prisma, { businessId, providerId: danaId, weekday: 2, open: '09:00', close: '18:00', endsNextDay: false }, STAMP);

  await bookAppointment(prisma, {
    businessId,
    providerId: danaId,
    serviceIds: [serviceId],
    clientId,
    startAt: at('2026-06-09T10:00:00-05:00'),
    now: NOW,
    actor: ACTOR,
    audience: 'staff',
  });
});

describe('processingGapAt', () => {
  it('names the visit when the instant falls inside its processing gap', async () => {
    // 45 worked, 40 gap (10:45-11:25 CDT), 35 worked.
    const found = await processingGapAt(prisma, { providerId: danaId, at: at('2026-06-09T11:00:00-05:00') });
    expect(found).toMatchObject({ clientName: 'Robin Colour', serviceNames: ['Colour'] });
    expect(found?.backAt.toISOString()).toBe(at('2026-06-09T11:25:00-05:00').toISOString());
  });

  // D-3's half-open rule, applied to the gap itself: [10:45, 11:25) is free,
  // so the instant the first block ENDS is already inside the gap and the
  // instant the second one STARTS is already worked again.
  it('is inclusive of the gap’s own start and exclusive of its own end', async () => {
    expect(await processingGapAt(prisma, { providerId: danaId, at: at('2026-06-09T10:45:00-05:00') })).toMatchObject({
      clientName: 'Robin Colour',
    });
    expect(await processingGapAt(prisma, { providerId: danaId, at: at('2026-06-09T11:25:00-05:00') })).toBeNull();
  });

  it('is null for ordinary open time, even on the same provider and day', async () => {
    expect(await processingGapAt(prisma, { providerId: danaId, at: at('2026-06-09T14:00:00-05:00') })).toBeNull();
  });
});
