# Next

**Build A-105** — row 107 in `docs/prds/06-backlog.md`, the eighth row of
Phase 11. A-104 is ✅, pushed, and CI is green (`646a086`, run 34286941186).

**A-105 is A-083's shape on the caller A-083 did not reach.**
`confirmAppointment` resolves the client at `public-actions.ts:364` and then,
in its own `catch` at `:429`, calls `sameTimeWithSomebodyElse(...)`, which asks
`anyProviderAt` with **no `holderKey`** (`:252-266`). Strict direction, so it
only ever offers FEWER times than the write would take — the row records the
measurement: **472 comparisons, 23 instants the named question offers that the
anonymous one refuses, 0 the other way.** Read the row itself for the rest; it
carries the numbers.

**The fixture rule applies here as loudly as anywhere.** A room where the
answers can differ is a room where she is ALREADY IN A CHAIR at that instant.
On a book where nobody is seated the two questions agree, so a spec written the
obvious way passes against the bug (CLAUDE.md, the A-082/A-097 entries).

## Read first

`docs/START-HERE.md`, `CLAUDE.md`, then the row. A-082 and A-083 are the
precedent — the `holderKey` thread — not to be re-derived.

## What A-104 just changed underneath it

- **All four parameter-driven zero-row screens are one construction now**, and
  it tests the MISSING PARAMETER FIRST:
  `{!fromDay || !toDay ? <EmptyState>pick one</EmptyState> : rows.length === 0
  ? <EmptyState>none matched</EmptyState> : <ul>…}`. Copy that precedence, not
  A-087's nested `{cond ? A : B}` inside `rows.length === 0`. All four use
  `EmptyState` (`@/components/ui/empty-state`).
- **`/staff/book` no longer filters the provider lookup by `active`.** It
  selects `{id, displayName, active}` and derives
  `provider = providerRow?.active ? … : null` afterwards, so the page can tell
  "off the roster" from "no such stylist". `provider` still means exactly
  "bookable" everywhere below that line — nothing downstream changed.
- **Three strings on `/staff/book` are gone.** *"That stylist is not on
  today."* no longer exists anywhere; it is now "Pick a stylist from the day
  view." / "<Name> is off the roster — no new bookings with her. Her clients
  are still booked." / "No stylist here matches that link." Anything grepping
  the old sentence is stale.
- **`e2e/overruled.spec.ts` is new** (5 tests) and `staff-booking.spec.ts` has
  3 more at the bottom. The suite is now **303 tests in 32 files, ~3.5 min**.
- Nothing in the engine, the constraint, the transition table, the write paths
  or any query moved. A-104 was presentation only.

## Environment notes that cost previous sessions a pass

- **Run every command from the REPO ROOT.** The shell's cwd persists between
  calls: a stray `cd apps/web` makes `npm run test:e2e` skip the root's
  `dotenv -e .env.test -e .env.local` wrapper, and the sweep dies on
  `CRON_SECRET must be set in .env.test` — which reads exactly like a missing
  secret and is not one.
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
- Check `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity
  GROUP BY datname"` and `sysctl -n kern.memorystatus_level` **before** reading
  a stack trace. (Bare `psql` fails: there is no `shanelabounty` database.)
- **Scope the pre-sweep kill to `$PWD`** (`pkill -9 -f "$PWD.*playwright"`) — a
  sibling project's sweep may be running.
- **The seed alone is 16.8 s**; the 120 s hook budget stands.
- **The unit suite is 1590 passed + 1 skipped and takes ~2.6 minutes** — longer
  than the 120 s foreground budget, so background it.
- **CI takes ~19-22 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
