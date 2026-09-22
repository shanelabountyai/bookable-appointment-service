# Next

## A-135 — decide D-64, then build (Phase 20, the last row)

The Phase 19 operator review (`docs/reviews/29-operator-review-phase-19-close.md`,
commit `cd0646d`) found one defect in `projectedDelays`' head rule: a claim spent
by a checkout comes back when the next client sits down; a checked-in pushed
client takes the head (with pushed-off minutes twice) from the client still in
the chair; a colour drops at her booked end. Backlog row 137 has the measured
timelines and the D-64 options — ask D-64 as a clickable question first
(operator recommends (a)), record it in `07-decisions.md`, then build with a
WALK-THE-DAY fixture (check in → past start → start → checkout, each client in
turn; no projection moves unless the chair's true free time moved).

After A-135 the operator says the cascade and the project close: then the
closure deliverables — `docs/DEMO.md` (every command run once; concessions list
in review 29 §6), the *Bookable in Brief* exec-brief, LinkedIn drafts in the Lab
Intelligence Ledger; record every URL in `docs/RELEASE_NOTES.md`.

Model: Opus (correctness-critical derivation).

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
