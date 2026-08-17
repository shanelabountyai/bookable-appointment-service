/**
 * A-013 — what a manage token is, and when it dies (TOKEN-01, D-5).
 *
 * Pure: no database, no clock. Every expiry here is arithmetic on a supplied
 * instant, which is the only way the DST cases below can be asserted at all.
 */
import { describe, expect, it } from 'vitest';
import { fromDate, instant, instantFromIso, toDate } from '../time';
import { MANAGE_TOKEN_GRACE_MS, hashManageToken, manageTokenExpiry, mintManageToken } from './manage-token';

const at = (iso: string) => instantFromIso(iso);

describe('minting (TOKEN-01)', () => {
  it('is opaque — the token carries no identifier of anything', () => {
    // The point of a lookup token over a signed one (D-10, TOKEN-03): the URL
    // is a customer surface, and this one cannot contain an appointment id
    // because it is not derived from anything.
    const { token } = mintManageToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes, base64url, unpadded.
    expect(token).toHaveLength(43);
  });

  it('never mints the same token twice', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => mintManageToken().token));
    expect(tokens.size).toBe(500);
  });

  it('stores a hash that is not the token', () => {
    const { token, tokenHash } = mintManageToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes deterministically, so a lookup is an equality', () => {
    const { token, tokenHash } = mintManageToken();
    expect(hashManageToken(token)).toBe(tokenHash);
    // And a near miss is not a near miss.
    expect(hashManageToken(`${token}x`)).not.toBe(tokenHash);
  });
});

describe('expiry (D-5: end + 24h)', () => {
  it('expires 24 hours after the appointment ENDS, not after it starts', () => {
    const end = at('2026-06-09T11:00:00-05:00');
    expect(manageTokenExpiry(end)).toBe(instant(end + MANAGE_TOKEN_GRACE_MS));
    expect(toDate(manageTokenExpiry(end)).toISOString()).toBe('2026-06-10T16:00:00.000Z');
  });

  /**
   * THE REASON THE GRACE IS A DURATION AND NOT "TOMORROW AT THE SAME TIME".
   *
   * An appointment ending the evening before spring-forward: 24 PHYSICAL hours
   * later is 25 hours on the wall, so the link dies at 17:00 rather than 16:00.
   * A calendar-day implementation would give the customer an hour less on one
   * day of the year and an hour more on another, silently, and every test that
   * did not run in March would pass.
   */
  it('is a physical 24 hours across spring-forward', () => {
    // 2026-03-08 is the US spring-forward day (spec §3's verified instants).
    const end = at('2026-03-07T16:00:00-06:00'); // Saturday 16:00 CST
    const expiry = toDate(manageTokenExpiry(end));
    expect(expiry.toISOString()).toBe('2026-03-08T22:00:00.000Z');
    // On the wall in Chicago that is 17:00 CDT the next day — an hour later
    // than the appointment ended, because an hour of that day did not exist.
    expect(fromDate(expiry) - end).toBe(MANAGE_TOKEN_GRACE_MS);
  });

  it('is a physical 24 hours across fall-back', () => {
    // 2026-11-01 is the US fall-back day.
    const end = at('2026-10-31T16:00:00-05:00'); // Saturday 16:00 CDT
    const expiry = toDate(manageTokenExpiry(end));
    expect(expiry.toISOString()).toBe('2026-11-01T21:00:00.000Z');
    // 15:00 CST the next day — an hour EARLIER on the wall, same 24 hours.
    expect(fromDate(expiry) - end).toBe(MANAGE_TOKEN_GRACE_MS);
  });
});
