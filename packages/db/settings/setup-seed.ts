/**
 * THE SETUP SEED (A-025, operator review S-1): a business, its roster, its
 * catalogue and its weekly hours. Deterministic, idempotent, no appointments.
 *
 * Split from the §9 DENSITY seed (A-011, which adds appointments once A-009's
 * write path exists) for a specific reason: A-006, A-007 and A-026 are all
 * built before any appointment can be created, and A-026 is the highest-risk
 * database code in the project after the constraint itself. Developing it
 * against three hand-typed rows means never seeing a split shift, a mid-window
 * break, or a provider who is unqualified for the service being searched.
 *
 * REFUSES TO RUN IN PRODUCTION, like every other seed here.
 */
import type { PrismaClient } from '../generated/client/index.js';

/** D-20: the sample business has four chairs, so the roster is four providers.
 *  A roster larger than the chair count would make the demo imply a resource
 *  constraint the system deliberately does not enforce in v1. */
export const CHAIR_COUNT = 4;

/** Buffers are deliberately UNEQUAL across services and never equal to the
 *  15-minute grid interval (CLAUDE.md test rules): equal buffers hide
 *  whose-buffer bugs, and duration == interval hides the
 *  removes-multiple-candidates defect. */
/** SEG-01: two services carry real segments, so the gap stripe is visible on
 *  the seeded day without anyone hand-typing rows, and so a segmented service
 *  and an unsegmented one sit side by side in every screen that lists them.
 *  Segments MUST sum to `durationMinutes` — the seed is not exempt from the
 *  invariant, and a test asserts the seeded rows satisfy it. */
const SERVICES = [
  { name: 'Cut', durationMinutes: 45, bufferBefore: 0, bufferAfter: 10, priceCents: 5500 },
  { name: 'Cut & finish', durationMinutes: 60, bufferBefore: 5, bufferAfter: 10, priceCents: 7500 },
  {
    name: 'Colour',
    durationMinutes: 120,
    bufferBefore: 10,
    bufferAfter: 20,
    priceCents: 14000,
    // Apply, develop, finish. The 40 developing minutes are the free provider
    // time this whole feature exists to expose.
    //
    // 45 rather than 50 for the first part IS THE POINT, and it was found by a
    // failing e2e: with 50, a colour booked on the hour leaves its gap running
    // 10:50-11:30, and the 15-minute booking grid has no candidate inside it
    // that also fits a 30-minute blow-dry. A gap that does not line up with the
    // grid is a gap the salon cannot sell, which makes the whole feature
    // decorative. The seed has to demonstrate a sellable one.
    segments: [
      { durationMinutes: 45, isGap: false },
      { durationMinutes: 40, isGap: true },
      { durationMinutes: 35, isGap: false },
    ],
  },
  {
    name: 'Balayage',
    durationMinutes: 180,
    bufferBefore: 10,
    bufferAfter: 25,
    priceCents: 21000,
    // Two gaps, so nothing downstream can get away with assuming one.
    segments: [
      { durationMinutes: 60, isGap: false },
      { durationMinutes: 35, isGap: true },
      { durationMinutes: 25, isGap: false },
      { durationMinutes: 30, isGap: true },
      { durationMinutes: 30, isGap: false },
    ],
  },
  { name: 'Root touch-up', durationMinutes: 90, bufferBefore: 5, bufferAfter: 15, priceCents: 9500 },
  { name: 'Blow-dry', durationMinutes: 30, bufferBefore: 0, bufferAfter: 5, priceCents: 4000 },
  { name: 'Treatment', durationMinutes: 20, bufferBefore: 0, bufferAfter: 5, priceCents: 3000 },
  { name: 'Fringe trim', durationMinutes: 10, bufferBefore: 0, bufferAfter: 5, priceCents: 1500 },
] as const;

