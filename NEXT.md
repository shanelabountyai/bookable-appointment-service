# Next

## A-133 — pushed-off minutes (D-63(2), already decided)

D-63 is recorded in `docs/prds/07-decisions.md` — both parts, (a) and (a). Do
not re-ask. A-132 built (1): `projectedDelays` (`packages/db/day/running-late.ts`)
now has a `head` (the client in the chair) carrying `minutes`. A-133 adds a
`pushedOffMinutes` column to `ProviderRunningLate`, incremented in the push's
transaction (`push-column.ts`, the `setRunningLate(tx, {… now: null})` call —
the delta after = before − pushed), gone with the row on clear. Then the head's
`late` becomes `minutes + pushedOffMinutes` (only the head; pushed members stay
capped at the reduced `minutes`). Fixtures in the backlog row: +20 of 40 with
the chair in progress → Bea 15, Cat 10; the default +15; a full push projects
nothing. Check: does a desk re-claim reset `pushedOffMinutes`? D-63 says "reset
when the delta is cleared" only — leave it on re-set, and say so in a comment.

Model: Opus (correctness-critical projection logic).

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 340.** Unit total 1738 (1737 + 1 skipped). Unit ~3.5 min; e2e ~5 min; CI ~10 min.
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
