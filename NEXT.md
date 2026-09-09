# Next

**A-106 is done, gate green, CI watched.** Commits `a445871` (work) +
`bdc6be3` (SHA record), pushed together in one push.
`grep "⬜ A-" docs/prds/06-backlog.md` returns **A-107 … A-113**, rows 109–115.

**So the next session is A-107, row 109, top of the backlog.**

> **The stylist working her notice is the one column the desk cannot tell the
> screen is running late.** `day-grid.tsx:159` hides `ColumnControls` —
> *"Behind by · Set"* and *"Push the column"* — for an off-roster column, under
> a comment reasoning *"she is not in the building"*, **twelve lines below the
> comment that says SHE IS HERE BECAUSE HER CLIENTS ARE**. 123 appointments
> over eight working days on the demo book. **Neither write path checks
> `active`** (no `active` in `running-late.ts` or `push-column.ts`); both accept
> when called directly, and the whole downstream chain works for her. Only the
> door is missing, and `ColumnControls` at `day-grid.tsx:161` is the sole
> inbound reference in the repo — so a delta set BEFORE she is taken off the
> roster is stranded with no control able to clear it. `offRoster` answers *"may
> I seat somebody new here?"* and is being read as *"is she in the building?"*;
> those coincide only on the day her last appointment ends. **Separate them, and
> grep the day surfaces for every OTHER control gated on the same boolean.**
> `off-roster.spec.ts` asserts the marker is present and the booking link gone —
> it cannot see an absent control, so the spec must assert the controls are
> THERE and that a stored delta can be CLEARED.

**Model: Opus is defensible but not required.** The finding is already made and
the fix is a boolean split plus a grep sweep. The one part worth Opus is the
sweep — "every other control gated on the same boolean" is the whole item, and
the two named in the row are the two somebody already found.

## What A-106 just changed underneath it

- **`daysWithAvailability` gained an optional `durationMinutes`** override
  (`slot-query.ts`), passed straight to `computeSlotsIn` — D-18's snapshot, for
  the one caller that has one. Also new there: `DESK_DAY_SEARCH_DAYS = 14` and
  `deskSearchLastDay(fromDay)`, both exported from `@bookable/db/scheduling`.
- **`daysForMove`** in `packages/db/appointments/reschedule.ts`, exported from
  `@bookable/db/appointments`. Thin: it is `daysWithAvailability` supplied with
  the appointment's own inputs.
- **`anyProviderDays` gained `holderKey`** — it had no client field at all.
- **Two server actions**: `staffOpenDays` (`lib/booking/staff-actions.ts`) and
  `staffMoveDays` (`lib/appointments/reschedule-actions.ts`).
- **One new component**, `apps/web/components/open-days.tsx`, used by
  `booking-panel.tsx` (two refusals) and `move-panel.tsx` (one). It renders
  `null` as nothing and `[]` as a sentence — those are different facts.
- **No schema change, no migration, no new D-number.**
- New test file `packages/db/scheduling/desk-day-search.test.ts` (7 tests) and
  one new e2e test in `e2e/staff-reschedule.spec.ts`.

## The rule A-106 leaves behind

**A PARAMETER WITH A DEFAULT IS A DECISION NOBODY EVER MAKES AGAIN — grep for
the values a function is CALLED with, not the values it accepts.** `audience`
had two arms and four call sites and every one passed the same value; the other
arm was written, tested and correct, and had never run. The default was the safe
one, which is why nothing ever failed — it just quietly made the salon's own
screens weaker than the customer's.

Its corollary, which cost the fixture work here: **on a book where everybody
works the same hours "tomorrow" is always the answer, so a search that walks
exactly one day passes every assertion anybody would write.** A range predicate
needs a fixture whose range is longer than one unit (A-100's rule, third time).
And a test that has never been SEEN to fail is not evidence — every assertion in
this item was mutation-checked against the bug it exists for.

## Environment notes that cost previous sessions a pass

- **Run every command from the REPO ROOT.** The shell's cwd persists between
  calls: a stray `cd apps/web` makes `npm run test:e2e` skip the root's
  `dotenv -e .env.test -e .env.local` wrapper, and the sweep dies on
  `CRON_SECRET must be set in .env.test` — which reads exactly like a missing
  secret and is not one.
- **`npm run test:e2e -- <args>` DOES NOT WORK.** npm puts the args after
  `-w apps/web` and it dies with `Workspaces not supported for global
  packages`. To run one spec or one `-g` filter:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test
  --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
  The bare `PORT=3300 npm run test:e2e` (no args) is fine for the full sweep.
- Run unit tests with `npm test`, never bare `npx vitest` — without the dotenv
  wrapper every DB test SKIPS and the file merely "fails". Same for
  `playwright --list`: under `dotenv` or it lists **0 tests in 0 files**.
- **`dropdb` may be refused by the sandbox classifier when chained with `&&`.**
  Run `dropdb --if-exists <db>` on its own line, then `createdb` on its own.
- **`bookable_dev` is the checkpoint-9 book (718 appointments)** and has **NO
  StaffUser** — `db:seed:dev` does not seed one. To walk the staff app against
  it, call `seedStaffUser` from `@bookable/db/auth` from a script **inside the
  repo** (a scratchpad path cannot resolve the `@bookable/*` aliases).
  `npm run db:reset:test` if a spec ever looks wrong.
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` WITHOUT `FREEZE`
  invents violations** — 18 on `/staff/design`, 15 on `/staff/day`, dark only,
  deterministic. Always go through `e2e/axe.ts`.
- **The seed is not uniform, and three of four stylists differ.** Dana/Priya:
  09:00-17:00 Tue-Sat with a 12:00-13:00 break. Marcus: split Thursday
  (09:00-12:00, 15:00-19:00) clipped by the 18:00 close. Tess: no break, and she
  is JUNIOR — Cut, Blow-dry, Fringe trim, Treatment only.
- **The seeded Colour carries SEGMENTS that must sum to its duration**, so a
  hand-written appointment fixture whose body is not 120 minutes must use the
  **Cut** (45 min, buffers 0/10) or the **Blow-dry** (30 min, buffers 0/5).
  Shortest sellable footprint in the catalogue is **15 min** (Fringe trim).
- **A hand-written appointment fixture cannot set `blockedStart`/`blockedEnd`**
  — a trigger derives them from the row's own buffer columns, which default to
  0. Book through `bookAppointment`, or copy the buffers off the service.
- **A two-chair room is the cheapest fixture that can disagree with itself.**
  `resource.updateMany({ ..., skip: 2 }, { active: false })` — the idiom is in
  `holder-agreement.test.ts`, `desk-day-search.test.ts`, `staff-booking.spec.ts`
  and `booking.spec.ts`.
- Check `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity
  GROUP BY datname"` and `sysctl -n kern.memorystatus_level` **before** reading
  a stack trace. (Bare `psql` fails: there is no `shanelabounty` database.)
- **Scope the pre-sweep kill to `$PWD`** (`pkill -9 -f "$PWD.*playwright"`).
- **The unit suite is 1597 passed + 1 skipped and takes ~2.5 minutes** — longer
  than the 120 s foreground budget, so background it. The e2e suite is now
  **306 tests in 32 files, ~3.8 min** on a warm build.
- **CI takes ~19-22 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
