# Next

## A-132 — decide D-63 first, then build

The operator review at the Phase 18 close (`717102e`,
`docs/reviews/28-operator-review-phase-18-close.md`) scoped Phase 19: A-132 (M),
A-133 (S), A-134 (S). A-132's row says DECIDE FIRST: take D-63(1) and D-63(2)
together (the operator recommends (a) for both), record them in
`docs/prds/07-decisions.md`, then build A-132.

Model: Opus (correctness-critical projection logic).

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 340.** Unit total 1728 (1727 + 1 skipped). Unit ~3.5 min; e2e ~5 min; CI ~10 min.
- **A vitest `Killed`/137 with no JetsamEvent file may be the countertop
  session**: its gate runs an UNSCOPED `pkill -9 -f 'node \(vitest'`, which
  kills this repo's unit run (A-129 lost one that way). Wait for its gate to end.
- `npm run test:e2e -- -g X` breaks (npm eats `-g`); pass a spec file instead.
- No prettier config — don't `prettier --write`.
- zsh globs `?`: quote routes. Docs-only pushes skip CI.
- Local drift check (no shadow DB): `npm run db:migrate:test`, then
  `npx dotenv -e .env.test -- sh -c 'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel packages/db/prisma/schema.prisma --exit-code'`.
- **Monitors that `tail -f` a log the command truncates with `>` never fire**
  (A-128). Use `tail -F`, or poll `gh run view --json` for CI. `tail -F`
  replays an OLD log's last lines — use a fresh filename per run, or the
  first event is a stale `EXIT=`.
