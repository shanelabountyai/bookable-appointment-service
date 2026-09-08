# Next

**Build A-100** — row 102 in `docs/prds/06-backlog.md`, the third row of
Phase 11. A-099 is ✅ and pushed (`ccd79dd`, SHA record `7750a07`).

**A-100: an absence longer than one day makes `/staff/conflicts?day=` lie on
every day of the year.** Dana is off all week with flu; the desk writes one
`TimeOff` row and follows the link A-041 hands it. `conflictsForDay`
(`impact.ts:361`) loads **every `TimeOff` and `AdHocBlock` the provider has ever
had, with no date predicate of any kind** — under a comment claiming the list
"is scoped to one already-known day". Five clients on five different days show
identically on `?day=2026-09-09`, `?day=2026-09-11`, `?day=2026-09-15` **and
`?day=2027-03-15`** — still all five a year later, every one `completed`, and
every row labelled with a bare `"09:00"` that does not say which day it is. So
the second person to work the list on Wednesday re-rings the five already sorted
on Tuesday, which is exactly what A-019's `conflictAckAt` was built to prevent,
arriving by a route the acknowledgment cannot reach.

**Two halves, and the second is the one that gets forgotten:** the absence query
needs the day's bounds, AND a row that can span days must print its DATE, not
just its time.

## Read first

`docs/START-HERE.md`, `CLAUDE.md`, then the row itself and
`docs/reviews/19-demo-checkpoint-8.md`.

## What A-099 just changed underneath it

Nothing in `impact.ts`. But three things moved on the day surfaces:

- **`apps/web/lib/day/lanes.ts` is new** and is the only place that decides what
  "at once" means — half-open, per overlapping cluster, appointments only.
  `GridItem` gained `lane`/`lanes`/`concurrent`; `RoomTrack.blocks` gained
  `lane`/`lanes`. Four readers go through it: `day-grid.tsx`, `day-sheet.tsx`,
  `provider-day.tsx`, `room-strip.tsx`.
- **The unit suite now covers `apps/web/lib`.** `vitest.config.ts`'s `include`
  is `['packages/**/*.test.ts', 'apps/web/lib/**/*.test.ts']`. A unit test may
  now live beside app code, but only under `lib` and only if it is pure — no
  `@/` alias resolution is configured, so import relatively.
- **A locator trap, if you write a spec on the printed sheet.** The sheet now
  prints "at the same time as <the other client>" on BOTH rows of an overlapping
  pair, so `page.locator('tbody tr').filter({ hasText: '<a name>' })` can match
  two rows. Locate a row by its own TIME cell and assert the name inside it.

## Two things about the rows after it, so they are not re-derived

- **A-101 needs a DECISION before any code** — a new D-number. RPT-02's
  utilization formula is **frozen and out of scope**; the open question is only
  what the tile renders for a week that has not happened yet. Do not "fix" the
  formula.
- **A-104 is a shape, not two screens.** The audit is already done: of the four
  parameter-driven zero-row states, `clients` and `dashboard/appointments` are
  right, `dashboard/overruled` and `book` are wrong. It brings the missing
  `overruled` e2e spec with it.

## Environment notes that cost previous sessions a pass

- Check `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity
  GROUP BY datname"` and `uptime` **before** reading a stack trace. (Bare `psql`
  fails on this machine: there is no `shanelabounty` database. Use `-d postgres`.)
- **The seed alone is 16.8 s**; the 120 s hook budget stands. Not an open
  question.
- The demo book runs **eight working days forward** and then nothing until the
  fixed fall-back day on 1 November.
- A full e2e sweep is **287 tests, ~3.2 minutes**. Reconcile
  `passed + skipped + flaky` against 287, not against exit 0.