const PROVIDERS = [
  { displayName: 'Dana', displayOrder: 0 },
  { displayName: 'Priya', displayOrder: 1 },
  { displayName: 'Marcus', displayOrder: 2 },
  { displayName: 'Tess', displayOrder: 3 },
] as const;

export interface SetupSeedResult {
  businessId: string;
  providerIds: string[];
  serviceIds: string[];
}

export async function seedSetup(
  prisma: PrismaClient,
  opts: { businessName?: string; timezone?: string } = {},
): Promise<SetupSeedResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedSetup refuses to run with NODE_ENV=production.');
  }

  const business =
    (await prisma.business.findFirst()) ??
    (await prisma.business.create({
      data: { name: opts.businessName ?? 'Shear Genius', timezone: opts.timezone ?? 'America/Chicago' },
    }));

  const providerIds: string[] = [];
  for (const p of PROVIDERS) {
    const existing = await prisma.provider.findFirst({
      where: { businessId: business.id, displayName: p.displayName },
    });
    const provider = existing
      ? await prisma.provider.update({
          where: { id: existing.id },
          data: { displayOrder: p.displayOrder, active: true },
        })
      : await prisma.provider.create({
          data: { businessId: business.id, displayName: p.displayName, displayOrder: p.displayOrder },
        });
    providerIds.push(provider.id);
  }

  // A-031/D-30: the chairs are real rows now, and the exclusion constraint on
  // AppointmentResourceHold defends them. The assertion this replaces checked
  // that the roster did not exceed the chair count, citing D-20's premise that
  // "for a 4-chair salon with 4 stylists the pool never binds". A-030 ended
  // that: a client developing colour holds a chair her stylist is not using, so
  // four stylists can want eight chairs. The roster size was never the thing to
  // guard — the concurrent CLIENT count is, and only the database can guard it.
  const chairType = await prisma.resourceType.upsert({
    where: { businessId_name: { businessId: business.id, name: 'Chair' } },
    update: {},
    create: { businessId: business.id, name: 'Chair' },
  });
  for (let i = 1; i <= CHAIR_COUNT; i++) {
    const name = `Chair ${i}`;
    const existing = await prisma.resource.findFirst({
      where: { businessId: business.id, resourceTypeId: chairType.id, name },
    });
    if (!existing) {
      await prisma.resource.create({
        data: { businessId: business.id, resourceTypeId: chairType.id, name },
      });
    }
  }
  // Every service happens in a chair. A business that defines no resources
  // keeps working exactly as before — that is what the nullable column is for.
  await prisma.service.updateMany({
    where: { businessId: business.id },
    data: { requiredResourceTypeId: chairType.id },
  });

  const serviceIds: string[] = [];
  for (const s of SERVICES) {
    const existing = await prisma.service.findFirst({ where: { businessId: business.id, name: s.name } });
    const service = existing
      ? await prisma.service.update({
          where: { id: existing.id },
          data: {
            durationMinutes: s.durationMinutes,
            bufferBeforeMinutes: s.bufferBefore,
            bufferAfterMinutes: s.bufferAfter,
            priceCents: s.priceCents,
            active: true,
          },
        })
      : await prisma.service.create({
          data: {
            businessId: business.id,
            name: s.name,
            durationMinutes: s.durationMinutes,
            bufferBeforeMinutes: s.bufferBefore,
            bufferAfterMinutes: s.bufferAfter,
            priceCents: s.priceCents,
            displayOrder: serviceIds.length,
          },
        });
    // Idempotent like everything else in this seed: the rows are replaced, not
    // appended, so re-running never doubles a colour's parts.
    await prisma.serviceSegment.deleteMany({ where: { serviceId: service.id } });
    if ('segments' in s) {
      await prisma.serviceSegment.createMany({
        data: s.segments.map((segment, ordinal) => ({
          businessId: business.id,
          serviceId: service.id,
          ordinal,
          durationMinutes: segment.durationMinutes,
          isGap: segment.isGap,
        })),
      });
    }
    serviceIds.push(service.id);
  }

  // Qualification: NOT everyone does everything. Tess is junior — cuts,
  // blow-dries and trims only. A catalogue where every provider is qualified
  // for every service makes SVC-02's "unassigned provider never appears" rule
  // untestable against the seed, which is most of what the seed is for.
  const juniorOnly = new Set(['Cut', 'Blow-dry', 'Fringe trim', 'Treatment']);
  for (const [pi, providerId] of providerIds.entries()) {
    const isJunior = PROVIDERS[pi]!.displayName === 'Tess';
    for (const [si, serviceId] of serviceIds.entries()) {
      const serviceName = SERVICES[si]!.name;
      if (isJunior && !juniorOnly.has(serviceName)) continue;
      await prisma.serviceProvider.upsert({
        where: { serviceId_providerId: { serviceId, providerId } },
        create: { businessId: business.id, serviceId, providerId },
        update: {},
      });
    }
  }

  await seedWeeklyHours(prisma, business.id, providerIds);
  await seedDateOverride(prisma, business.id);

  return { businessId: business.id, providerIds, serviceIds };
}

