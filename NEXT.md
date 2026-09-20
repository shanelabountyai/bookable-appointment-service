# Next

## A-128 (S) — the freed-time loop stops the clock at the cancelled start

Backlog row 130. Two fixes in one item: bound `cancelledCandidates` on "not
entirely past" the way `vacatedCandidates` already does (`opened.ts:337`,
`:472`), and measure each run's overlap against `[max(freedStart, now),
freedEnd)` in `freedSpanNow` (`free-runs.ts:206`, `:215`). Do NOT widen the
recency bound or re-add a minutes predicate. Fixtures move `now` through one
afternoon; every existing A-124 fixture passes against the bug. Then A-129.

Re-recommend the model at the start. Opus fits (read-model correctness).

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 337.** Unit total now 1715 (1714 + 1 skipped). Unit ~3.5 min; e2e ~5.5 min; CI ~10 min.
- `npm run test:e2e -- -g X` breaks (npm eats `-g`); pass a spec file instead.
- No prettier config — don't `prettier --write`.
- zsh globs `?`: quote routes. Docs-only pushes skip CI.
- Local drift check (no shadow DB): `npm run db:migrate:test`, then
  `npx dotenv -e .env.test -- sh -c 'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel packages/db/prisma/schema.prisma --exit-code'`.
