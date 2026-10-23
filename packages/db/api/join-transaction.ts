/**
 * W-006 (W-D16) — run a `packages/db` domain function INSIDE the caller's
 * transaction.
 *
 * Every write in this package opens its own `prisma.$transaction(async (tx) =>
 * …)` — correctly, because each is a unit the desk calls on its own. The API
 * needs one more thing in the same unit: the idempotency record's outcome
 * (§6.6, "the write and the `done` update commit in one transaction with the
 * domain write"). Prisma's interactive transactions do not nest, so this hands
 * the domain function a client that IS the outer transaction, whose
 * `$transaction(fn)` opens a SAVEPOINT instead of a new transaction:
 *
 *   - success: `RELEASE SAVEPOINT`, and the work commits with the outer COMMIT;
 *   - failure: `ROLLBACK TO SAVEPOINT` before rethrowing, so the transaction is
 *     usable again for whatever the domain function does in its own `catch`
 *     (`bookAppointment` recomputes alternatives after a constraint refusal —
 *     on an aborted transaction that query would fail with 25P02 and the API
 *     would answer 500 instead of SLOT_TAKEN).
 *
 * The domain function is not changed and cannot tell: it receives something
 * shaped like the `PrismaClient` it asks for. Its locks (`pg_advisory_xact_lock`)
 * are held until the OUTER commit, slightly longer than at the desk; its
 * `$transaction` options (timeouts) are the outer transaction's to set.
 * Only the callback form exists in this package; the array form is refused
 * loudly rather than silently run outside the savepoint.
 */
import type { Prisma, PrismaClient } from '../generated/client/index.js';

let depth = 0;

export function joinTransaction(tx: Prisma.TransactionClient): PrismaClient {
  const joined: PrismaClient = new Proxy(tx as unknown as PrismaClient, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return async (fn: unknown) => {
          if (typeof fn !== 'function') throw new Error('joinTransaction: only the callback form of $transaction can join an outer transaction.');
          const name = `w_join_${++depth}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
          try {
            const result = await (fn as (c: PrismaClient) => Promise<unknown>)(joined);
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
            return result;
          } catch (error) {
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
            throw error;
          }
        };
      }
      if (prop === '$connect' || prop === '$disconnect') return async () => {};
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return joined;
}
