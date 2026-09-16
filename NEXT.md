# Next

**A-122 is committed (`296b986`), CI is the gate** — the local full gate could not
run (alongside's vitest held load ~100); the owner chose to let CI decide.
If CI is red, fix that first.

## Phase 14 is empty — the backlog has no open item

Next move is a demo checkpoint / scoping pass (see `docs/reviews/22-demo-checkpoint-11.md`
for the shape). **D-59 is the next free decision number.**

## Left behind by A-122

- A same-day cancellation now widens its stylist's column all day (D-54 × D-58).
- The new e2e (`appointment-detail.spec.ts`, *opens from her struck-through chip*)
  was proven red on the old `lanes.ts`; its first green run is CI's.

## Environment notes (carried forward, still true)

- **`bookable_cp11` is still lying around.** Drop it by hand when convenient.
- **CHECK FOR A NEIGHBOUR BEFORE A SWEEP** — `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname"` AND `sysctl -n vm.loadavg`: a CPU-bound neighbour (alongside's vitest) holds no Postgres connections and still times out every `packages/db` hook.
- **`pkill -9 -f "$PWD.*playwright"` before every sweep**; `pgrep -cf` errors on macOS, use `pgrep -f … | wc -l`.
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
- **`--list` says 333** (A-122 added one). Unit total 1692. Full unit ~3.5 min; e2e ~4.0 min; CI ~20 min.
- **No database has a StaffUser after a seed.** `seedStaffUser` from `@bookable/db/auth` (`owner@shear-genius.test` / `e2e-staff-password`).
- **zsh globs an unquoted `?`:** quote every route on a command line.
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a 12:00–13:00 break. Tess is junior. FOUR chairs.
