/**
 * The barrier for a race whose guard is a conditional `UPDATE` (spec §4.5).
 *
 * Takes the row's lock on a separate connection, starts `run`, and releases
 * the lock only once `waiters` transactions are queued on it. By then every
 * one of them has done its read (MVCC reads never block) and reached its
 * write, so "both read the same state before either wrote" is an ENFORCED
 * interleaving rather than a sampled one. Without it the calls usually run
 * in sequence, the second legitimately sees the first's write, and the test
 * passes or fails on scheduling.
 *
 * `pg_locks.granted = false` IS the happens-before edge. Polling a real
 * database condition, never a timer. It counts database-wide, which is sound
 * only because test files run serially (`fileParallelism: false`).
 */
import { Client as PgClient } from 'pg';

export async function behindRowLock<T>(
  table: 'Appointment' | 'Client',
  id: string,
  waiters: number,
  run: () => Promise<T>,
): Promise<T> {
  const holder = new PgClient({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM "${table}" WHERE id = $1 FOR UPDATE`, [id]);
    const pending = run();
    // Observed below; this only stops an early rejection being reported as
    // unhandled while the barrier is still waiting.
    pending.catch(() => {});
    for (;;) {
      const { rows } = await holder.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_locks WHERE locktype IN ('tuple','transactionid') AND NOT granted`,
      );
      if (Number(rows[0]?.n ?? 0) >= waiters) break;
    }
    await holder.query('COMMIT');
    return await pending;
  } finally {
    await holder.end();
  }
}
