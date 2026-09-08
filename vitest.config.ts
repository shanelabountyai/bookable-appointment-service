import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `apps/web/lib` is in here for A-099's lane geometry: it is pure,
    // clock-free and has no `@/` imports, and the alternative was either a
    // second copy of the packing algorithm in a package or shipping the day
    // grid's only non-trivial layout decision with no unit test at all.
    include: ['packages/**/*.test.ts', 'apps/web/lib/**/*.test.ts'],
    // The engine suite must pass under ANY process TZ (D-3). CI runs it twice:
    // once under TZ=UTC and once under TZ=Pacific/Kiritimati (A-001 wires this).
    // Locally, run `TZ=Pacific/Kiritimati npm test` before calling A-008 done.

    // Test FILES that touch Postgres directly (constraint.test.ts,
    // notifications.test.ts, ...) share ONE local database (CLAUDE.md: tests
    // never point at a remote one) and each truncates/deletes its own tables
    // in beforeEach. Vitest parallelizes test FILES across workers by default,
    // so two such files running concurrently can TRUNCATE or delete rows the
    // other is mid-transaction on — foreign-key violations and a real
    // Postgres deadlock, found by A-004 the moment a second DB-touching file
    // existed alongside A-003's. Disabling file parallelism serializes them;
    // the whole suite still runs in ~1-2s, so the wall-clock cost is nothing
    // and it removes the race class outright rather than requiring every
    // future DB test file to remember to scope its cleanup narrowly.
    fileParallelism: false,
  },
});
