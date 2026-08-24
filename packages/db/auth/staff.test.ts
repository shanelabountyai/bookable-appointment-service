/**
 * A-005 — staff authentication against the real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import {
  InvalidCredential,
  InvalidPin,
  TooManyAttempts,
  authenticateStaff,
  findStaffById,
  listStaff,
  listSwitchableStaff,
  resolveStaffNames,
  saveStaffMember,
  verifyStaffPin,
} from './staff';
import { seedStaffUser } from './seed-staff';
import { instant, instantFromIso, toDate } from '../../core/time';
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
    // The seeded account is the OWNER (A-050) — the same thing the
    // migration's backfill says about every row that already had a password.
    expect(staff).toEqual({ id: staffUserId, businessId, email: EMAIL, name: 'Front desk', role: 'owner' });
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
    expect(await findStaffById(prisma, staffUserId)).toEqual({
      id: staffUserId,
      businessId,
      email: EMAIL,
      name: 'Front desk',
      role: 'owner',
    });
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

/**
 * A-050 — PER-PERSON CREDENTIALS, TWO ROLES, AND A BRAKE ON BOTH DOORS.
 *
 * Before this item the salon had four names on the audit trail and one
 * password under the desk, and the only brute-force control anywhere was the
 * scrypt cost.
 */
