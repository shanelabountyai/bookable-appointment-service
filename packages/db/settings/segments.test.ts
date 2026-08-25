/**
 * A-029 — segment persistence and the two save-time guards (SEG-01, SEG-02),
 * against the real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { validateSegments } from '../../core/settings';
import { resetDatabase } from '../testing';
import { createProvider } from './providers';
import { listSegments, replaceSegments, segmentsByService } from './segments';
import { ServiceRejected, createService, listServices, qualifyProvider, updateService } from './services';
import { seedSetup } from './setup-seed';

const prisma = new PrismaClient();
let businessId: string;

const COLOUR = [
  { durationMinutes: 50, isGap: false },
  { durationMinutes: 40, isGap: true },
  { durationMinutes: 30, isGap: false },
];

const svc = (over: Record<string, unknown> = {}) => ({
  name: 'Colour',
  durationMinutes: 120,
  bufferBeforeMinutes: 10,
  bufferAfterMinutes: 20,
  priceCents: 14000,
  cancellationCutoffMinutes: null,
  requiredResourceTypeId: null,
  bookableOnline: true,
  ...over,
});

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const b = await prisma.business.create({
    data: { name: 'Shear Genius', timezone: 'America/Chicago', minimumLeadMinutes: 120, cancellationCutoffMinutes: 120 },
  });
  businessId = b.id;
});

describe('replaceSegments', () => {
  it('stores an ordered list and reads it back in order', async () => {
    const service = await createService(prisma, businessId, svc());
    await replaceSegments(prisma, businessId, service.id, COLOUR);
    const rows = await listSegments(prisma, service.id);
    expect(rows.map((r) => [r.ordinal, r.durationMinutes, r.isGap])).toEqual([
      [0, 50, false],
      [1, 40, true],
      [2, 30, false],
    ]);
  });

  it('replaces rather than appends — the point the old unique index used to make', async () => {
    const service = await createService(prisma, businessId, svc());
    await replaceSegments(prisma, businessId, service.id, COLOUR);
    await replaceSegments(prisma, businessId, service.id, [
      { durationMinutes: 60, isGap: false },
      { durationMinutes: 30, isGap: true },
      { durationMinutes: 30, isGap: false },
    ]);
    const rows = await listSegments(prisma, service.id);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.durationMinutes).toBe(60);
  });

  it('an empty list makes the service unsegmented again', async () => {
    const service = await createService(prisma, businessId, svc());
    await replaceSegments(prisma, businessId, service.id, COLOUR);
    await replaceSegments(prisma, businessId, service.id, []);
    expect(await listSegments(prisma, service.id)).toEqual([]);
  });

  it('sets the service duration FROM the parts, in one write', async () => {
    const service = await createService(prisma, businessId, svc());
    await replaceSegments(prisma, businessId, service.id, [
      { durationMinutes: 50, isGap: false },
      { durationMinutes: 40, isGap: true },
      { durationMinutes: 20, isGap: false },
    ]);
    const [stored] = await listServices(prisma, businessId);
    expect(stored!.durationMinutes).toBe(110);
    expect(await validateSegments(await listSegments(prisma, service.id), stored!.durationMinutes)).toEqual([]);
  });

  it('refuses a structurally bad list, and stores nothing', async () => {
    const service = await createService(prisma, businessId, svc());
    await expect(
      replaceSegments(prisma, businessId, service.id, [
        { durationMinutes: 40, isGap: true },
        { durationMinutes: 50, isGap: false },
        { durationMinutes: 30, isGap: false },
      ]),
    ).rejects.toBeInstanceOf(ServiceRejected);
    expect(await listSegments(prisma, service.id)).toEqual([]);
  });

  it('groups by service, and omits the unsegmented ones entirely', async () => {
    const colour = await createService(prisma, businessId, svc());
    await createService(prisma, businessId, svc({ name: 'Cut', durationMinutes: 45 }));
    await replaceSegments(prisma, businessId, colour.id, COLOUR);

    const byService = await segmentsByService(prisma, businessId);
    expect([...byService.keys()]).toEqual([colour.id]);
    expect(byService.get(colour.id)).toHaveLength(3);
  });
});

describe('the duration guard (SEG-01)', () => {
  it('refuses a duration change that would break the sum, naming both numbers', async () => {
    const service = await createService(prisma, businessId, svc());
    await replaceSegments(prisma, businessId, service.id, COLOUR);
    await expect(
      updateService(prisma, businessId, service.id, svc({ durationMinutes: 100 })),
    ).rejects.toMatchObject({ field: 'durationMinutes', message: expect.stringContaining('120') });
  });

  it('allows a duration change on an unsegmented service', async () => {
    const service = await createService(prisma, businessId, svc({ name: 'Cut', durationMinutes: 45 }));
    const updated = await updateService(prisma, businessId, service.id, svc({ name: 'Cut', durationMinutes: 50 }));
    expect(updated.durationMinutes).toBe(50);
  });

  // The deadlock this pair of rules could have had: with the duration guard
  // refusing a total that disagrees with the parts, the ONLY way to relength a
  // segmented service is for the parts to carry the total with them.
  it('editing the parts moves the total, so a segmented service is not frozen at its length', async () => {
    const service = await createService(prisma, businessId, svc());
    await replaceSegments(prisma, businessId, service.id, COLOUR);
    await replaceSegments(prisma, businessId, service.id, [
      { durationMinutes: 40, isGap: false },
      { durationMinutes: 40, isGap: true },
      { durationMinutes: 20, isGap: false },
    ]);
    const [stored] = await listServices(prisma, businessId);
    expect(stored!.durationMinutes).toBe(100);
    // ...and the service form is now free to save that total, because it agrees.
    expect((await updateService(prisma, businessId, service.id, svc({ durationMinutes: 100 }))).durationMinutes).toBe(
      100,
    );
  });
});

describe('the override guard (SEG-02)', () => {
  it('accepts an override that still leaves room around the gap', async () => {
    const service = await createService(prisma, businessId, svc());
    await replaceSegments(prisma, businessId, service.id, COLOUR);
    const provider = await createProvider(prisma, businessId, { displayName: 'Dana' });
    const qual = await qualifyProvider(prisma, businessId, service.id, provider.id, {
      durationOverrideMinutes: 100,
      priceOverrideCents: null,
    });
    expect(qual.durationOverrideMinutes).toBe(100);
  });

  it('refuses an override shorter than the gap it can never shorten, and says how long that is', async () => {
    const service = await createService(prisma, businessId, svc());
    await replaceSegments(prisma, businessId, service.id, COLOUR);
    const provider = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await expect(
      qualifyProvider(prisma, businessId, service.id, provider.id, {
        durationOverrideMinutes: 40,
        priceOverrideCents: null,
      }),
    ).rejects.toMatchObject({
      field: 'durationOverrideMinutes',
      message: expect.stringContaining('40 minutes of processing time'),
    });
  });

  it('leaves an unsegmented service alone', async () => {
    const service = await createService(prisma, businessId, svc({ name: 'Cut', durationMinutes: 45 }));
    const provider = await createProvider(prisma, businessId, { displayName: 'Dana' });
    const qual = await qualifyProvider(prisma, businessId, service.id, provider.id, {
      durationOverrideMinutes: 5,
      priceOverrideCents: null,
    });
    expect(qual.durationOverrideMinutes).toBe(5);
  });
});

describe('the seeded catalogue (SEG-01)', () => {
  it('every seeded service satisfies the sum invariant, and two of them are segmented', async () => {
    await seedSetup(prisma);
    const services = await listServices(prisma, (await prisma.business.findFirstOrThrow()).id);
    const bySvc = await segmentsByService(prisma, (await prisma.business.findFirstOrThrow()).id);

    for (const service of services) {
      expect(validateSegments(bySvc.get(service.id) ?? [], service.durationMinutes)).toEqual([]);
    }
    // The seed is what every downstream screen is developed against, so a
    // segmented and an unsegmented service have to sit side by side in it.
    expect(bySvc.size).toBe(2);
    expect(services.filter((s) => !bySvc.has(s.id)).length).toBeGreaterThan(0);
  });

  /**
   * Demo checkpoint 3. ONE seed run, on a clean database — which is what
   * `db:reset:test`, `db:seed:dev` and a first deploy all do, and the one
   * configuration nothing else covers. The requirement used to be applied
   * before the services existed, so a fresh install had four chairs that
   * nothing ever asked for and the resource layer never engaged; it healed on
   * the second run, which is every e2e `beforeEach` and every fixture-built
   * unit test. The assertion is deliberately "after ONE run".
   */
  it('requires a chair for every service after a SINGLE run on a clean database', async () => {
    await seedSetup(prisma);
    const businessId = (await prisma.business.findFirstOrThrow()).id;
    const chairType = await prisma.resourceType.findFirstOrThrow({ where: { businessId, name: 'Chair' } });
    const services = await prisma.service.findMany({ where: { businessId }, select: { name: true, requiredResourceTypeId: true } });

    expect(services.length).toBeGreaterThan(0);
    // Named, not counted: "0 of 8" and "8 of 8" both satisfy a length check
    // against itself, and the failure this catches is every one of them null.
    expect(services.filter((s) => s.requiredResourceTypeId !== chairType.id).map((s) => s.name)).toEqual([]);
  });

  it("re-running the seed does not double a colour's parts", async () => {
    await seedSetup(prisma);
    await seedSetup(prisma);
    const bySvc = await segmentsByService(prisma, (await prisma.business.findFirstOrThrow()).id);
    expect([...bySvc.values()].map((rows) => rows.length).sort()).toEqual([3, 5]);
  });
});