/**
 * Business hours plus per-provider hours, including one SPLIT SHIFT and one
 * mid-window break.
 *
 * These shapes are the point. AVAIL-01's "breaks belong to the window, not the
 * day" and the engine's window-union behaviour are both invisible against a
 * roster where everyone works 9–5 with no break.
 */
async function seedWeeklyHours(prisma: PrismaClient, businessId: string, providerIds: string[]): Promise<void> {
  // Business hours: Tue–Sat. Closed Sunday and Monday, which is a real salon
  // week and means "no windows at all" is exercised by the seed rather than
  // only by a unit test.
  for (const weekday of [2, 3, 4, 5, 6]) {
    const existing = await prisma.weeklyWindow.findFirst({
      where: { businessId, providerId: null, weekday },
    });
    if (!existing) {
      await prisma.weeklyWindow.create({
        data: { businessId, providerId: null, weekday, open: '09:00', close: '18:00', endsNextDay: false },
      });
    }
  }

  for (const [i, providerId] of providerIds.entries()) {
    for (const weekday of [2, 3, 4, 5, 6]) {
      const existing = await prisma.weeklyWindow.findFirst({ where: { businessId, providerId, weekday } });
      if (existing) continue;

      if (i === 2 && weekday === 4) {
        // Marcus works a SPLIT SHIFT on Thursdays: two windows, a real gap
        // between them — not a break inside one window.
        await prisma.weeklyWindow.create({
          data: { businessId, providerId, weekday, open: '09:00', close: '12:00', endsNextDay: false },
        });
        await prisma.weeklyWindow.create({
          data: { businessId, providerId, weekday, open: '15:00', close: '19:00', endsNextDay: false },
        });
        continue;
      }

      const window = await prisma.weeklyWindow.create({
        data: { businessId, providerId, weekday, open: '09:00', close: '17:00', endsNextDay: false },
      });
      // A midday break for everyone except Tess, so both arms exist.
      if (i !== 3) {
        await prisma.windowBreak.create({
          data: { businessId, weeklyWindowId: window.id, open: '12:00', close: '13:00' },
        });
      }
    }
  }
}

/**
 * One closed date override, on a fixed day.
 *
 * `isClosed = true` with zero child windows is the shape AVAIL-02 requires to
 * be representable and DISTINCT from "no override at all" — a distinction that
 * nothing exercises unless the seed contains one.
 */
async function seedDateOverride(prisma: PrismaClient, businessId: string): Promise<void> {
  const day = '2026-07-04';
  const existing = await prisma.dateOverride.findFirst({ where: { businessId, providerId: null, day } });
  if (!existing) {
    await prisma.dateOverride.create({
      data: { businessId, providerId: null, day, isClosed: true, reason: 'Independence Day — closed' },
    });
  }
}
