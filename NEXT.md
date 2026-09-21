# Next

## A-134 — a client booked into a colour's processing gap

Backlog row 136. `projectedDelays` (`packages/db/day/running-late.ts`) chains
ENVELOPES, so a segmented colour is one solid block and a client booked into
its processing gap inherits the colour's whole delay. Fix within D-62: a client
whose start falls inside a processing gap of the appointment before her is late
by `max(0, that block's projected end − her start)`, capped at the delta. Take
the blocks from the busy read `day-view.ts` already loads (one row per worked
block, keyed by appointment id — do NOT join it back with a plain `Map`, see
A-093). Fixtures: segmented head + client in its gap at a delta smaller than
the gap (not on the ring-round) and larger (the remainder); a client after the
whole colour unchanged. A-133 (done) makes the head carry `minutes +
pushedOffMinutes`, so use the head's own `late` for its blocks, not `minutes`.

Model: Opus (correctness-critical projection logic).

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 340.** Unit total 1743 (1742 + 1 skipped). Unit ~3.5 min; e2e ~5 min; CI ~10 min.
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
