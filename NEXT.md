# Next

## A-126 is done (CI green, run 35459401603). The backlog has no ⬜ rows left.

Phase 16 (A-124–A-126) is closed. Next is the phase-close review: run the
`salon-operator` agent over what Phase 16 built. Its findings become new
backlog rows (and decisions in 07-decisions.md where one is needed) before any
build. Re-recommend the model at the start (Opus: this is review work).

## What A-126 left that the next item should know

- `hasDayToRunLate` (`apps/web/lib/day/run-late.ts`) is the ONE gate for
  `ColumnControls`, used by both the grid and the stylist's list. It is not in
  `view-model.ts`, because `day-grid.tsx` is `'use client'` and the view model
  is `server-only`.
- `ProviderDay` says "not working" only for a closed day with NO appointments.
- There is still no e2e fixture for a cancelled out-of-hours override (from A-124).

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 337.** Unit total 1703 (1702 + 1 skipped). Unit ~3.5 min; e2e ~8.5 min; CI ~20 min.
- `npm run test:e2e -- -g X` breaks (npm eats `-g`); pass a spec file instead.
- No prettier config — don't `prettier --write`.
- zsh globs `?`: quote routes. Docs-only pushes skip CI.
