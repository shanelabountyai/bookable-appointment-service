/**
 * A-025 — business settings, provider roster and the setup seed, against the
 * real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { PolicyRejected, getBusinessSettings, updateBusinessSettings } from './business';
import {
  ProviderRejected,
  countFutureAppointments,
  createProvider,
  listProviders,
  setProviderActive,
  updateProvider,
} from './providers';
import { CHAIR_COUNT, seedSetup } from './setup-seed';
import { instantFromIso, toDate } from '../../core/time';
import { resetDatabase } from '../testing';

const prisma = new PrismaClient();
let businessId: string;

const settings = (over: Record<string, unknown> = {}) => ({
  name: 'Shear Genius',
  timezone: 'America/Chicago',
  slotIntervalMinutes: 15,
  minimumLeadMinutes: 120,
  cancellationCutoffMinutes: 120,
  noShowBlockThreshold: 3,
  bookingHorizonDays: 90,
  bufferMayOverlapBreak: true,
  bufferMayExtendPastClose: true,
  ambiguousLocalTime: 'offer-both' as const,
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
  const b = await prisma.business.create({ data: { name: 'Shear Genius', timezone: 'America/Chicago' } });
  businessId = b.id;
});

describe('business settings', () => {
  it('round-trips every policy field', async () => {
    const saved = await updateBusinessSettings(prisma, businessId, settings({ bookingHorizonDays: 60, noShowBlockThreshold: 2 }));
    expect(saved.bookingHorizonDays).toBe(60);
    const read = await getBusinessSettings(prisma, businessId);
    expect(read).toMatchObject({ bookingHorizonDays: 60, noShowBlockThreshold: 2, timezone: 'America/Chicago' });
  });

  it('refuses a business cutoff longer than the lead time', async () => {
    await expect(
      updateBusinessSettings(prisma, businessId, settings({ minimumLeadMinutes: 60, cancellationCutoffMinutes: 120 })),
    ).rejects.toThrow(PolicyRejected);
  });

  // The operator's R-3 scenario, end to end against real rows: both settings
  // are individually reasonable and the COMBINATION traps the client.
  it('refuses a lead time shorter than an ACTIVE service cutoff', async () => {
    await prisma.service.create({
      data: { businessId, name: 'Colour', durationMinutes: 120, priceCents: 14000, cancellationCutoffMinutes: 24 * 60 },
    });
    const error = await updateBusinessSettings(prisma, businessId, settings({ minimumLeadMinutes: 120 })).catch((e) => e);
    expect(error).toBeInstanceOf(PolicyRejected);
    expect((error as PolicyRejected).violations[0]!.message).toContain('Colour');
    // The row must be unchanged — a rejected save writes nothing.
    expect((await getBusinessSettings(prisma, businessId))!.minimumLeadMinutes).toBe(120);
  });

  it('ignores an INACTIVE service when validating', async () => {
    await prisma.service.create({
      data: {
        businessId,
        name: 'Retired colour',
        durationMinutes: 120,
        priceCents: 14000,
        cancellationCutoffMinutes: 24 * 60,
        active: false,
      },
    });
    await expect(updateBusinessSettings(prisma, businessId, settings({ minimumLeadMinutes: 120 }))).resolves.toBeDefined();
  });

  it('accepts once the lead time covers the longest service cutoff', async () => {
    await prisma.service.create({
      data: { businessId, name: 'Colour', durationMinutes: 120, priceCents: 14000, cancellationCutoffMinutes: 24 * 60 },
    });
    const saved = await updateBusinessSettings(prisma, businessId, settings({ minimumLeadMinutes: 24 * 60 }));
    expect(saved.minimumLeadMinutes).toBe(1440);
  });

  it('refuses an empty business name', async () => {
    await expect(updateBusinessSettings(prisma, businessId, settings({ name: '   ' }))).rejects.toThrow(PolicyRejected);
  });
});

describe('provider roster', () => {
  it('appends new providers to the end of the roster', async () => {
    await createProvider(prisma, businessId, { displayName: 'Dana' });
    await createProvider(prisma, businessId, { displayName: 'Priya' });
    const roster = await listProviders(prisma, businessId);
    expect(roster.map((p) => [p.displayName, p.displayOrder])).toEqual([
      ['Dana', 0],
      ['Priya', 1],
    ]);
  });

  it('orders by displayOrder then name — the order SVC-02 breaks ties on', async () => {
    await createProvider(prisma, businessId, { displayName: 'Zoe', displayOrder: 0 });
    await createProvider(prisma, businessId, { displayName: 'Adam', displayOrder: 0 });
    await createProvider(prisma, businessId, { displayName: 'Mia', displayOrder: -1 });
    expect((await listProviders(prisma, businessId)).map((p) => p.displayName)).toEqual(['Mia', 'Adam', 'Zoe']);
  });

  it('refuses a blank name on create and update', async () => {
    await expect(createProvider(prisma, businessId, { displayName: '  ' })).rejects.toThrow(ProviderRejected);
    const p = await createProvider(prisma, businessId, { displayName: 'Dana' });
    await expect(updateProvider(prisma, p.id, { displayName: '' })).rejects.toThrow(ProviderRejected);
  });

  it('trims names', async () => {
    const p = await createProvider(prisma, businessId, { displayName: '  Dana  ' });
    expect(p.displayName).toBe('Dana');
  });

  // Deactivation is not deletion: the clients, the history and the
  // appointments all survive. Only "is she offered" changes.
  it('deactivates and reactivates without destroying the row', async () => {
    const p = await createProvider(prisma, businessId, { displayName: 'Dana' });
    const off = await setProviderActive(prisma, p.id, false);
    expect(off.active).toBe(false);
    expect(await listProviders(prisma, businessId, false)).toHaveLength(0);
    expect(await listProviders(prisma, businessId, true)).toHaveLength(1);
    expect((await setProviderActive(prisma, p.id, true)).active).toBe(true);
  });

  it('counts zero future appointments until A-009 can create any', async () => {
    const p = await createProvider(prisma, businessId, { displayName: 'Dana' });
    expect(await countFutureAppointments(prisma, p.id, toDate(instantFromIso('1970-01-01T00:00:00Z')))).toBe(0);
  });
});

describe('setup seed (operator S-1)', () => {
  it('creates a full, deterministic setup and is idempotent', async () => {
    const first = await seedSetup(prisma);
    expect(first.providerIds).toHaveLength(4);
    expect(first.serviceIds).toHaveLength(8);

    const again = await seedSetup(prisma);
    expect(again.businessId).toBe(first.businessId);
    expect(await prisma.provider.count()).toBe(4);
    expect(await prisma.service.count()).toBe(8);
  });

  /**
   * THE GENERIC FIRST-RUN DETECTOR (demo checkpoint 3's carried-forward
   * question: "what else is only true the second time?").
   *
   * Checkpoint 3 found four items' worth of resource machinery dormant in
   * every environment that starts clean, because one `updateMany` ran before
   * the rows it matched existed. It healed on the second run, so the seed's
   * own idempotence test — which counted providers and services — passed
   * either way. The defect was in a COLUMN, and no count can see a column.
   *
   * So this asserts the whole database instead: every table, every column of
   * every row, run 1 against run 2. Any statement whose effect depends on rows
   * created later in the same pass differs between the two runs by
   * construction, whichever direction it is wrong in.
   *
   * Discovered from `information_schema`, deliberately, and this is the one
   * place in the repo where discovery beats the explicit list in
   * `testing/reset.ts`: a seeded table nobody remembers to add here is exactly
   * the table the next instance of this bug will live in.
   *
   * `id` is excluded along with the timestamps: the seed replaces a colour's
   * segments rather than appending them (and must), so those rows carry fresh
   * cuids on every pass. Their CONTENT is what has to be stable.
   */
  it('changes nothing on a second run — every column of every table (checkpoint 3)', async () => {
    const shape = async (): Promise<Record<string, string>> => {
      const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            AND table_name NOT LIKE '\\_prisma%'
          ORDER BY table_name`,
      );
      const out: Record<string, string> = {};
      for (const { table_name } of tables) {
        const [row] = await prisma.$queryRawUnsafe<{ n: bigint; digest: string }[]>(
          `SELECT count(*)::bigint AS n, md5(coalesce(string_agg(d, '' ORDER BY d), '')) AS digest
             FROM (SELECT md5((to_jsonb(t) - 'id' - 'createdAt' - 'updatedAt')::text) AS d
                     FROM "${table_name}" t) s`,
        );
        out[table_name] = `${row!.n} rows / ${row!.digest}`;
      }
      return out;
    };

    await seedSetup(prisma);
    const first = await shape();
    await seedSetup(prisma);
    const second = await shape();

    // Compared as whole objects so the failure names the offending TABLE, not
    // just "false !== true".
    expect(second).toEqual(first);
    // The detector is worthless against an empty database, and a truncate that
    // silently outran the seed would leave it exactly that.
    expect(Object.values(first).some((v) => !v.startsWith('0 rows'))).toBe(true);
  });

  it('never rosters more providers than there are chairs (D-20)', async () => {
    const { providerIds } = await seedSetup(prisma);
    expect(providerIds.length).toBeLessThanOrEqual(CHAIR_COUNT);
  });

  // Equal buffers hide whose-buffer bugs; a duration equal to the grid
  // interval hides the removes-multiple-candidates defect (CLAUDE.md).
  it('seeds UNEQUAL buffers, and no duration equal to the 15-minute grid', async () => {
    await seedSetup(prisma);
    const services = await prisma.service.findMany({ orderBy: { displayOrder: 'asc' } });
    const pairs = services.map((s) => `${s.bufferBeforeMinutes}/${s.bufferAfterMinutes}`);
    expect(new Set(pairs).size).toBeGreaterThan(1);
    for (const s of services) {
      expect(s.bufferBeforeMinutes).not.toBe(s.bufferAfterMinutes);
      expect(s.durationMinutes).not.toBe(15);
    }
  });

  it('leaves at least one provider unqualified for at least one service (SVC-02)', async () => {
    const { providerIds, serviceIds } = await seedSetup(prisma);
    const links = await prisma.serviceProvider.count();
    expect(links).toBeLessThan(providerIds.length * serviceIds.length);
  });

  it('seeds a split shift and a mid-window break', async () => {
    await seedSetup(prisma);
    const thursday = await prisma.weeklyWindow.findMany({ where: { weekday: 4, providerId: { not: null } } });
    const byProvider = new Map<string, number>();
    for (const w of thursday) byProvider.set(w.providerId!, (byProvider.get(w.providerId!) ?? 0) + 1);
    expect([...byProvider.values()]).toContain(2); // the split shift
    expect(await prisma.windowBreak.count()).toBeGreaterThan(0);
  });

  it('seeds a closed date override — isClosed with no child windows (AVAIL-02)', async () => {
    await seedSetup(prisma);
    const override = await prisma.dateOverride.findFirstOrThrow({ where: { isClosed: true } });
    expect(override.day.trim()).toBe('2026-07-04');
    expect(await prisma.dateOverrideWindow.count({ where: { dateOverrideId: override.id } })).toBe(0);
  });

  it('seeds business-level hours distinct from provider hours (AVAIL-04)', async () => {
    await seedSetup(prisma);
    expect(await prisma.weeklyWindow.count({ where: { providerId: null } })).toBeGreaterThan(0);
    expect(await prisma.weeklyWindow.count({ where: { providerId: { not: null } } })).toBeGreaterThan(0);
  });

  it('refuses to run in production', async () => {
    try {
      vi.stubEnv('NODE_ENV', 'production');
      await expect(seedSetup(prisma)).rejects.toThrow(/production/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
