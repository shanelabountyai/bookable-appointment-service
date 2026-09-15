# Next

**A-118 is done ("Everything has gone out" over messages nobody sent).**
Commits: the build (`bea41e5`), then the SHA record, pushed together in ONE
push. **Confirm with `gh run list --limit 1` before trusting this file** — that
run must be green.

Full local gate passed for this one: lint, typecheck, unit (1670 passed + 1
skipped = 1671) and e2e (328 passed) — which also settled A-117's open
reconciliation, since 1671 − 3 new tests = the 1668 its contaminated run
reported.

## The next item: A-119 — the waitlist stores ONE serviceId

Backlog row 121. **It needs a NEW D-number: D-56** (D-55 was taken by A-114 —
and note `07-decisions.md` still has TWO rows numbered D-51, which somebody
should renumber when they are next in that file).

Read the backlog row and the operator review before designing: a client who
wants a cut AND colour cannot be waitlisted for the visit she actually wants,
and every surface that matches a freed slot against the waitlist measures one
service's duration against a footprint the real visit would not fit in.

Then A-120 top to bottom.

## What the close found, in case an item trips over it

- **A-120:** on the demo book the missed-reminder list is empty by
  construction, the long name never reaches a chip, and the flag's second
  clause is always cut.

## What A-118 left for anyone near the messages screen or delivery wording

- **`countNotReallySent(db, businessId)`** (`stuck.ts`) is the count of rows
  marked `sent` that no real driver handled. It groups by `deliveredBy` in SQL
  and folds with `reallyDelivered` in TypeScript — **never spell that predicate
  as a `where` clause**, that is the second copy the item exists to prevent.
- **`allClear` on `/staff/messages` now has three terms**, and the "Nothing has
  actually been sent" section renders independently of it.
- **When a real channel is finally wired in (D-14), that section empties itself
  per row**, and the old healthy sentence comes back on its own.
- **The page's intro paragraph enumerates its sections** — add a fifth section
  and that sentence is a reader that needs updating too.

## What A-117 left for anyone near reminders or the shell badge

- **`reminderDedupeKey(appointmentId, startAt: Instant)`** in
  `@bookable/core/notifications` is the ONLY way to say "the reminder for this
  appointment at this time". The sweep, the missed list and now the e2e
  fixtures all go through it.
- **`MOVING_EVENT_TYPES`** (`missed-reminders.ts`) is `['rescheduled',
  'column_pushed']` — the event types that rewrite `startAt`. A third way to
  move an appointment belongs in it, or that client is silently never listed.
- **The staff shell runs FIVE queries per render**, one of them the whole
  missed-reminder derivation. If it ever shows up, cache the NUMBER — never ask
  a cheaper question (checkpoint-6 class).
- **`listMissedReminders`' `limit` applies to the ANSWER**, not the query.

## What A-116 left for anyone near occupancy

- **A reinstatement RE-PICKS its chair** (`transition.ts`, `chairForMove`), so
  `resourceId` can change on a `cancelled → booked` edge.
- **`transitionAppointment` can throw `NoResourceFree`**, not only
  `SlotTaken`/`TransitionRefused`/`AppointmentMovedFirst`.
- **A-075's un-release is the same shape and was deliberately NOT changed**
  (`release-time.ts:261`): `no_show` still occupies.

## What A-115 left for anyone near the booking panel

- **The panel's lookup and A-106's fortnight walk are ONE transition**, so on a
  full day the refused chips wait on the walk (~2.5s warm, more cold). Wait for
  `Looking…` to go rather than the default 5s.

## Environment notes

- **CHECK FOR A NEIGHBOUR BEFORE A SWEEP.** `psql -d postgres -c "SELECT
  datname, count(*) FROM pg_stat_activity GROUP BY datname"` — another
  project's test database holding 20+ connections starves this one, and it
  fails as `Hook timed out` on `beforeAll`, in whatever file happened to be
  running. Not a code regression; retry when it clears. (Cost A-117 its local
  unit leg.)
- **Leftover demo scripts outlive their session.** Checkpoint 10's browser walk
  was still running days later, with four headless Chromes. `pgrep -fl
  "chrome-headless-shell|test-server"` before blaming the suite.
- **`dropdb bookable_dev` is refused by the auto-mode classifier.** For a
  checkpoint, create a NEW scratch database instead: write
  `grep ^DATABASE_URL .env.local | sed 's#/bookable_dev?#/bookable_cp10?#'` into
  a scratchpad env file, then `createdb`, `migrate:deploy -w packages/db` and
  `tsx packages/db/seed.ts` under `npx dotenv -e <that file> -e .env.local --`
  (first file wins). **`bookable_cp10` was left behind by checkpoint 10**; drop
  it by hand when convenient.
- **The server does not need a special build for a scratch DB:** `npm run
  build`, then `npm run start -w apps/web` under that dotenv.
- **Loading `/staff/book?...&day=` does NOT run the panel's client-side
  lookups.** Drive the date box (`getByLabel('Which day?').fill(day)`).
- **zsh globs an unquoted `?`:** quote every route on a command line.
- **A MONITOR LOOP THAT CHECKS `EXIT=` BEFORE `✘` MISSES A FAST FAILURE.** Run
  the `✘` check once more after the loop.
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test
  --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
  `npm test -- <path> -t "<name>"` works; bare `npx vitest` skips every DB test.
- **Never overlap a vitest run with a playwright sweep**, and never
  `npm run typecheck` during an e2e build.
- **`--list` says 328** after A-118. Unit total 1671 (1670 + 1 skipped). Full
  unit run ~9 min (density-seed alone is ~73s); e2e sweep ~7.6 min; CI ~20 min.
- **No database has a StaffUser after a seed.** Call `seedStaffUser` from
  `@bookable/db/auth` in a script INSIDE the repo (e2e's credentials:
  `owner@shear-genius.test` / `e2e-staff-password`).
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` without `FREEZE`
  invents violations.** Inside the suite, always go through `e2e/axe.ts`.
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a
  12:00–13:00 break. Tess is junior (Cut, Blow-dry, Fringe trim, Treatment
  only). There are FOUR chairs, and `Chair 1` is what the picker hands out
  first. All 13 seeded phones are stored `+1…`, which is now the ONLY stored
  form: D-55's `client_identity` trigger canonicalises every write, fixtures
  included. Eight clients hold every appointment except the five lapsed visits.
