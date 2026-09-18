# Next

## A-124 is done. Next: A-125.

`docs/prds/06-backlog.md` rows 127 and 128, both ⬜:

- **A-125 (S) — DECIDE FIRST (D-61).** Booking someone off the waitlist does
  not close the entry, so the desk rings a client who is already booked. Ask
  the D-61 question as a clickable question with the review's option (a)
  recommended, record it in `docs/prds/07-decisions.md`, then build.
- **A-126 (S).** A stylist's own view says "not working today" over clients
  booked on their day off. No decision needed.

A-125 is an S with a decision; Sonnet is defensible, Opus if the D-61 wording
matters. Re-recommend at the item start either way.

## What A-124 left that the next item should know

- **`packages/db/day/free-runs.ts` is now the ONE derivation of "when is this
  stylist free"** — `freeRunsFrom` (pure), `freeRunsFor` (per provider/day),
  `freedSpanNow` (run + remainder for a freed range). `day-view.ts`'s `gaps`
  goes through it. Anything that needs to predict free time uses this, never
  its own subtraction.
- **`matchFreedSlot` returns `{ span, entries }`, not an array**, and takes
  `{ businessId, providerId, from, to, now }` — instants, no `{day, time}`.
  `span === null` is "that time has gone" and both doors word it.
- **`/staff/opened` now needs the provider's HOURS.** A freed span at an hour
  nobody works is no longer listed. No fixture covers a cancelled out-of-hours
  override (BOOK-05) — if A-126 or anything else touches that path, that is the
  gap.
- **`AnyProviderTime` grew `endAt`** (the chosen provider's body end).

## Environment notes (carried forward, still true)

- **`bookable_cp13` is dropped.** `bookable_cisim`, `bookable_drift_shadow` and
  `bookable_shadow` are the remaining non-core databases; leave them.
- **CHECK FOR A NEIGHBOUR BEFORE ANYTHING HEAVY.** `sysctl -n vm.loadavg` and
  `ps -Ao pid,ppid,etime,command | grep "[n]ode (vitest"` (parent PID 1 =
  orphan). **This session hit it hard:** a neighbour pushed loadavg to 215 and
  one unit file took 43 minutes that takes 3 seconds idle, and a later `npm
  test` was SIGKILLed at startup with no jetsam log for the minute. Check the
  load before believing a slow or killed run is your code.
- **`pkill -9 -f "$PWD.*playwright"` before every sweep.**
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
- **`--list` says 335** (A-124 added one to `opened.spec.ts`). Unit total 1699 (1698 + 1 skipped).
  Full unit ~3.5 min idle; e2e ~4.7 min; CI ~20 min.
- **No prettier config in the repo.** `npx prettier --write` uses defaults and
  reformats whole files. Don't.
- **No database has a StaffUser after a seed.** `seedStaffUser` from
  `@bookable/db/auth`.
- **zsh globs an unquoted `?`:** quote every route on a command line.
- **Docs-only pushes are skipped by CI** (`paths-ignore: docs/**`, `**/*.md`),
  so a review/scoping push has no run to watch. A code push does.
