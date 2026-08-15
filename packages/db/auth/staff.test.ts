/**
 * A-005 — staff authentication against the real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { authenticateStaff, findStaffById } from './staff';
import { seedStaffUser } from './seed-staff';

const prisma = new PrismaClient();
const EMAIL = 'owner@shear-genius.test';
const PASSWORD = 'a-real-enough-password';

let staffUserId: string;
let businessId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.staffUser.deleteMany();
  await prisma.business.deleteMany();
  const seeded = await seedStaffUser(prisma, { email: EMAIL, password: PASSWORD });
  staffUserId = seeded.staffUserId;
  businessId = seeded.businessId;
});

describe('authenticateStaff', () => {
  it('accepts the right credential and returns the identity', async () => {
    const staff = await authenticateStaff(prisma, EMAIL, PASSWORD);
    expect(staff).toEqual({ id: staffUserId, businessId, email: EMAIL });
  });

  it('is case-insensitive on email and tolerates surrounding whitespace', async () => {
    expect(await authenticateStaff(prisma, '  OWNER@Shear-Genius.TEST ', PASSWORD)).not.toBeNull();
  });

  it('rejects a wrong password', async () => {
    expect(await authenticateStaff(prisma, EMAIL, 'not the password')).toBeNull();
  });

  it('rejects an unknown email', async () => {
    expect(await authenticateStaff(prisma, 'nobody@example.com', PASSWORD)).toBeNull();
  });

  it('is case-sensitive on the password', async () => {
    expect(await authenticateStaff(prisma, EMAIL, PASSWORD.toUpperCase())).toBeNull();
  });

  // The user-enumeration guard. An unknown email must not return
  // dramatically faster than a known one with a wrong password, or the login
  // form becomes a directory of who has an account.
  //
  // Asserted as a RATIO with a generous bound rather than an absolute
  // millisecond figure: this runs on shared CI hardware, and a tight timing
  // assertion is a flake generator. The bug being guarded against is
  // order-of-magnitude (microseconds vs ~100ms of scrypt), so a 5x bound
  // catches it with room to spare.
  it('takes comparable time for an unknown email and a wrong password', async () => {
    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const start = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    // Warm up, so neither figure pays a one-off cost the other does not.
    await authenticateStaff(prisma, EMAIL, 'warmup');

    const unknownEmail = await time(() => authenticateStaff(prisma, 'nobody@example.com', PASSWORD));
    const wrongPassword = await time(() => authenticateStaff(prisma, EMAIL, 'wrong'));

    const ratio = Math.max(unknownEmail, wrongPassword) / Math.min(unknownEmail, wrongPassword);
    expect(ratio).toBeLessThan(5);
  });
});

describe('findStaffById', () => {
  it('loads a staff user', async () => {
    expect(await findStaffById(prisma, staffUserId)).toEqual({ id: staffUserId, businessId, email: EMAIL });
  });

  // This is what makes a deleted staff user's live sessions stop working on
  // the next request, with no revocation list to maintain.
  it('returns null once the staff user is gone', async () => {
    await prisma.staffUser.delete({ where: { id: staffUserId } });
    expect(await findStaffById(prisma, staffUserId)).toBeNull();
  });
});

describe('seedStaffUser', () => {
  it('is idempotent and resets the password on re-run', async () => {
    const again = await seedStaffUser(prisma, { email: EMAIL, password: 'a-different-password' });
    expect(again.staffUserId).toBe(staffUserId);
    expect(await prisma.staffUser.count()).toBe(1);
    expect(await authenticateStaff(prisma, EMAIL, 'a-different-password')).not.toBeNull();
    expect(await authenticateStaff(prisma, EMAIL, PASSWORD)).toBeNull();
  });

  // The guard that makes a known-value demo credential acceptable at all.
  it('refuses to run in production', async () => {
    const original = process.env.NODE_ENV;
    try {
      vi.stubEnv('NODE_ENV', 'production');
      await expect(seedStaffUser(prisma, { email: 'x@y.test', password: 'p' })).rejects.toThrow(/production/);
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(original);
    }
  });
});
