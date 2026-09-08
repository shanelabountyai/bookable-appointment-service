# Next

**Build A-104** — row 106 in `docs/prds/06-backlog.md`, the seventh row of
Phase 11. A-103 is ✅ and pushed.

**A-104 is a SHAPE, not two screens, and the audit is already done** (recorded
in the row itself): of the four parameter-driven zero-row states,
`clients` and `dashboard/appointments` are RIGHT and `dashboard/overruled` and
`book` are WRONG. The right one to copy is
`dashboard/appointments/page.tsx:64` — `{fromDay && toDay ? 'Nothing matches
this filter.' : 'Pick a week from the dashboard.'}`. The wrong ones say BOTH
sentences at once, so they reassure you about a week you have not chosen.

`/staff/book`'s version is `book/page.tsx:120`, branch
`!walkIn && !anyone && !provider`: it says *"That stylist is not on today."*
when no `provider` param was given at all — on a Tuesday when all four are in —
and the same branch catches a **deactivated** stylist, who is not "not on
today" either. Three cases, one sentence.

**It brings the missing `overruled` e2e spec with it.** `/staff/dashboard/
overruled` is the one staff route with NO e2e spec at all, which is why the
sibling of A-087's fix was never opened. The fixture needs a genuinely
overruled cancellation so the scan is not scanning chrome.

## Read first

`docs/START-HERE.md`, `CLAUDE.md`, then the row itself. A-087 is the precedent
to copy, not to re-derive.

## What A-103 just changed underneath it

- **`walkInAnswer(db, {businessId, serviceIds, day, now, holderKey?, daysAhead?})`**
  in `packages/db/booking/walk-in.ts` returns `WalkInSearch`:
  `{day, options, nextDay, squeeze}`. `walkInOptions` still exists and is
  unchanged in behaviour — both now share `earliestEach`, ONE `computeDaySlots`
  pass per provider per day returning the earliest OFFERED slot and the
  earliest REFUSED candidate together.
- **The safety rule lives in `walkInAnswer`, not in the caller**: a non-empty
  `options` returns `nextDay: null, squeeze: []`. Do not move it into a
  surface.
- **`findWalkInOptions` now returns an OBJECT** (`WalkInAnswer` in
  `staff-actions.ts`), not `WalkInChoice[]`. It only formats; every decision is
  in the db layer.
- **`/staff/book?walkin=1` accepts `?day=`** — it always did (`safeDay`), and
  A-103's e2e is the first thing to use it. The panel still hides the day
  picker for a walk-in; taking a following-day offer moves `day` from the
  SERVER-supplied string.
- **The walk-in refusal text changed**: `Nobody is free for that on <day>`, not
  `...today`. Anything grepping the old string is stale.
- Nothing in the engine, the constraint, the transition table, `book.ts` or the
  override write path moved. There is still exactly one write path.

## The row after that, so it is not re-derived

- **A-105 is A-097's rule one door on** — `sameTimeWithSomebodyElse`
  (`public-actions.ts:252-266`) asks `anyProviderAt` with no `holderKey` while
  the caller resolved the client at `:364`. Strict direction, so it only ever
  offers fewer times than the write would take: 23 instants over the future
  book.

## Environment notes that cost previous sessions a pass

- **Run every command from the REPO ROOT.** The shell's cwd persists between
  calls: a stray `cd apps/web` made `npm run test:e2e` skip the root's
  `dotenv -e .env.test -e .env.local` wrapper, and the sweep died on
  `CRON_SECRET must be set in .env.test` — which reads exactly like a missing
  secret and is not one. Cost A-103 a full sweep.
- Run unit tests with `npm test`, never bare `npx vitest` — without the dotenv
  wrapper every DB test SKIPS and the file merely "fails". Same for
  `playwright --list`: under `dotenv` or it lists **0 tests in 0 files**.
- **The seed is not uniform, and three of four stylists differ.** Dana/Priya:
  09:00-17:00 Tue-Sat with a break = 2100 min/week. Marcus: split Thursday
  clipped by the 18:00 close = 2040. Tess: no break = 2400.
- **The seeded Colour carries SEGMENTS that must sum to its duration**, so a
  hand-written appointment fixture whose body is not 120 minutes must use the
  **Cut** (45 min, buffers 0/10).
- **A hand-written appointment fixture cannot set `blockedStart`/`blockedEnd`**
  — a trigger derives them from the row's own buffer columns, which default to
  0. Copy the buffers off the service.
- **Time off leaves the working WINDOW open**, so every grid candidate stays a
  REFUSED candidate rather than no candidate at all. That is what A-103's e2e
  uses to close a day deterministically on a pinned FUTURE day.
- Check `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity
  GROUP BY datname"` and `sysctl -n kern.memorystatus_level` **before** reading
  a stack trace. (Bare `psql` fails: there is no `shanelabounty` database.)
- **Scope the pre-sweep kill to `$PWD`** (`pkill -9 -f "$PWD.*playwright"`) — a
  sibling project's sweep may be running.
- **The seed alone is 16.8 s**; the 120 s hook budget stands.
- A full e2e sweep is now **295 tests, ~3.5 minutes**. Reconcile
  `passed + skipped + flaky` against 295, not against exit 0.
- **The unit suite is 1590 passed + 1 skipped and takes ~2.6 minutes** — longer
  than the 120 s foreground budget, so background it.
- **CI takes ~19-22 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
