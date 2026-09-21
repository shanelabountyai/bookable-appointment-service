# Next

## A-129 (S) — a stylist's closed-day screen counts cancelled clients

Backlog row 131. `provider-day.tsx:37`, `:47` and `hasDayToRunLate`
(`lib/day/run-late.ts:16`, shared with the grid) all test
`item.kind === 'appointment'`, which includes greyed cancelled chips. Ask for a
LIVE appointment, derived from the status module (`ACTIVE_STATUSES`/`isActive`),
never a hand-typed cancelled list, in ONE place both views call. Do NOT hide
cancelled chips. Fixtures: closed date with 1 cancelled + 0 live ("not working
today", no ColumnControls); closed date with 1 cancelled + 1 live (heading names
only the live client). A-126's all-live fixture passes against the bug. This
closes Phase 17 — the operator review follows.

Re-recommend the model at the start. Sonnet is defensible (small, well-specified
UI predicate); Opus if you want the status-module threading checked hard.

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 337.** Unit total now 1717 (1716 + 1 skipped). Unit ~3.5 min; e2e ~5.5 min; CI ~10 min.
- `npm run test:e2e -- -g X` breaks (npm eats `-g`); pass a spec file instead.
- No prettier config — don't `prettier --write`.
- zsh globs `?`: quote routes. Docs-only pushes skip CI.
- Local drift check (no shadow DB): `npm run db:migrate:test`, then
  `npx dotenv -e .env.test -- sh -c 'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel packages/db/prisma/schema.prisma --exit-code'`.
- **Monitors that `tail -f` a log the command truncates with `>` never fire**
  (A-128: unit, e2e and `gh run watch` monitors all expired silent over logs
  ending `EXIT=0`). Use `tail -F`, or poll `gh run view --json` for CI.
