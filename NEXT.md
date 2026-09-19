# Next

## Phase 17 is scoped: A-127, A-128, A-129 (all S, no decisions needed)

Source: `docs/reviews/26-operator-review-phase-16-close.md`. Start with
**A-127** (the no-show release trigger throws 23514 on a segmented service; the
fix is a new migration). Re-recommend the model at the start. Opus fits
because this is a DB trigger and occupancy work.

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 337.** Unit total 1703 (1702 + 1 skipped). Unit ~3.5 min; e2e ~8.5 min; CI ~20 min.
- `npm run test:e2e -- -g X` breaks (npm eats `-g`); pass a spec file instead.
- No prettier config — don't `prettier --write`.
- zsh globs `?`: quote routes. Docs-only pushes skip CI.
- The review's probe scripts (`p1.mts`–`p6.mts`) were in a session scratchpad that is gone. The transcripts in the review are the record.
