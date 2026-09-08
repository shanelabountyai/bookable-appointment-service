# Next

**Build A-102** — row 104 in `docs/prds/06-backlog.md`, the fifth row of
Phase 11. A-101 is ✅ and pushed.

**A-102 needs no decision.** D-44 already settled the mechanism (`releasedAt`
cuts the blocked range) and A-069 built it. The finding is that its BUTTON
lives on one screen while `no_show` is markable on three, so the desk that taps
no-show from the day grid at 10:15 has freed two hours nobody will ever be
offered — and `/staff/opened`, the one screen whose whole subject is
perishable supply, shows **0**.

## Read first

`docs/START-HERE.md`, `CLAUDE.md`, then the row itself, D-44/D-45 in
`07-decisions.md`, and `docs/reviews/19-demo-checkpoint-8.md`.

## What A-101 just changed underneath it

- **`dashboardSummary` now takes `now: Date`** and returns two fractions per
  provider (`utilization` frozen, `booked` forward) plus `weekIsAhead`. Six
  test call sites were threaded; the frozen constant (`1290/2100`) is
  untouched.
- **`e2e/dashboard.spec.ts`'s `DAY` is now at least SEVEN days out**, so its
  week is strictly ahead of today whatever weekday the suite runs on. It used
  to be "at least a day out", which lands inside the current week every Monday.
- Nothing in `opened.ts`, the release path, or the transition layer moved.

## Two things about the rows after it, so they are not re-derived

- **A-103** — the walk-in nobody is free for is a dead end. Needs
  next-available across FOLLOWING days plus the RES-04/BOOK-05 override.
- **A-104 is a shape, not two screens.** The audit is already done: of the four
  parameter-driven zero-row states, `clients` and `dashboard/appointments` are
  right, `dashboard/overruled` and `book` are wrong. It brings the missing
  `overruled` e2e spec with it.
- **A-105 is A-097's rule one door on** — `sameTimeWithSomebodyElse`
  (`public-actions.ts:252-266`) asks `anyProviderAt` with no `holderKey` while
  the caller resolved the client at `:364`. Strict direction, so it only ever
  offers fewer times than the write would take: 23 instants over the future
  book.

## Environment notes that cost previous sessions a pass

- Run unit tests with `npm test`, never bare `npx vitest` — the env comes from
  `dotenv -e .env.test -e .env.local`, and without it every DB test SKIPS and
  the file merely "fails", which reads nothing like a missing `DATABASE_URL`.
- **The seed is not uniform, and three of four stylists differ.** Dana/Priya:
  09:00-17:00 Tue-Sat with a break = 2100 min/week. Marcus: split Thursday
  whose second window is CLIPPED by the salon's 18:00 close = 2040. Tess: no
  break = 2400. Any test that hardcodes "2100 for everybody" is wrong for two
  of them.
- Check `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity
  GROUP BY datname"` and `sysctl -n kern.memorystatus_level` **before** reading
  a stack trace. (Bare `psql` fails on this machine: there is no
  `shanelabounty` database. Use `-d postgres`.)
- **A sibling project's Playwright sweep may be running concurrently** — scope
  the pre-sweep kill to `$PWD` (`pkill -9 -f "$PWD.*playwright"`).
- **The seed alone is 16.8 s**; the 120 s hook budget stands.
- The demo book runs **eight working days forward** and then nothing until the
  fixed fall-back day on 1 November.
- A full e2e sweep is now **289 tests, ~3.4 minutes**. Reconcile
  `passed + skipped + flaky` against 289, not against exit 0.
- **CI takes ~22 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
