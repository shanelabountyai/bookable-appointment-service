# Next

## A-130 — a cancellation in a running-late column absorbs the delay (DECIDE D-62 FIRST)

Phase 18 is scoped (operator review at the Phase 17 close, `a784945`,
`docs/reviews/27-operator-review-phase-17-close.md`). Start with A-130 (row 132
in `docs/prds/06-backlog.md`): put D-62 to the user as a choice (operator
recommends (a) cascade the projection), record it in `07-decisions.md`, then
build. A-131 (S) follows.

Re-recommend the model at the start (Opus — correctness-critical projection logic plus a decision).

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 339.** Unit total 1717 (1716 + 1 skipped). Unit ~3.5 min; e2e ~5 min; CI ~10 min.
- **A vitest `Killed`/137 with no JetsamEvent file may be the countertop
  session**: its gate runs an UNSCOPED `pkill -9 -f 'node \(vitest'`, which
  kills this repo's unit run (A-129 lost one that way). Wait for its gate to end.
- `npm run test:e2e -- -g X` breaks (npm eats `-g`); pass a spec file instead.
- No prettier config — don't `prettier --write`.
- zsh globs `?`: quote routes. Docs-only pushes skip CI.
- Local drift check (no shadow DB): `npm run db:migrate:test`, then
  `npx dotenv -e .env.test -- sh -c 'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel packages/db/prisma/schema.prisma --exit-code'`.
- **Monitors that `tail -f` a log the command truncates with `>` never fire**
  (A-128). Use `tail -F`, or poll `gh run view --json` for CI.
