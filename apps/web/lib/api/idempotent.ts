/**
 * W-006 — idempotent writes (API PRD §6.6), the HTTP half.
 *
 *   1. `Idempotency-Key` missing → 400 IDEMPOTENCY_REQUIRED; longer than 255 → VALIDATION.
 *   2. CLAIM, committed on its own (`claimIdempotencyKey`):
 *      - not ours, same hash, `done`        → the stored response, byte-for-byte,
 *                                             with `Idempotent-Replayed: true`;
 *      - not ours, different hash           → 422 IDEMPOTENCY_MISMATCH;
 *      - not ours, `in_progress`            → 409 IDEMPOTENCY_IN_PROGRESS.
 *   3. WORK, in ONE transaction: the domain function (through `joinTransaction`,
 *      so its own `$transaction` becomes a savepoint) and the outcome row.
 *      Commit → both. Crash → neither.
 *   4. A refusal the caller should see (SLOT_TAKEN, NOT_FOUND …) is STORED as
 *      the outcome like a success: replaying "that time was taken" must say the
 *      same thing again, not try to book a slot that has since come free under
 *      a key the integration believes already failed. A bug (500) RELEASES the
 *      key, so a retry runs again rather than replaying a crash.
 */
import type { PrismaClient } from '@bookable/db';
import {
  IDEMPOTENCY_KEY_MAX,
  claimIdempotencyKey,
  finishClaim,
  joinTransaction,
  releaseClaim,
  requestHashOf,
} from '@bookable/db/api';
import { type RequestContext, bodyOf } from './http';
import { fail, problemResponse, toProblem } from './problem';

export interface WriteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** What a write handler gets: the parsed body and a client that is the work transaction. */
export interface WriteContext extends RequestContext {
  body: unknown;
  /** Use THIS, not `deps.prisma`, for everything that must commit with the outcome. */
  db: PrismaClient;
  /** Stable for this key's lifetime: hand it to `bookAppointment` as its idempotency key. */
  claimId: string;
}

/**
 * Test seams, both inside the work transaction and both no-ops in production:
 * `beforeWork` is the BARRIER for §9.4's race (the first request is provably
 * mid-flight, claim committed, while the second arrives); `afterWrite` is the
 * CRASH (it throws after the domain write and before the outcome commits).
 */
export interface IdempotencyHooks {
  beforeWork?: () => Promise<void>;
  afterWrite?: () => Promise<void>;
}

const HEADER = 'idempotency-key';

export async function idempotent(ctx: RequestContext, run: (w: WriteContext) => Promise<WriteResult>, hooks: IdempotencyHooks = {}): Promise<Response> {
  const idemKey = ctx.request.headers.get(HEADER);
  if (!idemKey) {
    throw fail('IDEMPOTENCY_REQUIRED', 'Every POST needs an Idempotency-Key header: a value you choose, unique per intended write, reused on retries.', {
      errors: [{ field: 'Idempotency-Key', message: 'missing' }],
    });
  }
  if (idemKey.length > IDEMPOTENCY_KEY_MAX || idemKey.trim() === '') {
    throw fail('VALIDATION', `Idempotency-Key must be 1–${IDEMPOTENCY_KEY_MAX} characters.`, { errors: [{ field: 'Idempotency-Key', message: 'bad length' }] });
  }

  const body = await bodyOf(ctx.request);
  const requestHash = requestHashOf(ctx.request.method, ctx.url.pathname, body);
  const db = ctx.deps.prisma;
  const claim = await claimIdempotencyKey(db, { businessId: ctx.caller.businessId, apiKeyId: ctx.caller.keyId, idemKey, requestHash, now: ctx.now });

  if (!claim.claimed) {
    const row = claim.existing;
    if (row.requestHash !== requestHash) {
      throw fail('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request. Use a new key for a new write.', {
        errors: [{ field: 'Idempotency-Key', message: 'reused with a different body or path' }],
      });
    }
    if (row.status === 'in_progress') {
      throw fail('IDEMPOTENCY_IN_PROGRESS', 'The first request with this Idempotency-Key is still running. Retry in a moment; it will replay the same answer.', {}, { 'Retry-After': '1' });
    }
    return replay(row.responseStatus!, row.responseBody!);
  }

  let outcome: { status: number; text: string; contentType: string; headers: Record<string, string> };
  try {
    outcome = await db.$transaction(
      async (tx) => {
        const joined = joinTransaction(tx);
        let result: { status: number; text: string; contentType: string; headers: Record<string, string> };
        if (hooks.beforeWork) await hooks.beforeWork();
        try {
          const r = await run({ ...ctx, body, db: joined, claimId: claim.id });
          if (hooks.afterWrite) await hooks.afterWrite();
          result = { status: r.status, text: JSON.stringify(r.body), contentType: 'application/json', headers: r.headers ?? {} };
        } catch (error) {
          const mapped = toProblem(error);
          if (!mapped) throw error;
          // A domain refusal is an answer, and answers are replayed. Nothing the
          // work wrote survives: its savepoints rolled back on the way out.
          result = { status: mapped.problem.status, text: JSON.stringify(mapped.problem), contentType: 'application/problem+json', headers: mapped.headers };
        }
        await finishClaim(tx, { id: claim.id, responseStatus: result.status, responseBody: `${result.contentType}\n${result.text}`, now: ctx.now });
        return result;
      },
      // Above Prisma's 5 s: a booking can wait behind D-24's advisory lock.
      { timeout: 20_000 },
    );
  } catch (error) {
    // A bug or a crash: nothing committed. Give the key back so a retry RUNS.
    await releaseClaim(db, claim.id);
    throw error;
  }
  return new Response(outcome.text, {
    status: outcome.status,
    headers: { 'Content-Type': outcome.contentType, 'Cache-Control': 'no-store', ...outcome.headers },
  });
}

function replay(status: number, stored: string): Response {
  const newline = stored.indexOf('\n');
  const contentType = stored.slice(0, newline);
  const text = stored.slice(newline + 1);
  return new Response(text, {
    status,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Idempotent-Replayed': 'true' },
  });
}

export { problemResponse };
