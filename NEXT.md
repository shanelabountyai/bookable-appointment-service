# Next

**A-109 is done, gate green (1617 unit + 1 skipped, 310/310 e2e in 3.9m).**
Commits `8bed79f` (work) + `696a29a` (SHA record), pushed together in ONE push.
CI run `34415164263` — **confirm it went green before trusting this file.**

`grep "⬜ A-" docs/prds/06-backlog.md` returns **A-110 … A-113**, rows 112–115.
**So the next session is A-110, row 112** — an **M**, no decision needed.

## A-110 in one line

The waitlist has **one door in (the nav) and none out**. `/staff/book`,
`/staff/day` and `lib/booking/` contain **zero** references to it, so the exact
refusal WAIT-01 exists for — *"Nobody can take that on Thursday"*
(`booking-panel.tsx:416`, `:464`) — offers nothing, and adding her means
navigating away and **searching for the same client a second time** on a form
(`entry-form.tsx:29-36`) whose every field was on the abandoned screen, with her
still on the phone. Two halves:

1. **"Put her on the list for this"** on both refusals, prefilled from what the
   panel already holds. **No second write path** — `addWaitlistEntry` unchanged,
   called with a prefill.
2. **Nothing in the repo ever writes `expired`** (grepped, zero outside the
   enum) and `listWaitlistEntries` (`waitlist.ts:75`) filters on status alone —
   so an entry whose `toDay` was in June sits on the September queue looking
   like somebody to ring, while `matchFreedSlot` correctly refuses to match it.
   **Silently dead and visibly live**, and master PRD §8 promises the opposite.

## What A-109 changed (in case A-110 trips over it — it touches the same files)

- **`matchFreedSlot`'s fit check is no longer inline.** It is
  `fitsFreedSpan(serviceFootprintMinutes(service, override), freedMinutes)`,
  both from `@bookable/core/settings`. Same behaviour, one copy.
- **`listOpenedSlots` has a FOURTH bound: length.** A span shorter than
  `shortestSellableFootprintMinutes(db, businessId)` (exported from
  `packages/db/appointments/opened.ts`) never reaches the screen. On the demo
  catalogue that floor is **15** (fringe trim, 10 + 0 + 5).
- **`opened-vacated.test.ts`'s fixture salon now sells a Fringe trim.** Without
  a short service the floor there is the 80-minute cut, and a released
  no-show's 50 remaining minutes drops off for a reason unrelated to the test.
  **Any new test that builds its own salon and expects a short freed span on
  `/staff/opened` must give that salon something short to sell.**

## The rule A-109 leaves behind

**A BOUND THAT ONLY EVER GUARDS ZERO IS NOT A BOUND — AND THE ONLY VALUE THAT
CAN EXPOSE IT IS ONE THAT IS SMALL AND STILL POSITIVE.** `/staff/opened`'s
released-no-show span is the one LIVE quantity on the screen: it is recomputed
from `now` on every read and decays all afternoon. It dropped off at zero and at
nothing before it, so it spent the last quarter-hour of its life at the TOP of a
list ordered *soonest to expire first* — the ordering **guarantees** the dead
row takes the position reserved for the most urgent thing. Every existing test
asserted a freshly-released span, which passes against the bug.

Its companion, and this repo's most-repeated defect, now caught for the fourth
time: **A WEAKER QUESTION AND A STRONGER ONE, ASKED BY TWO HALVES OF ONE
FEATURE** (A-109's listing vs `matchFreedSlot`; A-108's badge vs its list;
checkpoint 6's `canSeat`; A-093's map). The fix is never "make them agree" — it
is **one shared predicate plus a test asserting the two answers are EQUAL**,
run on a fixture interesting enough for them to differ. Here that is
`fitsFreedSpan`, and a test that walks the decay (50, 16, 15, 14, 2 minutes
left) asserting *offered non-empty ⟺ accepted non-empty* at every instant.

And: **derive the number, never type it.** 15 is a fact about the price list,
not a constant — the tests retire the trim (floor rises to 80) and add a
five-minute override (falls to 10), and a hard-coded 15 could not have moved.

## Two things A-109 deliberately did not fix (both named in PROGRESS)

- **The row's OFFER can still be a service that no longer fits.** The floor asks
  *"can this salon sell this span to anything?"*; the link asks *"who wants it,
  for the service she was booked for?"* Between the catalogue floor and the seed
  service's own footprint — 15 to 80 minutes of a decayed Cut — the row is worth
  showing and its link still lands on *"nobody fits this one"*. Closing it means
  choosing a DIFFERENT service to ring about once the original stops fitting,
  which changes what the row SAYS as well as what it links to (A-067 was
  emphatic that the dropped service is the one to ring about). **A design
  decision, not a predicate — worth a backlog row, and it is not written yet.**
- **The floor is catalogue-wide, not per stylist.** Tess is junior and works
  four services; a span too short for anything she does still lists if some
  other stylist's shortest fits. Deliberately the weak direction — a reader
  stricter than the constraint refuses work the salon needs.

