/**
 * A-005 — the auth primitives. Pure: no database, no Next, no clock.
 *
 * These are a trust boundary, so the tests are about what must be IMPOSSIBLE,
 * not only about the happy path.
 */
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';
import { MissingSessionSecret, SESSION_TTL_MS, signSession, verifySession } from './session';
import { customerTokenActor, staffActor, systemActor } from './actor';

const SECRET = 'test-secret-not-a-real-one';
const NOW = 1_780_000_000_000;

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
  });

  // Two users choosing the same password must not produce the same row —
  // otherwise one cracked hash cracks every account that shares it, and the
  // hashes themselves reveal which accounts share a password.
  it('produces a different hash every time (random per-password salt)', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('stores parameters in a self-describing format so cost can be raised later', async () => {
    const stored = await hashPassword('x');
    const [format, N, r, p, salt, hash] = stored.split('$');
    expect(format).toBe('scrypt');
    expect(Number(N)).toBeGreaterThanOrEqual(16_384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });

  // A corrupted row must read as "wrong password", never as a distinguishable
  // error a prober could use to tell a broken account from a missing one.
  it.each([
    ['empty', ''],
    ['not our format', 'bcrypt$2b$10$abcdef'],
    ['too few parts', 'scrypt$16384$8$1$deadbeef'],
    ['non-numeric params', 'scrypt$x$y$z$dead$beef'],
    ['empty salt and hash', 'scrypt$16384$8$1$$'],
    ['absurd N', `scrypt$999999999$8$1$dead$beef`],
  ])('returns false (never throws) for a malformed stored hash: %s', async (_label, stored) => {
    await expect(verifyPassword('anything', stored)).resolves.toBe(false);
  });

  it('refuses to hash an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });
});

describe('session tokens', () => {
  it('round-trips a valid session', () => {
    const token = signSession({ sub: 'staff1', exp: NOW + SESSION_TTL_MS }, SECRET);
    expect(verifySession(token, SECRET, NOW)).toEqual({ sub: 'staff1', exp: NOW + SESSION_TTL_MS });
  });

  // The whole point of signing.
  it('rejects a token signed with a different secret', () => {
    const token = signSession({ sub: 'staff1', exp: NOW + SESSION_TTL_MS }, 'attacker-secret');
    expect(verifySession(token, SECRET, NOW)).toBeNull();
  });

  it('rejects a token whose payload was edited to escalate or extend', () => {
    const token = signSession({ sub: 'staff1', exp: NOW + 1000 }, SECRET);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'staff-admin', exp: NOW + 10 ** 12 }), 'utf8').toString(
      'base64url',
    );
    // Same signature, different body — the classic forgery attempt.
    expect(verifySession(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    // And the original still verifies, proving the test isn't passing by accident.
    expect(verifySession(`${body}.${sig}`, SECRET, NOW)).not.toBeNull();
  });

  it('rejects an expired session — expiry lives INSIDE the signature', () => {
    const exp = NOW - 1;
    const token = signSession({ sub: 'staff1', exp }, SECRET);
    expect(verifySession(token, SECRET, NOW)).toBeNull();
    // ...and was valid a moment before it expired.
    expect(verifySession(token, SECRET, exp - 1)).not.toBeNull();
  });

  it.each([
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['empty body', '.abcdef'],
    ['garbage body', '!!!!.abcdef'],
    ['signature only', 'x.'],
    ['payload is not an object', `${Buffer.from('"hello"').toString('base64url')}.sig`],
  ])('returns null (never throws) for a malformed token: %s', (_label, token) => {
    expect(() => verifySession(token, SECRET, NOW)).not.toThrow();
    expect(verifySession(token, SECRET, NOW)).toBeNull();
  });

  // Signed CORRECTLY but shaped wrong. Tests the payload-shape check rather
  // than the signature check — a token this server itself produced from a bad
  // payload must still be refused, so a future bug that mints a malformed
  // session cannot authenticate anyone.
  it.each([
    ['missing exp', { sub: 'staff1' }],
    ['missing sub', { exp: NOW + 1000 }],
    ['sub is not a string', { sub: 1, exp: NOW + 1000 }],
    ['exp is not a number', { sub: 'staff1', exp: 'later' }],
    ['exp is NaN', { sub: 'staff1', exp: Number.NaN }],
  ])('rejects a correctly-signed but malformed payload: %s', (_label, bad) => {
    const properlySigned = signSession(bad as never, SECRET);
    expect(verifySession(properlySigned, SECRET, NOW)).toBeNull();
  });

  // A default secret means every deployment that forgot to set one shares a
  // forgeable key. Failing loudly is the only safe behaviour.
  it('refuses to sign or verify with an empty secret', () => {
    expect(() => signSession({ sub: 'staff1', exp: NOW + 1000 }, '')).toThrow(MissingSessionSecret);
    expect(() => verifySession('a.b', '', NOW)).toThrow(MissingSessionSecret);
  });
});

describe('actors (D-9)', () => {
  it('builds the three actor kinds with the right refs', () => {
    expect(staffActor('staff1')).toEqual({ type: 'staff', ref: 'staff1' });
    expect(customerTokenActor('tok1')).toEqual({ type: 'customer_token', ref: 'tok1' });
    expect(systemActor).toEqual({ type: 'system', ref: null });
  });
});
