# Next

## The backlog is empty — Phase 19 close, then project closure

A-134 (`947e459`) was the last ⬜ row. Two things are owed, in order:

1. **Phase 19 close.** Every earlier phase closed with a demo checkpoint
   (`docs/reviews/2x-demo-checkpoint-N.md`, a production build over a fresh
   `bookable_cpN`) or an operator review (`salon-operator` agent). Walk it; if
   it scopes new rows, the backlog is not done.
2. **Closure deliverables** (global CLAUDE.md, *Definition of done*), none of
   which exist yet: `docs/DEMO.md` (every command run once), the
   *Bookable in Brief* exec-brief artifact, and the LinkedIn drafts in the Lab
   Intelligence Ledger. Record every artifact URL in `docs/RELEASE_NOTES.md`.

Model: Opus for the checkpoint/review; Sonnet is fine for the DEMO.md write-up.

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 340.** Unit total 1746 (1745 + 1 skipped). Unit ~3.5 min; e2e ~5 min; CI ~25 min (A-134: 24–43 min lately).
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
