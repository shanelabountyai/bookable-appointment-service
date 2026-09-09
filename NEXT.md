# Next

**A-107 is done, gate green (1597 unit + 307 e2e), CI watched.** Commits
`7826bbe` (work) + `5332f95` (SHA record), pushed together in one push.
`grep "⬜ A-" docs/prds/06-backlog.md` returns **A-108 … A-113**, rows 110–115.

**So the next session is A-108, row 110** — and its row opens with
**"DECIDE FIRST"**, so read it before writing anything; it wants a decision
recorded in `docs/prds/07-decisions.md`, not a build.

## What A-107 changed

- **One expression in `apps/web/app/staff/day/day-grid.tsx`** (`const controls`,
  ~line 136). `ColumnControls` now renders when the column has an appointment
  item, or a stored `runningLateMinutes`, or is simply open — never on roster
  status. No server change, no schema change, no new D-number.
- **One new e2e test** in `apps/web/e2e/off-roster.spec.ts` ("still runs her
  day, and clears a delta set before she left"). e2e is now **307 tests in 32
  files, ~3.5 min** warm.
- **The design gallery's Tess column now draws the control** (the fixture has a
  chip in it). That is the truthful state; no fixture was edited.

## The rule A-107 leaves behind

**AN ABSENT CONTROL LOOKS EXACTLY LIKE A CORRECTLY-ABSENT ONE, so a spec that
only asserts what is GONE from a screen passes against a missing door.**
`off-roster.spec.ts` had four green runs asserting the booking link and the gap
chips were absent from her column — the two things that are absent on purpose —
and could not see that the two CONTROLS had gone with them. Assert what is
THERE on any surface whose item is about keeping something drawn.

Its companion, which is the item: **a read model stricter than the write does
not fail safe.** Neither `running-late.ts` nor `push-column.ts` has ever looked
at `Provider.active`; the screen was the only refusal, and because the sole
control was hidden, a delta stored before the departure could never be cleared
from anywhere in the product. When one boolean gates both "may I offer this?"
and "may I operate this?", they are two questions and the second one is
usually the one nobody wrote a test for.

## Two things A-107 deliberately did not fix (both named in PROGRESS)

- **`/staff/day?provider=<id>` — the single-column phone view — has NEVER had
  `ColumnControls` for anybody.** `ProviderDay` renders chips, status actions,
  release and quick-note and no delta control at all, so a stylist reading her
  own day on her phone cannot say she is running behind from that screen.
- **`ProviderDay` returns "is not working today" on `column.closed` BEFORE it
  looks at `items`**, so an override booked onto a day off is invisible there
  while the grid draws it. Same class as A-107, one boolean over.

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
- **`density-seed.test.ts` has a 120 s per-test budget and it is the first
  thing that breaks under contention.** It timed out once here — on a quiet
  machine the file passes alone in 70 s and the whole unit suite in **168 s**.
  A timeout there with no assertion failure is the machine, not the code:
  check `sysctl -n kern.memorystatus_level` and `pg_stat_activity` and re-run
  before reading a stack trace. **Never overlap a vitest run with a playwright
  sweep** — they share the test database as well as the CPU.
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
  is JUNIOR — Cut, Blow-dry, Fringe trim, Treatment only. **All four work
  Tue–Sat**, so nobody is `closed` on a Tuesday — a negative assertion aimed at
  a closed column on that day matches nothing and passes vacuously.
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
- **CI takes ~19-23 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
