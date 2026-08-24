/**
 * A-013 — the rate limiter behind the manage-link route (TOKEN-02: "the route
 * is rate-limited (it returns PII)").
 *
 * ONE STATEMENT, no transaction, no lock. `INSERT ... ON CONFLICT DO UPDATE
 * ... RETURNING` is atomic by itself: concurrent callers on the same key
 * serialize on the row and every one of them gets a distinct count back. A
 * read-then-write — even inside a transaction — is the check-then-write shape
 * this repo refuses everywhere else, and under READ COMMITTED it lets two
 * requests both read 9 and both write 10.
 *
 * ponytail: a FIXED window that opens on the first request, not a sliding one.
 * The known ceiling is that a caller can spend the budget at the end of one
 * window and again at the start of the next — up to 2x the limit across the
 * boundary. That is irrelevant against the thing this defends (bulk PII
 * retrieval over minutes and hours) and a sliding window costs a per-request
 * row per hit. Upgrade path if it ever matters: keep a timestamp array or
 * switch to a token bucket, same call signature.
 */
import { fromDate, instant, toDate } from '../core/time';
import type { Prisma, PrismaClient } from './generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface RateLimitInput {
  /** Namespaced by the caller, e.g. `manage:203.0.113.7`. */
  key: string;
  /** Requests permitted per window. */
  limit: number;
  windowMs: number;
  /** Injected, never read from the clock here — a limiter whose window cannot
   *  be advanced by a test can only be tested by sleeping. */
  now: Date;
}

/** True if this request is within the limit. False means refuse it — the
 *  request has still been counted, so hammering a closed door keeps it closed. */
export async function consumeRateLimit(db: Db, input: RateLimitInput): Promise<boolean> {
  // Through the one conversion module, like every other instant in this repo —
  // a window length is physical milliseconds and never a calendar quantity.
  const windowOpenedBefore = toDate(instant(fromDate(input.now) - input.windowMs));

  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitCounter" ("key", "windowStart", "count", "updatedAt")
    VALUES (${input.key}, ${input.now}, 1, ${input.now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitCounter"."windowStart" <= ${windowOpenedBefore} THEN 1
        ELSE "RateLimitCounter"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "RateLimitCounter"."windowStart" <= ${windowOpenedBefore} THEN ${input.now}
        ELSE "RateLimitCounter"."windowStart"
      END,
      "updatedAt" = ${input.now}
    RETURNING "count"
  `;

  return (rows[0]?.count ?? 1) <= input.limit;
}

/**
 * Forgets a key — called after a SUCCESSFUL attempt, so the counter measures
 * failures rather than usage.
 *
 * Without this, `consumeRateLimit` counts every try including the right ones,
 * and a front desk that legitimately signs in eleven times during a busy
 * Saturday is locked out by its own success. An attacker who guesses correctly
 * has no further use for the budget they just cleared, so resetting on success
 * costs nothing that was defending anything.
 */
export async function resetRateLimit(db: Db, key: string): Promise<void> {
  await db.rateLimitCounter.deleteMany({ where: { key } });
}
