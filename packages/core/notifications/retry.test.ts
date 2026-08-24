/**
 * A-051 — the retry policy, tested as a table rather than against a provider
 * having a bad afternoon. That is the whole reason it is a pure module.
 */
import { describe, expect, it } from 'vitest';
import { ChannelSendError } from './adapter';
import { MAX_ATTEMPTS, classifyFailure, retryDelayMs } from './retry';

describe('classifyFailure', () => {
  /** The rule in one line: retry a 503, never retry a bad phone number. */
  it('treats failures about the recipient as permanent', () => {
    for (const code of ['invalid_recipient', 'no_recipient', 'unsubscribed', 'blocked']) {
      expect(classifyFailure(new ChannelSendError(code, 'nope'))).toBe('permanent');
    }
  });

  it('treats provider-side failures as transient', () => {
    for (const code of ['rate_limited', 'server_error', 'temporarily_unavailable', 'timeout']) {
      expect(classifyFailure(new ChannelSendError(code, 'later'))).toBe('transient');
    }
  });

  /**
   * THE DEFAULT IS CHOSEN, NOT INHERITED, and the asymmetry is the argument.
   * A permanent failure treated as transient costs a bounded handful of calls
   * that fail, and the row still lands in `failed` with its reason on a
   * screen. A transient failure treated as permanent costs a client who is
   * never told, silently — the exact defect this item removes.
   */
  it('defaults an unknown code to transient', () => {
    expect(classifyFailure(new ChannelSendError('who_knows', 'a code from a future provider'))).toBe('transient');
  });

  /** A socket hang-up or a driver bug is not a `ChannelSendError` at all. */
  it('defaults a plain error to transient', () => {
    expect(classifyFailure(new Error('ECONNRESET'))).toBe('transient');
    expect(classifyFailure('a string nobody should have thrown')).toBe('transient');
  });

  /** An authentication failure LOOKS permanent and is not: an operator fixes
   *  the key, and a message still in the queue then goes out. */
  it('does not treat a misconfiguration as permanent', () => {
    expect(classifyFailure(new ChannelSendError('authentication_failed', 'bad key'))).toBe('transient');
  });
});

describe('retryDelayMs', () => {
  it('grows: a minute, five minutes, twenty-five minutes, two hours', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(5 * 60_000);
    expect(retryDelayMs(3)).toBe(25 * 60_000);
    expect(retryDelayMs(4)).toBe(2 * 60 * 60_000);
  });

  it('gives up once the attempts are spent', () => {
    expect(retryDelayMs(MAX_ATTEMPTS)).toBeNull();
    expect(retryDelayMs(MAX_ATTEMPTS + 1)).toBeNull();
  });

  /** A guard, not a case anybody should reach: `attempts` is post-increment,
   *  so the first failure is always 1. Zero would mean the claim did not count. */
  it('refuses a nonsensical attempt count rather than indexing off the end', () => {
    expect(retryDelayMs(0)).toBeNull();
    expect(retryDelayMs(-1)).toBeNull();
  });

  /** The last attempt lands a little over two hours after the first — inside
   *  the useful life of a reminder for tomorrow morning. */
  it('spends its whole budget within about two and a half hours', () => {
    let total = 0;
    for (let attempts = 1; attempts < MAX_ATTEMPTS; attempts++) total += retryDelayMs(attempts)!;
    expect(total).toBeLessThan(3 * 60 * 60_000);
    expect(total).toBeGreaterThan(2 * 60 * 60_000);
  });
});
