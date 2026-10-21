/**
 * W-006 — idempotent writes (API PRD §6.6), the database half.
 *
 * THE CLAIM IS ONE STATEMENT: `INSERT … ON CONFLICT ("apiKeyId","idemKey") DO
 * UPDATE … WHERE <expired or abandoned> RETURNING`. The unique index is the
 * mechanism — never a read-then-write (A-048's outbox pattern). It returns a
 * row exactly when THIS caller owns the key now:
 *   - a fresh key (the INSERT);
 *   - an EXPIRED record (24 h, §6.6) — a new request that happens to reuse an
 *     old key; it gets a NEW `id`, so nothing derived from the old one matches;
 *   - an ABANDONED `in_progress` record — its process died between the claim and
 *     its outcome (W-D16). Reclaiming it is SAFE, because the outcome commits in
 *     the same transaction as the domain write: a claim still `in_progress`
 *     means that write never committed. Bounded by `STALE_AFTER_MS`, far beyond
 *     any live request, so a request is never reclaimed from under itself
 *     (`finishClaim` would throw if it were).
 * Anything else — a live `in_progress` (someone is running it now) or a `done`
 * — is answered from the row by the caller.
 *
 * The CLAIM commits on its own, BEFORE the work: a concurrent request with the
 * same key must see `in_progress` and be told 409, not queue behind an
 * uncommitted INSERT and then replay. The OUTCOME commits in the same
 * transaction as the domain write (`finishClaim` with the work's `tx`), so a
 * crash leaves the claim and nothing else, which `releaseClaim` removes on any
 * thrown failure and `STALE_AFTER_MS` reclaims if the process itself died.
 */
import { createHash, randomUUID } from 'node:crypto';
import { fromDate, instant, toDate } from '../../core/time';
import { canonicalJson } from '../mcp/proposals';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** §6.6: a replay window of 24 hours. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * W-D16: an `in_progress` claim older than this is treated as abandoned. Far
 * longer than any request can run (the work transaction times out at 20 s), so
 * a LIVE request is never reclaimed under itself.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX = 255;

/** SHA-256 of method + path + canonical body: the same request, however its JSON keys were ordered. */
export function requestHashOf(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`).digest('hex');
}

export interface IdempotencyRow {
  id: string;
  requestHash: string;
  status: 'in_progress' | 'done';
  responseStatus: number | null;
  responseBody: string | null;
}

export type ClaimOutcome = { claimed: true; id: string } | { claimed: false; existing: IdempotencyRow };

export async function claimIdempotencyKey(
  db: Db,
  args: { businessId: string; apiKeyId: string; idemKey: string; requestHash: string; now: Date },
): Promise<ClaimOutcome> {
  const expiresAt = toDate(instant(fromDate(args.now) + IDEMPOTENCY_TTL_MS));
  const staleBefore = toDate(instant(fromDate(args.now) - STALE_AFTER_MS));
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "IdempotencyRecord" ("id", "businessId", "apiKeyId", "idemKey", "requestHash", "status", "expiresAt", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${args.businessId}, ${args.apiKeyId}, ${args.idemKey}, ${args.requestHash}, 'in_progress', ${expiresAt}, ${args.now}, ${args.now})
    ON CONFLICT ("apiKeyId", "idemKey") DO UPDATE SET
      "id" = CASE WHEN "IdempotencyRecord"."expiresAt" <= ${args.now} THEN EXCLUDED."id" ELSE "IdempotencyRecord"."id" END,
      "requestHash" = EXCLUDED."requestHash",
      "status" = 'in_progress',
      "responseStatus" = NULL,
      "responseBody" = NULL,
      "expiresAt" = EXCLUDED."expiresAt",
      "createdAt" = EXCLUDED."createdAt",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "IdempotencyRecord"."expiresAt" <= ${args.now}
       OR ("IdempotencyRecord"."status" = 'in_progress'
           AND "IdempotencyRecord"."updatedAt" <= ${staleBefore}
           AND "IdempotencyRecord"."requestHash" = EXCLUDED."requestHash")
    RETURNING "id"
  `;
  if (rows[0]) return { claimed: true, id: rows[0].id };
  const existing = await db.idempotencyRecord.findUniqueOrThrow({
    where: { apiKeyId_idemKey: { apiKeyId: args.apiKeyId, idemKey: args.idemKey } },
    select: { id: true, requestHash: true, status: true, responseStatus: true, responseBody: true },
  });
  return { claimed: false, existing };
}

/** The outcome, recorded — call with the WORK's transaction so it commits or rolls back with the write. */
export async function finishClaim(db: Db, args: { id: string; responseStatus: number; responseBody: string; now: Date }): Promise<void> {
  const { count } = await db.idempotencyRecord.updateMany({
    where: { id: args.id, status: 'in_progress' },
    data: { status: 'done', responseStatus: args.responseStatus, responseBody: args.responseBody, updatedAt: args.now },
  });
  // A claim that is no longer ours means something reclaimed it under a live request — the one thing W-D16's window must prevent.
  if (count !== 1) throw new Error(`IdempotencyRecord ${args.id} was not in_progress when its outcome was recorded.`);
}

/** The work failed with something nobody should replay (a bug, a crash): give the key back. */
export async function releaseClaim(db: Db, id: string): Promise<void> {
  await db.idempotencyRecord.deleteMany({ where: { id, status: 'in_progress' } });
}

/** Rows past their replay window, for the hourly job (W-009). */
export async function pruneIdempotencyRecords(db: Db, now: Date): Promise<number> {
  return (await db.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: now } } })).count;
}
