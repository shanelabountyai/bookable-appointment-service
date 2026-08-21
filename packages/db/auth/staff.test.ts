/**
 * A-005 — staff authentication against the real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import {
  InvalidPin,
  authenticateStaff,
  findStaffById,
  listStaff,
  listSwitchableStaff,
  saveStaffMember,
  verifyStaffPin,
} from './staff';
import { seedStaffUser } from './seed-staff';
import { resetDatabase } from '../testing';

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
  await resetDatabase(prisma);
  const seeded = await seedStaffUser(prisma, { email: EMAIL, password: PASSWORD });
  staffUserId = seeded.staffUserId;
  businessId = seeded.businessId;
});

describe('authenticateStaff', () => {
  it('accepts the right credential and returns the identity', async () => {
    const staff = await authenticateStaff(prisma, EMAIL, PASSWORD);
    expect(staff).toEqual({ id: staffUserId, businessId, email: EMAIL, name: 'Front desk' });
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
    expect(await findStaffById(prisma, staffUserId)).toEqual({ id: staffUserId, businessId, email: EMAIL, name: 'Front desk' });
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

/**
 * A-037 / D-33 — THE DESK SWITCH.
 *
 * The PIN is NOT the login. It acts inside a session that was already opened
 * with a real credential, and decides only whose name goes on the next
 * mutation. Everything below is about that boundary holding.
 */
describe('A-037 — named staff identity', () => {
  const add = (name: string, pin?: string, over: { businessId?: string } = {}) =>
    saveStaffMember(prisma, { businessId: over.businessId ?? businessId, name, ...(pin ? { pin } : {}) });

  describe('saveStaffMember', () => {
    /** A stylist who needs her name on a check-in does not need a way to sign
     *  in from home. A credential nobody asked for is one somebody has to
     *  rotate. */
    it('adds an identity with no account at all', async () => {
      const { id } = await add('Priya', '4821');

      const row = await prisma.staffUser.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe('Priya');
      expect(row.email).toBeNull();
      expect(row.passwordHash).toBeNull();
      expect(row.active).toBe(true);
      // Hashed, never stored as typed.
      expect(row.pinHash).not.toBe('4821');
    });

    it('allows several account-less identities, which a unique email index must tolerate', async () => {
      await add('Priya', '4821');
      await add('Marcus', '9137');
      expect(await prisma.staffUser.count({ where: { email: null } })).toBe(2);
    });

    it('refuses a PIN that is not 4 to 6 digits', async () => {
      await expect(add('Priya', '123')).rejects.toBeInstanceOf(InvalidPin);
      await expect(add('Priya', '12345678')).rejects.toBeInstanceOf(InvalidPin);
      await expect(add('Priya', 'abcd')).rejects.toBeInstanceOf(InvalidPin);
    });

    /** Correcting a spelling must not silently drop somebody off the
     *  switcher — which is the kind of thing nobody notices until the log
     *  says "the front desk" again. */
    it('leaves an existing PIN alone when none is given', async () => {
      const { id } = await add('Prya', '4821');
      await saveStaffMember(prisma, { businessId, id, name: 'Priya' });

      expect(await verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '4821' })).toMatchObject({
        name: 'Priya',
      });
    });

    it('clears a PIN only when asked to', async () => {
      const { id } = await add('Priya', '4821');
      await saveStaffMember(prisma, { businessId, id, name: 'Priya', clearPin: true });

      expect(await verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '4821' })).toBeNull();
      expect(await listSwitchableStaff(prisma, businessId)).toHaveLength(0);
    });

    it('edits nothing when the id belongs to another business', async () => {
      const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
      const { id } = await add('Priya', '4821', { businessId: other.id });

      await expect(saveStaffMember(prisma, { businessId, id, name: 'Hijacked' })).rejects.toThrow();
      expect((await prisma.staffUser.findUniqueOrThrow({ where: { id } })).name).toBe('Priya');
    });
  });

  describe('verifyStaffPin', () => {
    it('accepts the right PIN and returns the name to stamp', async () => {
      const { id } = await add('Priya', '4821');
      expect(await verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '4821' })).toMatchObject({
        id,
        businessId,
        name: 'Priya',
      });
    });

    it('rejects the wrong PIN', async () => {
      const { id } = await add('Priya', '4821');
      expect(await verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '1234' })).toBeNull();
    });

    it('rejects somebody who has no PIN set', async () => {
      const { id } = await add('Priya');
      expect(await verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '4821' })).toBeNull();
    });

    /** The whole security boundary of the switch: a session may only put a
     *  name from ITS OWN salon onto ITS OWN audit log. */
    it('refuses a staff member from another business, right PIN and all', async () => {
      const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
      const { id } = await add('Priya', '4821', { businessId: other.id });

      expect(await verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '4821' })).toBeNull();
    });

    it('refuses somebody who has been taken off the roster', async () => {
      const { id } = await add('Priya', '4821');
      await saveStaffMember(prisma, { businessId, id, name: 'Priya', active: false });

      expect(await verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '4821' })).toBeNull();
    });
  });

  describe('the roster', () => {
    it('offers only active people who have a PIN', async () => {
      await add('Priya', '4821');
      await add('Marcus'); // no PIN — has no fast path
      const { id: gone } = await add('Sam', '5150');
      await saveStaffMember(prisma, { businessId, id: gone, name: 'Sam', active: false });

      expect((await listSwitchableStaff(prisma, businessId)).map((o) => o.name)).toEqual(['Priya']);
    });

    /** Off-boarding hides somebody from the switcher, never from the owner. */
    it('still lists the deactivated, and never leaks a hash', async () => {
      const { id } = await add('Sam', '5150');
      await saveStaffMember(prisma, { businessId, id, name: 'Sam', active: false });

      const sam = (await listStaff(prisma, businessId)).find((row) => row.id === id);
      expect(sam).toMatchObject({ name: 'Sam', active: false, hasPin: true });
      expect(JSON.stringify(sam)).not.toContain('$');
    });

    /** Deactivation is the off-boarding path BECAUSE the name has to survive
     *  on every event it ever stamped. Deleting the row would take the answer
     *  to "who moved this appointment" with it. */
    it('ends live sessions on deactivation without losing the row', async () => {
      const { id } = await add('Priya', '4821');
      await saveStaffMember(prisma, { businessId, id, name: 'Priya', active: false });

      expect(await findStaffById(prisma, id)).toBeNull();
      expect(await prisma.staffUser.findUnique({ where: { id } })).not.toBeNull();
    });
  });

  /** A PIN-only identity has no password, so the sign-in form can never be a
   *  way in for one. */
  it('cannot sign in as an account-less identity', async () => {
    await add('Priya', '4821');
    expect(await authenticateStaff(prisma, '', '4821')).toBeNull();
    expect(await authenticateStaff(prisma, 'Priya', '4821')).toBeNull();
  });
});
