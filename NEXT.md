# Next

**A-108 is done, gate green (1612 unit + 310 e2e), CI watched and green**
(run `34395076441`, 22m43s, both TZ arms). Commits `7a2d361` (work) +
`5606659` (SHA record), pushed together in one push.
`grep "⬜ A-" docs/prds/06-backlog.md` returns **A-109 … A-113**, rows 111–115.

**So the next session is A-109, row 111** — an **S**, no decision needed, and
the shortest of the five left.

## A-109 in one line

`/staff/opened` computes a released no-show's `freedMinutes` LIVE from `now`
(`opened.ts:376-377`), guarded only against zero (`opened.ts:226`) — so a span
decays through the afternoon and **"Soonest to expire first" sorts the dead row
to the TOP.** The shortest footprint this salon sells is **15 minutes**
(Fringe trim: `min(duration + before + after)` over active services), and
`matchFreedSlot` **already applies that bound correctly one function over** —
so one half of the loop knows and the other half is still selling. One
predicate in the listing, the same one `matchFreedSlot` uses.

**The fixture is the whole trick:** a span decayed **below 15 minutes but still
positive**. At zero it already drops out, so a test written against a fresh
release passes against the bug.

## What A-108 changed (in case A-109 trips over it)

- **`countFailedNotifications` no longer exists** — it is
  `countUnsentNotifications(db, businessId, now)`. The nav count key is
  `unsentMessages`, not `failedMessages`.
- **`listStuckNotifications(db, businessId, { now, limit? })`** — signature
  changed, `now` is required, and rows now carry `kind`
  (`given-up | never-tried | retrying`). **Do not re-derive the bucket from
  `status`/`attempts` on a screen.**
- **`Business.remindersLastRunAt`** is new (migration
  `20260909120000_reminder_sweep_watermark`). Run `npm run db:migrate:all`
  in a fresh clone or the whole unit suite fails on a missing column.
- **`sendDueReminders` loops businesses now.** Same signature, same result
  shape; it just sweeps and stamps each business separately.
- **`seedDensity` DISPATCHES the outbox** and returns `dispatched`. A fresh
  `db:reset:test` now prints `713 messages sent` and leaves **zero** pending
  rows. If a spec ever wanted a `pending` row on a seeded book, it has to
  write one.
- **`REMINDER_TEMPLATE` lives in `@bookable/core/notifications`** — not a
  literal, not a private copy in `stale.ts`.

## The rule A-108 leaves behind

**AN AGE BOUND MUST MEASURE FROM THE MOMENT THE STATE BEGAN, NOT FROM
`createdAt`** — the column that looks obviously right is the one that makes
a manual retry bounce straight back onto the screen it was just cleared from.
`retryNotification` resets `attempts` to 0 and keeps the original creation
time, so "queued over an hour ago and never tried" was true of every
hand-retried row the instant the desk pressed the button. `updatedAt` is the
honest column, and on a row nobody ever touched the two are equal — which is
why every existing test passed either way.

Its companion, and the one to carry forward: **A WEAKER QUESTION AND A
STRONGER ONE, ASKED BY TWO HALVES OF ONE FEATURE, IS THIS REPO'S RECURRING
DEFECT** (A-108's badge vs its list; checkpoint 6's `canSeat`; A-093's map).
The fix that holds is not "make them agree" — it is **one shared predicate and
a test asserting the two answers are EQUAL**, run against a fixture
interesting enough for them to differ. `actionableWhere` is that predicate;
`'counts exactly the rows the screen calls actionable'` is that test.
**A-109 is the same shape again** — `matchFreedSlot` asks the strong question
and the listing asks the weak one — so the assertion to write is that the
row `/staff/opened` OFFERS and the slot `matchFreedSlot` will ACCEPT are the
same set.

## Two things A-108 deliberately did not fix (both named in PROGRESS)

- **The missed-reminder section is dormant on the demo book, and correctly so.**
  Measured **0** on a freshly seeded 713-appointment install: every seeded
  appointment was created seconds ago, so none was ever eligible for a 24-hour
  reminder and the false-positive guard (`createdAt <= startAt - 24h`) excludes
  them all. The guard is working. But the section cannot be walked at a
  checkpoint without a hand-built fixture — **A-113 is the seed-widening item
  and is the natural place to carry one backdated appointment.**
- **`route.ts` has no error isolation between businesses.** One tenant's sweep
  throwing still fails the whole request. Not a regression; worth naming because
  the new loop makes it *look* handled.

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
- **A hand-written appointment fixture must land on WHOLE MINUTES** —
  `appointment_instants_whole_minutes` refuses the seconds `new Date()` came
  with, and it cost A-108 an e2e pass. Floor it:
  `const ms = fromDate(new Date()) + N; toDate(instant(ms - (ms % 60_000)))`.
- **A hand-written appointment fixture cannot set `blockedStart`/`blockedEnd`**
  — a trigger derives them from the row's own buffer columns, which default to
  0. Prisma's types still REQUIRE both, so pass the body and let the trigger
  overwrite. Book through `bookAppointment`, or copy the buffers off the
  service, whenever the footprint is what the test is about — **which it is for
  A-109.**
- **`density-seed.test.ts` has a 120 s per-test budget and it is the first
  thing that breaks under contention.** On a quiet machine the whole unit suite
  is **~185 s** (A-108's dispatch added ~15 s). A timeout there with no
  assertion failure is the machine, not the code: check
  `sysctl -n kern.memorystatus_level` and `pg_stat_activity` and re-run before
  reading a stack trace. **Never overlap a vitest run with a playwright sweep**
  — they share the test database as well as the CPU.
- **`dropdb` may be refused by the sandbox classifier when chained with `&&`.**
  Run `dropdb --if-exists <db>` on its own line, then `createdb` on its own.
- **`bookable_dev` is the checkpoint-9 book (718 appointments)** and has **NO
  StaffUser** — `db:seed:dev` does not seed one. To walk the staff app against
  it, call `seedStaffUser` from `@bookable/db/auth` from a script **inside the
  repo** (a scratchpad path cannot resolve the `@bookable/*` aliases).
  `npm run db:reset:test` if a spec ever looks wrong (~2 min).
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` WITHOUT `FREEZE`
  invents violations** — 18 on `/staff/design`, 15 on `/staff/day`, dark only,
  deterministic. Always go through `e2e/axe.ts`.
- **No staff surface may hand-write a `tel:` link.** `packages/design/
  phone-link.test.ts` walks `app/staff/` and fails on any copy — use
  `PhoneLink` from `@/components/ui/phone-link`. **A-109's rows are phone
  calls**, so this will fire.
- **The seed is not uniform, and three of four stylists differ.** Dana/Priya:
  09:00-17:00 Tue-Sat with a 12:00-13:00 break. Marcus: split Thursday
  (09:00-12:00, 15:00-19:00) clipped by the 18:00 close. Tess: no break, and she
  is JUNIOR — Cut, Blow-dry, Fringe trim, Treatment only. **All four work
  Tue–Sat**, so nobody is `closed` on a Tuesday — a negative assertion aimed at
  a closed column on that day matches nothing and passes vacuously.
- **The seeded Colour carries SEGMENTS that must sum to its duration**, so a
  hand-written appointment fixture whose body is not 120 minutes must use the
  **Cut** (45 min, buffers 0/10) or the **Blow-dry** (30 min, buffers 0/5).
  Shortest sellable footprint in the catalogue is **15 min** (Fringe trim) —
  **that number is A-109's whole subject; derive it, never type it.**
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
