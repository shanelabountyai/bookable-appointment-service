# Next

## A-123: the chip clips the OVERRIDE marker and the flag (Phase 15)

**DECIDE FIRST: D-59 is the next free decision number.** Read the A-123 row in
`docs/prds/06-backlog.md` and Scene 1 of `docs/reviews/23-demo-checkpoint-12.md`.
Options: (a) line 2 by priority, (b) markers on line one, (c) both. Only (b)
and (c) reach a Fringe trim, which is floored at 18 px (one line).

The test is geometric: every load-bearing line's `bottom <= chip bottom`, on the
shortest service, with the premise asserted. Seed one pinned note IN PLACE.

## Environment notes (carried forward, still true)

- **`bookable_cp12` is lying around** (cp11 was dropped). Drop it by hand when convenient.
- **CHECK FOR A NEIGHBOUR BEFORE ANYTHING HEAVY.** Run `sysctl -n vm.loadavg`
  AND `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname"`.
  At checkpoint 12 the load was 269 from leaked vitest runs in other projects,
  and orphaned `node (vitest N)` workers with PPID 1 survive their runs by hours.
- **`pkill -9 -f "$PWD.*playwright"` before every sweep**; `pgrep -cf` errors on macOS, use `pgrep -f … | wc -l`.
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
- **`--list` says 333.** Unit total 1692. Full unit ~3.5 min; e2e ~4.0 min; CI ~20 min.
- **No database has a StaffUser after a seed.** `seedStaffUser` from `@bookable/db/auth` (`owner@shear-genius.test` / `e2e-staff-password`).
- **zsh globs an unquoted `?`:** quote every route on a command line.
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a 12:00–13:00 break. Tess is junior. FOUR chairs.
- **Geometry checks in Chromium:** closed `<details>` content has layout rects; filter with `checkVisibility()`. The room strip links the same appointments as the grid; dedupe by `href`.
