# Next

**Build A-103** — row 105 in `docs/prds/06-backlog.md`, the sixth row of
Phase 11. A-102 is ✅ and pushed.

**A-103 is the walk-in nobody is free for, and it is a dead end today.**
`booking-panel.tsx:550` is the whole refusal: *"Nobody is free for that today.
Book a time from the day view instead."* Two answers a real front desk gives
are missing — **"we could squeeze you in"** (RES-04/BOOK-05 override, and A-042
built that door only on the TIME axis, never on the room axis) and **"how about
tomorrow?"** (next-available across FOLLOWING days). Read the finding in
`docs/reviews/19-operator-review-phase-10-close.md` §5 before the row.

## Read first

`docs/START-HERE.md`, `CLAUDE.md`, then the row itself, and §5 of
`19-operator-review-phase-10-close.md`.

## What A-102 just changed underneath it

- **`releasableAt(appointment, at)` is exported from `@bookable/db/appointments`
  and is now the ONLY predicate for "is there time to give back?"** The write
  path (`releaseNoShowTime`) asks it, and so do all three read models. It floors
  `at` to the whole minute and returns the floored instant. It answers from the
  **body** (`endAt`); the MINUTES are `blockedEnd - at` and stay the caller's,
  deliberately — that split is what stopped them drifting apart.
- **`listUnreleasedNoShows(db, {businessId, now})`** — new, in `release-time.ts`.
  Not a fifth `freedBy` kind on `listOpenedSlots`, and the comment says why.
- **`/staff/opened` has TWO lists now**, and the shell's "Opened up N" badge is
  `opened.length + stillBlocked.length` — so `staff/layout.tsx` runs four
  queries per staff render, not three.
- **`GridItem.releasable?: true`** on the day view model; the release button is
  on `provider-day.tsx` and deliberately NOT on the grid chip (A-035's one-button
  budget).
- Nothing in the engine, the constraint, the transition table or `opened.ts`
  moved.

## Two things about the rows after it, so they are not re-derived

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
  Same for `playwright --list`: it must be run under `dotenv` or it lists **0
  tests in 0 files** and looks like a config error.
- **The seed is not uniform, and three of four stylists differ.** Dana/Priya:
  09:00-17:00 Tue-Sat with a break = 2100 min/week. Marcus: split Thursday
  whose second window is CLIPPED by the salon's 18:00 close = 2040. Tess: no
  break = 2400. Any test that hardcodes "2100 for everybody" is wrong for two
  of them.
- **The seeded Colour carries SEGMENTS that must sum to its duration**, so a
  hand-written appointment fixture whose body is not 120 minutes must use the
  **Cut** (45 min, buffers 0/10) instead — A-102's e2e fixture does.
- **A fixture that needs `now` to be INSIDE the appointment cannot pin `?day=`.**
  A-102's e2e anchors to the real clock and touches no roster, no working-hours
  window and no `?day=` — that is what makes it deterministic on any weekday.
- Check `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity
  GROUP BY datname"` and `sysctl -n kern.memorystatus_level` **before** reading
  a stack trace. (Bare `psql` fails on this machine: there is no
  `shanelabounty` database. Use `-d postgres`.)
- **A sibling project's Playwright sweep may be running concurrently** — scope
  the pre-sweep kill to `$PWD` (`pkill -9 -f "$PWD.*playwright"`).
- **The seed alone is 16.8 s**; the 120 s hook budget stands.
- The demo book runs **eight working days forward** and then nothing until the
  fixed fall-back day on 1 November.
- A full e2e sweep is now **292 tests, ~3.3 minutes**. Reconcile
  `passed + skipped + flaky` against 292, not against exit 0.
- **The unit suite is 1583 passed + 1 skipped and takes ~2.6 minutes** — longer
  than the 120 s foreground tool budget, so background it.
- **CI takes ~22 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
