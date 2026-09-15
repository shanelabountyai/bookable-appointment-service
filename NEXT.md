# Next

**A-119 is done (the waitlist stores the whole visit — D-56).**
Commits: the build (`b952045`), then the SHA record, pushed together in ONE
push. **Confirm with `gh run list --limit 1` before trusting this file** — that
run must be green.

Full local gate passed: lint, typecheck, unit (1684 passed + 1 skipped = 1685,
reconciling against A-118's 1671 + 14 new) and e2e (328 passed, matching
`--list`).

## The next item: A-120

Backlog row 122. Read the row before designing. **The close already found
three things that will bite it on the demo book:** the missed-reminder list is
empty by construction there, the long name never reaches a chip, and the flag's
second clause is always cut — so a green run on the seeded book proves nothing
about any of them. Build the fixture that makes each one reachable.

Then A-121 top to bottom. **D-57 is the next free decision number** (D-56 was
taken by A-119).

## What A-119 left for anyone near the waitlist, the matcher, or a freed span

- **`WaitlistEntry.serviceIds` is ORDERED and that order is the FOOTPRINT.**
  D-23 takes the first line's `bufferBefore` and the last line's
  `bufferAfter`, so colour-then-cut is 145 minutes where cut-then-colour is
  160 — same two services, same chair. **Anything that sorts or de-duplicates
  that array re-prices every combination booking in the salon.** The test that
  says so is `ORDER IS THE FOOTPRINT` in `waitlist.test.ts`; nothing else in
  the suite would notice.
- **`matchFreedSlot` no longer takes a `serviceId` at all.** A freed span
  matches anyone whose whole visit fits it, whatever freed it. If you find
  yourself re-adding a service filter, that is D-56 being re-opened.
- **An unqualified line returns `null`, never a skipped line.** Skipping
  composes a SHORTER visit that fits MORE spans. The guard is
  `A LINE SHE CANNOT DO IS A REFUSAL, NOT A ZERO` and it needs a junior in the
  fixture — a salon where everyone does everything cannot fail it.
- **`primaryServiceId` no longer exists** on `OpenedSlot` or the appointment
  detail model, and the freed-slot URL carries no service. `serviceIds` on
  `OpenedSlot` is a LABEL (what the span was), never a filter.
- **`composeVisit` is the one copy of D-23's composition** and `fitsFreedSpan`
  the one copy of A-109's comparison. The matcher calls both rather than
  re-adding buffers; keep it that way.
- **A waitlist entry has no FK to `Service`.** Nothing deletes a service today;
  if something starts to, an entry naming it becomes unqualifiable (which the
  matcher already treats as "does not fit") and the queue renders
  *"A service that has gone"*.
- **`dayPartWords` (`@bookable/core/waitlist`) is the one place day-part tags
  become English.** Do not join the cell raw anywhere new.

## Doc hygiene this item touched

- **`07-decisions.md` now carries a numbering note**: D-51 was assigned twice
  (A-101's utilization week, A-108's reminder watermark). Both are cited ~50
  times across code and PROGRESS, so **neither was renumbered** — read a
  `D-51` citation from its item. Do not "fix" this by renumbering.

## What A-118 left for anyone near the messages screen or delivery wording

- **`countNotReallySent(db, businessId)`** (`stuck.ts`) is the count of rows
  marked `sent` that no real driver handled. It groups by `deliveredBy` in SQL
  and folds with `reallyDelivered` in TypeScript — **never spell that predicate
  as a `where` clause**, that is the second copy the item exists to prevent.
- **`allClear` on `/staff/messages` now has three terms**, and the "Nothing has
  actually been sent" section renders independently of it.
- **The page's intro paragraph enumerates its sections** — add a fifth section
  and that sentence is a reader that needs updating too.

## What A-117 left for anyone near reminders or the shell badge

- **`reminderDedupeKey(appointmentId, startAt: Instant)`** in
  `@bookable/core/notifications` is the ONLY way to say "the reminder for this
  appointment at this time".
- **`MOVING_EVENT_TYPES`** (`missed-reminders.ts`) is `['rescheduled',
  'column_pushed']`. A third way to move an appointment belongs in it, or that
  client is silently never listed.
- **The staff shell runs FIVE queries per render.** If it ever shows up, cache
  the NUMBER — never ask a cheaper question (checkpoint-6 class).

## What A-116 left for anyone near occupancy

- **A reinstatement RE-PICKS its chair** (`transition.ts`, `chairForMove`), so
  `resourceId` can change on a `cancelled → booked` edge.
- **`transitionAppointment` can throw `NoResourceFree`**, not only
  `SlotTaken`/`TransitionRefused`/`AppointmentMovedFirst`.

## Environment notes

- **CHECK FOR A NEIGHBOUR BEFORE A SWEEP.** `psql -d postgres -c "SELECT
  datname, count(*) FROM pg_stat_activity GROUP BY datname"` — another
  project's test database holding 20+ connections starves this one, and it
  fails as `Hook timed out` on `beforeAll`. Not a code regression.
- **Leftover Playwright `test-server` processes outlive their session** (the
  VS Code extension's). `pgrep -fl "chrome-headless-shell|test-server"` before
  blaming the suite; they did not interfere with this item's sweep.
- **`dropdb bookable_dev` is refused by the auto-mode classifier.** For a
  checkpoint, create a NEW scratch database instead (recipe in the A-118
  handoff's history). **`bookable_cp10` was left behind by checkpoint 10**;
  drop it by hand when convenient.
- **Loading `/staff/book?...&day=` does NOT run the panel's client-side
  lookups.** Drive the date box (`getByLabel('Which day?').fill(day)`).
- **zsh globs an unquoted `?`:** quote every route on a command line.
- **JSX STRIPS THE NEWLINE BETWEEN A `<span>` AND ITS SIBLING TEXT**, so a
  numbered toggle rendered as `<span>{n}.</span>` then the name has the
  accessible name `1.Colour`, not `1. Colour` — a margin class does not put a
  space in the accessible name. Cost A-119 one spec run; the booking panel's
  own spec has always matched `/^Cut45 min/` for exactly this reason. Put a
  real space in the text.
- **A MONITOR LOOP THAT CHECKS `EXIT=` BEFORE `✘` MISSES A FAST FAILURE.** Run
  the `✘` check once more after the loop.
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test
  --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
  `npm test -- <path> -t "<name>"` works; bare `npx vitest` skips every DB test.
- **Never overlap a vitest run with a playwright sweep**, and never
  `npm run typecheck` during an e2e build.
- **`--list` says 328** (unchanged by A-119). Unit total 1685 (1684 + 1
  skipped). Full unit run ~3.5 min; e2e sweep ~5.4 min; CI ~20 min.
- **No database has a StaffUser after a seed.** Call `seedStaffUser` from
  `@bookable/db/auth` in a script INSIDE the repo (e2e's credentials:
  `owner@shear-genius.test` / `e2e-staff-password`).
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a
  12:00–13:00 break. Tess is junior (Cut, Blow-dry, Fringe trim, Treatment
  only) — which A-119 now relies on for its qualification test. There are FOUR
  chairs, and `Chair 1` is what the picker hands out first.
