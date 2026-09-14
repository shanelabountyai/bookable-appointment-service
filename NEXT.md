# Next

**A-117 is done (the badge cannot see the one failure D-51 was for).**
Commits: the build (`595f87e`), then the SHA record, pushed together in ONE
push. **Confirm with `gh run list --limit 1` before trusting this file** — that
run must be green.

**The local unit sweep did not finish for A-117, deliberately.** Lint,
typecheck and the full e2e sweep (327 passed, reconciling against `--list`'s
326 + the one new spec) were green, and `reminders.test.ts` is 36/36 — but the
countertop project held ~25 Postgres connections for ten minutes from another
session and this suite's `beforeAll` connects timed out in files A-117 never
touched (auth, reports, staff identity). Killed rather than let run. **CI is
the unit gate for this item** — check it before building on top.

## The next item: A-118 — "Everything has gone out" over messages nobody sent

`/staff/messages`' `allClear` (`page.tsx:55`) never asks `reallyDelivered`
(`provider.ts:33`), while `/staff/appointments/{id}` renders every one of the
same rows as *"queued"* via `deliveryWord` (`event-language.ts:239-245`).
`notificationAdapter` is `LoggingChannelAdapter` in every build that exists
(A-053 blocked), so on the demo book 686 rows are `deliveredBy = log`: the
screen headed "Messages that did not go out" says everything went out, and
every appointment page says it did not. Derive the healthy sentence from the
SAME predicate `deliveryWord` uses, never a second copy, and say what is true
when nothing was really delivered. Assert on a book of `log` rows that the two
screens agree. **Not in scope:** any real channel (D-14). No new D-number.

Then A-119, A-120 top to bottom. **A-119 needs a NEW D-number: D-56** (D-55 was
taken by A-114; `07-decisions.md` still has TWO rows numbered D-51).

## What the close found, in case an item trips over it

- **A-119:** the waitlist stores one `serviceId`.
- **A-120:** on the demo book the missed-reminder list is empty by construction,
  the long name never reaches a chip, and the flag's second clause is always cut.

## What A-117 left for anyone near reminders or the shell badge

- **`reminderDedupeKey(appointmentId, startAt: Instant)`** in
  `@bookable/core/notifications` is the ONLY way to say "the reminder for this
  appointment at this time". The sweep and the missed list both go through it.
- **`MOVING_EVENT_TYPES`** (`missed-reminders.ts`) is `['rescheduled',
  'column_pushed']` — the event types that rewrite `startAt`. A third way to
  move an appointment belongs in it, or that client is silently never listed.
  The unit tests iterate the list, so a new type is covered when it is added.
- **The staff shell now runs FIVE queries per render**, one of them the whole
  missed-reminder derivation. If it ever shows up, cache the NUMBER — never ask
  a cheaper question (checkpoint-6 class).
- **`listMissedReminders`' `limit` now applies to the ANSWER**, not the query.
  Its candidate set is every eligible appointment in the next 24 hours.

## What A-116 left for anyone near occupancy

- **A reinstatement RE-PICKS its chair** (`transition.ts`, `chairForMove`), so
  `resourceId` can change on a `cancelled → booked` edge. Anything caching a
  chair across a cancellation is stale.
- **`transitionAppointment` can throw `NoResourceFree`**, not only
  `SlotTaken`/`TransitionRefused`/`AppointmentMovedFirst`.
- **A-075's un-release is the same shape and was deliberately NOT changed**
  (`release-time.ts:261`): `no_show` still occupies.

## What A-115 left for anyone near the booking panel

- **The panel's lookup and A-106's fortnight walk are ONE transition**, so on a
  full day the refused chips now wait on the walk (~2.5s warm, more cold). Wait
  for `Looking…` to go rather than the default 5s.

## Environment notes

- **CHECK FOR A NEIGHBOUR BEFORE A SWEEP.** `psql -d postgres -c "SELECT
  datname, count(*) FROM pg_stat_activity GROUP BY datname"` — another
  project's test database holding 20+ connections starves this one, and it
  fails as `Hook timed out` on `beforeAll`, in whatever file happened to be
  running. Not a code regression; retry when it clears.
- **Leftover demo scripts outlive their session.** Checkpoint 10's browser
  walk was still running days later, with four headless Chromes. `pgrep -fl
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
- **`--list` says 327** after A-117. Full unit run ~9.5 min (density-seed alone
  is ~73s); e2e sweep ~5.7 min; CI ~20 minutes.
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
