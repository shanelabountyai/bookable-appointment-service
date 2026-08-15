/**
 * Password hashing (D-9). `node:crypto`'s scrypt — no dependency.
 *
 * scrypt is a deliberate choice over bcrypt/argon2 for this project: it is in
 * the standard library, it is memory-hard (which is the property that makes
 * GPU cracking expensive), and it is what Node ships with a well-tested
 * implementation of. Adding argon2 would mean a native build step for a
 * marginal improvement over correctly-parameterised scrypt.
 *
 * NOT simplified: this is a trust boundary, so nothing here is shortened for
 * the sake of a smaller diff — random per-password salt, constant-time
 * comparison, and a self-describing stored format so the parameters can be
 * raised later without invalidating existing hashes.
 */
import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** `promisify(scrypt)` erases the options overload, so it is wrapped by hand.
 *  The options carry the cost parameters, which are the entire security
 *  argument here — losing them to a typing convenience is not an option. */
const scryptAsync = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });

/**
 * OWASP's floor for scrypt is N=2^14, r=8, p=1 (as of writing). Memory cost is
 * 128 * N * r = 16 MiB per hash, which is the point — it is what makes
 * large-scale offline cracking expensive rather than merely slow.
 */
const PARAMS = { N: 16_384, r: 8, p: 1, keylen: 64 } as const;
const SALT_BYTES = 16;

/** Stored as `scrypt$N$r$p$salt$hash`, all hex. Self-describing on purpose:
 *  when the cost parameters are raised, existing hashes still verify against
 *  the parameters they were created with, and can be re-hashed on next login
 *  rather than locking everyone out. */
const FORMAT = 'scrypt';

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length === 0) throw new Error('refusing to hash an empty password');
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(plain, salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  });
  return [FORMAT, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('hex'), derived.toString('hex')].join('$');
}

/**
 * Constant-time verification. Returns false for a malformed stored value
 * rather than throwing — a corrupted row must read as "wrong password" to the
 * caller, never as a distinguishable error a prober could use to tell
 * "account exists but is broken" from "no such account".
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== FORMAT) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'hex');
    expected = Buffer.from(parts[5]!, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(plain, salt, expected.length, { N, r, p });
  } catch {
    // Absurd stored parameters (an N that exceeds maxmem, say) must not crash
    // the login route.
    return false;
  }

  // Lengths are equal by construction above, but timingSafeEqual throws on a
  // mismatch, so this stays explicit rather than relying on that.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * A hash of a throwaway value, for the user-not-found branch of login.
 *
 * Without this, "no such email" returns in microseconds while a real email
 * with a wrong password takes ~100ms of deliberate scrypt work — a timing
 * oracle that turns the login form into a user-enumeration endpoint. The
 * login path verifies against this when it finds no user, so both branches
 * do the same work.
 */
export const DUMMY_HASH_PROMISE: Promise<string> = hashPassword('bookable-dummy-password-for-timing-parity');