## Environment notes that cost previous sessions a pass

- **Run every command from the REPO ROOT.** The shell's cwd persists between
  calls: a stray `cd apps/web` (or `cd packages/db/waitlist` — that one bit this
  session) makes the next relative path fail, and makes `npm run test:e2e` skip
  the root's `dotenv -e .env.test -e .env.local` wrapper so the sweep dies on
  `CRON_SECRET must be set in .env.test`, which reads exactly like a missing
  secret and is not one.
- **`npm run test:e2e -- <args>` DOES NOT WORK.** npm puts the args after
  `-w apps/web` and it dies with `Workspaces not supported for global
  packages`. To run one spec or one `-g` filter:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test
  --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
  The bare `PORT=3300 npm run test:e2e` (no args) is fine for the full sweep.
- **`npm test -- <path> -t "<name>"` DOES work** and is how to run one vitest
  file. Never bare `npx vitest` — without the dotenv wrapper every DB test
  SKIPS and the file merely "fails". Same for `playwright --list`.
- **An e2e failure alarm must grep `✘` ONLY.** A wider alternation on `Error:`
  fires on `[WebServer] ⨯ Error: The destination stream closed early`, which is
  Next's streaming abort when Playwright navigates away mid-response — benign,
  and it cost this session two false alarms. The whole 310-spec sweep is 3.9m.
- **Verify a new bound test against the UNFIXED code before believing it.**
  Stub the predicate (`fitsFreedSpan(0, …)`), run `-t "<item>"`, confirm exactly
  the new assertions fail, restore. A-109's two bound tests failed and the three
  around them passed, which is what makes them worth having.
- **A hand-written appointment fixture must land on WHOLE MINUTES** —
  `appointment_instants_whole_minutes` refuses the seconds `new Date()` came
  with. Floor it: `const ms = fromDate(new Date()) + N;
  toDate(instant(ms - (ms % 60_000)))`.
- **A hand-written appointment fixture cannot set `blockedStart`/`blockedEnd`**
  — a trigger derives them from the row's own buffer columns, which default to
  0. Prisma's types still REQUIRE both, so pass the body and let the trigger
  overwrite. Copy the buffers off the service whenever the footprint is what the
  test is about.
- **`density-seed.test.ts` has a 120 s per-test budget and it is the first thing
  that breaks under contention.** The whole unit suite is **~185 s** on a quiet
  machine. A timeout there with no assertion failure is the machine: check
  `sysctl -n kern.memorystatus_level` and `psql -d postgres -c "SELECT datname,
  count(*) FROM pg_stat_activity GROUP BY datname"` before reading a stack
  trace. (Bare `psql` fails: there is no `shanelabounty` database.) **Never
  overlap a vitest run with a playwright sweep.**
- **`dropdb` may be refused by the sandbox classifier when chained with `&&`.**
  Run `dropdb --if-exists <db>` on its own line, then `createdb` on its own.
- **`bookable_dev` is the checkpoint-9 book (718 appointments)** and has **NO
  StaffUser** — `db:seed:dev` does not seed one. To walk the staff app against
  it, call `seedStaffUser` from `@bookable/db/auth` from a script **inside the
  repo** (a scratchpad path cannot resolve the `@bookable/*` aliases).
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` WITHOUT `FREEZE`
  invents violations** — always go through `e2e/axe.ts`.
- **No staff surface may hand-write a `tel:` link.** `packages/design/
  phone-link.test.ts` walks `app/staff/` and fails on any copy — use
  `PhoneLink` from `@/components/ui/phone-link`.
- **The seed is not uniform, and three of four stylists differ.** Dana/Priya:
  09:00-17:00 Tue-Sat with a 12:00-13:00 break. Marcus: split Thursday
  (09:00-12:00, 15:00-19:00) clipped by the 18:00 close. Tess: no break, and she
  is JUNIOR — Cut, Blow-dry, Fringe trim, Treatment only. **All four work
  Tue–Sat**, so nobody is `closed` on a Tuesday — a negative assertion aimed at
  a closed column on that day passes vacuously.
- **The seeded Colour carries SEGMENTS that must sum to its duration**, so a
  hand-written fixture whose body is not 120 minutes must use the **Cut**
  (45 min, buffers 0/10) or the **Blow-dry** (30 min, buffers 0/5).
- **A two-chair room is the cheapest fixture that can disagree with itself.**
  `resource.updateMany({ ..., skip: 2 }, { active: false })` — the idiom is in
  `holder-agreement.test.ts`, `desk-day-search.test.ts`, `staff-booking.spec.ts`
  and `booking.spec.ts`.
- **e2e exercises the FIRST seed run**: `e2e/fixtures.ts` TRUNCATEs before every
  test, so a spec's `beforeEach` seeds an empty database.
- **Scope the pre-sweep kill to `$PWD`** (`pkill -9 -f "$PWD.*playwright"`),
  then `lsof -ti :3300 | xargs -r kill -9`, then verify BOTH are zero.
- **CI takes ~19-23 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
