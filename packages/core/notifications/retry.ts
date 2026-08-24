/**
 * A-051 — WHAT TO DO WITH A SEND THAT FAILED (NOTIF-01, D-14).
 *
 * Before this module a `failed` outbox row was terminal: the A-048 claim
 * matches `pending` or a stale `sending` and nothing else, so a row that
 * failed once was never looked at again. Harmless against a console adapter,
 * and the first thing that bites when a real provider lands — a transient 503
 * becomes a client who is simply never told, silently, forever.
 *
 * PURE, and deliberately so. "Is this worth trying again, and when?" is a
 * policy question with no I/O in it, which means it can be tested against a
 * table of codes rather than against a provider having a bad afternoon.
 *
 * THE SPLIT IS THE POINT: retry a 503, never retry a bad phone number.
 * `ChannelSendError.code` has existed since A-004 for exactly this and was
 * never read — `dispatch.ts` stored `error.message` for a human instead.
 */
import { ChannelSendError } from './adapter';

export type FailureKind = 'transient' | 'permanent';

/**
 * Failures that are about the RECIPIENT, and therefore will fail identically
 * forever. Retrying these is not caution, it is a bill: five attempts at an
 * unsubscribed address is five provider calls and five rejections, and on some
 * providers repeated sends to a known-bad number is what gets a sender
 * throttled.
 *
 * Kept small and about the address on purpose. A misconfigured API key looks
 * permanent to a human and is not: it is fixed by an operator, and a message
 * still in the queue when they fix it goes out.
 */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'invalid_recipient',
  'no_recipient',
  'unsubscribed',
  'blocked',
]);

/**
 * How a failure should be treated.
 *
 * UNKNOWN CODES ARE TRANSIENT, and that default is chosen rather than
 * inherited. The two ways to be wrong are not symmetric: treating a permanent
 * failure as transient costs a bounded handful of provider calls that fail,
 * and the row still lands in `failed` at the end with its reason on a screen.
 * Treating a transient failure as permanent costs a client who is never told,
 * silently — which is the exact defect this item exists to remove. So the
 * safe default is the one with a floor under it.
 *
 * An error that is not a `ChannelSendError` at all — a socket hang-up, a
 * driver bug — is transient for the same reason.
 */
export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof ChannelSendError && PERMANENT_CODES.has(error.code)) return 'permanent';
  return 'transient';
}

/**
 * How many times a row may be CLAIMED in total, first attempt included.
 *
 * Five, because the failure this defends against is a provider having a bad
 * minute, not a provider being down for a day: with the backoff below, the
 * last attempt lands a little over two hours after the first, which is inside
 * the useful life of a reminder for tomorrow morning and well outside the life
 * of a transient 503.
 */
export const MAX_ATTEMPTS = 5;

/**
 * The wait before attempt `attempts + 1`, or null when there are none left.
 *
 * A TABLE, not a formula. Four numbers a person can read and argue with beat
 * `base * factor ** n` plus a cap plus a comment explaining what it evaluates
 * to — and this list is the actual specification: a minute, five minutes,
 * twenty-five minutes, two hours.
 *
 * No jitter. Jitter exists to stop a thundering herd of clients retrying in
 * lockstep; this queue is one salon's messages dispatched by one scheduled
 * job, and the rows are already spread by their own `nextAttemptAt`.
 * ponytail: add jitter if this ever dispatches for many businesses at once.
 */
const BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 25 * 60_000, 2 * 60 * 60_000];

export function retryDelayMs(attempts: number): number | null {
  if (attempts < 1 || attempts >= MAX_ATTEMPTS) return null;
  // `attempts` counts the tries already made, so the first failure (attempts
  // = 1) waits BACKOFF_MS[0].
  return BACKOFF_MS[attempts - 1] ?? null;
}
