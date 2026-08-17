/**
 * THE CUSTOMER'S CREDENTIAL (TOKEN-01..03, D-5). Pure.
 *
 * The third credential in this package, alongside the staff password
 * (`password.ts`) and the staff session (`session.ts`), and deliberately
 * unlike either:
 *
 *  - NOT a session. A session says "this is who you are" and unlocks
 *    everything that identity may do. A manage token says "this is which
 *    appointment you may touch" and unlocks nothing else — the scope is the
 *    row, not the person.
 *  - NOT signed like the session cookie. A signed payload can be read by
 *    whoever holds it, and D-10 forbids an internal identifier reaching a
 *    customer surface — the URL is a customer surface. This token is opaque
 *    random bytes: it *contains* nothing, it is *looked up*.
 *  - NOT scrypt-hashed like the password. scrypt's cost exists to make a
 *    guessable secret expensive to guess. 256 bits from a CSPRNG is not
 *    guessable, so the cost would buy nothing and would be paid on every page
 *    load of a link a customer clicks from a text message. The hash is here so
 *    that a leaked database dump is not a folder of live links.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type Instant, instant } from '../time';

/**
 * D-5: the link stays usable until 24 hours after the appointment ENDS, not
 * until it starts. A customer who was a no-show, or who wants to check what
 * time she was actually in, still gets an answer the next morning; a link that
 * died at the appointment's start would send her to the phone.
 *
 * A PHYSICAL duration, not "the next day at the same time". Across a DST
 * transition those differ by an hour, and an expiry is a physical moment.
 */
export const MANAGE_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

/** 256 bits. base64url so it survives a URL path, an SMS, and a copy-paste out
 *  of an email client that helpfully "fixes" punctuation. */
const TOKEN_BYTES = 32;

export interface MintedManageToken {
  /** Shown ONCE, put in the link, never stored. */
  token: string;
  /** What the database holds. */
  tokenHash: string;
}

export function mintManageToken(): MintedManageToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashManageToken(token) };
}

/** Deterministic, so a lookup is an indexed equality rather than a scan over
 *  every live token verifying one at a time. */
export function hashManageToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** When a token issued for an appointment ending at `endAt` stops working. */
export function manageTokenExpiry(endAt: Instant): Instant {
  return instant(endAt + MANAGE_TOKEN_GRACE_MS);
}
