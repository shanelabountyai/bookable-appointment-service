# Next

## The backlog is empty, and checkpoint 13 scoped nothing

Phase 15 is closed (`docs/reviews/24-demo-checkpoint-13.md`). There is no
open item. Pick one:

- **An operator review at the Phase 15 close** (the `salon-operator` agent, as
  in `docs/reviews/21-operator-review-phase-12-close.md`). Phases 13–15 were
  scoped entirely by demo checkpoints, which find rendering defects, not
  product gaps.
- Or the owner names the next item.

## Environment notes (carried forward, still true)

- **`bookable_cp13` is lying around.** Drop it by hand when convenient.
- **CHECK FOR A NEIGHBOUR BEFORE ANYTHING HEAVY.** Four checkpoints running.
  `sysctl -n vm.loadavg` and `ps -Ao pid,ppid,etime,command | grep "[n]ode (vitest"`
  (parent PID 1 = orphan). A seed that fails with `P2028` is this, not code.
- **`pkill -9 -f "$PWD.*playwright"` before every sweep.**
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
- **`--list` says 334.** Unit total 1693 (1692 + 1 skipped). Full unit ~3.5 min; e2e ~4.7 min; CI ~20 min.
- **No prettier config in the repo.** `npx prettier --write` uses defaults and reformats whole files. Don't.
- **No database has a StaffUser after a seed.** `seedStaffUser` from `@bookable/db/auth`.
- **zsh globs an unquoted `?`:** quote every route on a command line.
