# Next

**Demo checkpoint 11 is done: a scoping pass, no product code.** It produced
`docs/reviews/22-demo-checkpoint-11.md` and **Phase 14: A-121, A-122** in
`docs/prds/06-backlog.md`. Docs-only, so CI is skipped by `paths-ignore`.
`gh run list --limit 1` will still show A-120's green run.

## Build A-121 next, then A-122

- **A-121** (S, no decision): a free gap under 12 minutes is drawn over the
  first line of the next chip (`day-grid.tsx:271` 18 px floor + `:292` gap
  `z-10`). 99 of 245 chips on the demo book. The test is GEOMETRIC: gap label
  text `Range` rect vs the chip's first line, **both taken in page coordinates
  in one frame**. The checkpoint's own script reported 0 when it mixed
  pre- and post-scroll rects. Assert the premise: the fixture has a gap < 12 min.
- **A-122** (S, **DECIDE FIRST: D-58**): a cancelled chip is fully covered by
  its own freed gap's link, so A-112's undo is unreachable from the grid.
  Options (a) chip above gap, (b) lanes, (c) off the grid with `/staff/opened`
  as the door. Ask it as a clickable question, recommendation first.

**D-58 is the next free decision number.**

## Environment notes (carried forward, still true)

- **`bookable_cp11` is still lying around**, and `bookable_cp10` is gone.
  Drop cp11 by hand when convenient.
- **CHECK FOR A NEIGHBOUR BEFORE A SWEEP.** `psql -d postgres -c "SELECT
  datname, count(*) FROM pg_stat_activity GROUP BY datname"`.
- **`pkill -9 -f "$PWD.*playwright"` before every sweep**; `pgrep -cf` errors
  on macOS, use `pgrep -f … | wc -l`.
- **After a checkpoint, `apps/web/.next` was built against `bookable_cp11`.**
  Prisma reads the URL at runtime so it is harmless, but `rm -rf apps/web/.next`
  is the cheap way to be sure before an e2e sweep.
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test
  --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
- **`--list` says 331.** Unit total 1689 (1688 + 1 skipped). Full unit run
  ~3.5 min; e2e sweep ~4.0 min; CI ~20 min.
- **No database has a StaffUser after a seed.** Call `seedStaffUser` from
  `@bookable/db/auth` in a script INSIDE the repo (e2e's credentials:
  `owner@shear-genius.test` / `e2e-staff-password`).
- **Loading `/staff/book?...&day=` does NOT run the panel's client-side
  lookups.** Drive the date box.
- **zsh globs an unquoted `?`:** quote every route on a command line.
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a
  12:00–13:00 break. Tess is junior. FOUR chairs.