describe('A-050 — credentials, roles and rate limiting', () => {
  const add = (name: string, extra: Parameters<typeof saveStaffMember>[1] extends infer T ? Partial<T> : never = {}) =>
    saveStaffMember(prisma, { businessId, name, ...extra });

  describe('the role', () => {
    it('defaults a new person to staff, so access is never granted by existing', async () => {
      const { id } = await add('Priya', { pin: '4821' });
      expect((await prisma.staffUser.findUniqueOrThrow({ where: { id } })).role).toBe('staff');
      expect(await findStaffById(prisma, id)).toMatchObject({ role: 'staff' });
    });

    it('carries onto the identity every guard reads', async () => {
      const { id } = await add('Marcus', { pin: '9137', email: 'marcus@shear-genius.test', password: 'long-enough-one', role: 'owner' });
      expect(await authenticateStaff(prisma, 'marcus@shear-genius.test', 'long-enough-one')).toMatchObject({
        role: 'owner',
      });
      expect(await verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '9137' })).toMatchObject({ role: 'owner' });
    });

    /** THE LOCKOUT GUARD. Demoting the last owner leaves a salon with no
     *  dashboard and no screen that could hand the role back — the state
     *  nothing in the product can recover from. */
    it('refuses to demote the last active owner', async () => {
      await expect(
        saveStaffMember(prisma, { businessId, id: staffUserId, name: 'Front desk', role: 'staff' }),
      ).rejects.toBeInstanceOf(InvalidCredential);
      expect(await findStaffById(prisma, staffUserId)).toMatchObject({ role: 'owner' });
    });

    /** The same refusal through the OTHER door, which is the reason it lives
     *  in `saveStaffMember` rather than in the role form: taking the only
     *  owner off the roster locks the salon out exactly as demoting her does. */
    it('refuses to deactivate the last active owner', async () => {
      await expect(
        saveStaffMember(prisma, { businessId, id: staffUserId, name: 'Front desk', active: false }),
      ).rejects.toBeInstanceOf(InvalidCredential);
    });

    it('allows the demotion once somebody else is an owner', async () => {
      await add('Marcus', { email: 'marcus@shear-genius.test', password: 'long-enough-one', role: 'owner' });
      await saveStaffMember(prisma, { businessId, id: staffUserId, name: 'Front desk', role: 'staff' });
      expect(await findStaffById(prisma, staffUserId)).toMatchObject({ role: 'staff' });
    });

    /** A deactivated owner is not an owner who can hand the role back. */
    it('does not count a deactivated owner as the somebody else', async () => {
      const { id } = await add('Marcus', { email: 'marcus@shear-genius.test', password: 'long-enough-one', role: 'owner' });
      await saveStaffMember(prisma, { businessId, id, name: 'Marcus', active: false });

      await expect(
        saveStaffMember(prisma, { businessId, id: staffUserId, name: 'Front desk', role: 'staff' }),
      ).rejects.toBeInstanceOf(InvalidCredential);
    });
  });

  describe('per-person credentials', () => {
    it('gives an existing roster row a sign-in of its own', async () => {
      const { id } = await add('Priya', { pin: '4821' });
      await saveStaffMember(prisma, {
        businessId,
        id,
        name: 'Priya',
        email: 'PRIYA@Shear-Genius.test',
        password: 'her-own-password',
      });

      // Normalized on the way in, so whoever types it next finds the row.
      expect(await authenticateStaff(prisma, 'priya@shear-genius.test', 'her-own-password')).toMatchObject({
        id,
        name: 'Priya',
        role: 'staff',
      });
    });

    /** A password with no email is a credential that can never be used —
     *  `authenticateStaff` finds by email. Refused at the form rather than
     *  stored and discovered later. */
    it('refuses a password with nothing to sign in with', async () => {
      await expect(add('Priya', { password: 'her-own-password' })).rejects.toBeInstanceOf(InvalidCredential);
    });

    it('refuses a password shorter than the floor', async () => {
      await expect(
        add('Priya', { email: 'priya@shear-genius.test', password: 'short' }),
      ).rejects.toBeInstanceOf(InvalidCredential);
    });

    /** The same rule the PIN has, for the same reason: a blank box on a form
     *  somebody opened to correct a spelling must not sign them out. */
    it('leaves an existing password alone when none is given', async () => {
      const { id } = await add('Priya', { email: 'priya@shear-genius.test', password: 'her-own-password' });
      await saveStaffMember(prisma, { businessId, id, name: 'Priya Nair' });

      expect(await authenticateStaff(prisma, 'priya@shear-genius.test', 'her-own-password')).toMatchObject({
        name: 'Priya Nair',
      });
    });

    /** The unique index is `[businessId, email]`. Two people given the same
     *  sign-in is an ordinary slip on a roster screen, and it reached a server
     *  action as a constraint violation — a 500 where a sentence belongs. The
     *  constraint is still the guard; this is the wording. */
    it('refuses an email somebody else already signs in with, by name', async () => {
      await add('Priya', { email: 'shared@shear-genius.test', password: 'her-own-password' });
      await expect(
        add('Marcus', { email: 'shared@shear-genius.test', password: 'his-own-password' }),
      ).rejects.toBeInstanceOf(InvalidCredential);
      // And the same salon's other business is untouched by it — the index is
      // per business, and so is the check.
      const other = await prisma.business.create({ data: { name: 'Elsewhere', timezone: 'America/Chicago' } });
      await saveStaffMember(prisma, {
        businessId: other.id,
        name: 'Priya',
        email: 'shared@shear-genius.test',
        password: 'her-own-password',
      });
    });

    /** Saving somebody's own row without changing their email must not accuse
     *  them of clashing with themselves. */
    it('does not refuse somebody their own address', async () => {
      const { id } = await add('Priya', { email: 'priya@shear-genius.test', password: 'her-own-password' });
      await saveStaffMember(prisma, { businessId, id, name: 'Priya Nair', email: 'priya@shear-genius.test' });
      expect(await findStaffById(prisma, id)).toMatchObject({ name: 'Priya Nair' });
    });

    it('says whether somebody can sign in at all, without leaking either hash', async () => {
      await add('Priya', { pin: '4821' });
      const roster = await listStaff(prisma, businessId);
      expect(roster.find((row) => row.name === 'Priya')).toMatchObject({ hasPin: true, hasPassword: false, role: 'staff' });
      expect(roster.find((row) => row.name === 'Front desk')).toMatchObject({ hasPassword: true, role: 'owner' });
      expect(JSON.stringify(roster)).not.toContain('$');
    });
  });

  describe('the login limiter', () => {
    /** `now` is INJECTED, so the window is advanced rather than slept
     *  through — a limiter that can only be tested by waiting is a limiter
     *  nobody tests. */
    // Through the one conversion module — `new Date(string)` is banned
    // repo-wide, and a limiter window is physical milliseconds anyway.
    const AT = toDate(instantFromIso('2026-06-09T15:00:00.000Z'));
    const later = (minutes: number) => toDate(instant(instantFromIso('2026-06-09T15:00:00.000Z') + minutes * 60_000));

    it('locks the door after ten wrong passwords, and says so', async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(await authenticateStaff(prisma, EMAIL, 'wrong', AT)).toBeNull();
      }
      // The eleventh is refused before the row is even looked up — and the
      // RIGHT password is refused too, which is the whole point of a lockout.
      await expect(authenticateStaff(prisma, EMAIL, PASSWORD, AT)).rejects.toBeInstanceOf(TooManyAttempts);
    });

    /** The enumeration guard, applied to the limiter itself: an address that
     *  does not exist must lock out exactly as a real one does, or "locked"
     *  becomes the oracle the timing equalisation exists to close. */
    it('locks an address that does not exist, identically', async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(await authenticateStaff(prisma, 'nobody@example.com', 'wrong', AT)).toBeNull();
      }
      await expect(authenticateStaff(prisma, 'nobody@example.com', 'wrong', AT)).rejects.toBeInstanceOf(TooManyAttempts);
      // And the real account is untouched — the buckets are per address.
      expect(await authenticateStaff(prisma, EMAIL, PASSWORD, AT)).not.toBeNull();
    });

    it('opens again once the window has passed', async () => {
      for (let attempt = 0; attempt < 10; attempt++) await authenticateStaff(prisma, EMAIL, 'wrong', AT);
      await expect(authenticateStaff(prisma, EMAIL, PASSWORD, AT)).rejects.toBeInstanceOf(TooManyAttempts);

      expect(await authenticateStaff(prisma, EMAIL, PASSWORD, later(16))).not.toBeNull();
    });

    /** The counter measures FAILURES. A desk that legitimately signs in
     *  eleven times on a Saturday must not lock itself out. */
    it('forgets the count after a successful sign-in', async () => {
      for (let attempt = 0; attempt < 9; attempt++) await authenticateStaff(prisma, EMAIL, 'wrong', AT);
      expect(await authenticateStaff(prisma, EMAIL, PASSWORD, AT)).not.toBeNull();

      for (let attempt = 0; attempt < 9; attempt++) {
        expect(await authenticateStaff(prisma, EMAIL, 'wrong', AT)).toBeNull();
      }
      expect(await authenticateStaff(prisma, EMAIL, PASSWORD, AT)).not.toBeNull();
    });
  });

  describe('the PIN limiter', () => {
    const AT = toDate(instantFromIso('2026-06-09T15:00:00.000Z'));

    /** Tighter than the password door on purpose: four digits is ten
     *  thousand possibilities and this form stands in a room the public is
     *  in, with the names listed beside it. */
    it('locks one name after five wrong PINs', async () => {
      const { id } = await add('Priya', { pin: '4821' });
      for (let attempt = 0; attempt < 5; attempt++) {
        expect(await verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '0000', now: AT })).toBeNull();
      }
      await expect(
        verifyStaffPin(prisma, { businessId, staffUserId: id, pin: '4821', now: AT }),
      ).rejects.toBeInstanceOf(TooManyAttempts);
    });

    /** Per name, so one stylist's fat finger cannot lock the desk out of
     *  everybody else on a Saturday. */
    it('leaves everybody else alone', async () => {
      const { id: priya } = await add('Priya', { pin: '4821' });
      const { id: marcus } = await add('Marcus', { pin: '9137' });
      for (let attempt = 0; attempt < 6; attempt++) {
        await verifyStaffPin(prisma, { businessId, staffUserId: priya, pin: '0000', now: AT }).catch(() => null);
      }

      expect(await verifyStaffPin(prisma, { businessId, staffUserId: marcus, pin: '9137', now: AT })).toMatchObject({
        name: 'Marcus',
      });
    });
  });
});

