# Next

## A-131 — the segmented release sentence counts time already sold (S)

Row 133 in `docs/prds/06-backlog.md`. A-130 shipped (`df36063`, D-62 recorded), CI green.
Derive the sentence from `freeRunsFor` clipped to `[releasedAt, fromBlockedEnd)`,
name each piece, say which one is on What's opened up; panel says the same
before the press. Fixtures per the row. Closes Phase 18 → operator review next.

Model: Sonnet is enough (S, one derivation already exists); Opus if in doubt.

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 340.** Unit total 1722 (1721 + 1 skipped). Unit ~3.5 min; e2e ~5 min; CI ~10 min.
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