/**
 * A-052 — shared with the appointment event log (A-037) rather than
 * reimplemented for the availability screen. Deactivated people are included
 * on purpose: "who did this" must still have an answer after somebody leaves.
 */
describe('resolveStaffNames', () => {
  it('maps ids to names, including a deactivated person', async () => {
    const { id: priya } = await saveStaffMember(prisma, { businessId, name: 'Priya' });
    const { id: marcus } = await saveStaffMember(prisma, { businessId, name: 'Marcus' });
    await saveStaffMember(prisma, { businessId, id: marcus, name: 'Marcus', active: false });

    const names = await resolveStaffNames(prisma, [priya, marcus]);
    expect(names.get(priya)).toBe('Priya');
    expect(names.get(marcus)).toBe('Marcus');
  });

  it('ignores an id from nowhere rather than throwing', async () => {
    const names = await resolveStaffNames(prisma, ['does-not-exist']);
    expect(names.size).toBe(0);
  });

  it('does not query at all for an empty batch', async () => {
    expect((await resolveStaffNames(prisma, [])).size).toBe(0);
  });

  it('de-duplicates the input', async () => {
    const { id } = await saveStaffMember(prisma, { businessId, name: 'Priya' });
    const names = await resolveStaffNames(prisma, [id, id, id]);
    expect(names.size).toBe(1);
  });
});
