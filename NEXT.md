# Next

**A-110 is done, gate green (1624 unit + 1 skipped, 312/312 e2e in 3.5m).**
Commits `7fd4dae` (work) + the SHA record, pushed together in ONE push.
**Confirm the CI run went green before trusting this file.**

`grep "⬜ A-" docs/prds/06-backlog.md` returns **A-111 … A-113**, so the next
session is **A-111** — read its row before anything else.

## What A-110 changed (in case A-111 trips over it)

- **`listWaitlistEntries` takes an args object and a `today`:**
  `listWaitlistEntries(db, { businessId, today, status? })`. `today` is the
  BUSINESS's CalendarDay (`toLabel(fromDate(now), zoneId(tz)).day`), resolved by
  the caller — nothing in the module reads a clock.
- **`notExpiredOn(day)` is the one copy of the closing edge**, private to
  `packages/db/waitlist/waitlist.ts`, used by the listing and by
  `matchFreedSlot`. It is deliberately NOT "covers this day": an entry whose
  window opens next month is still listed. Expiry qualifies `active` ONLY.
- **`openWeekdays(db, businessId)` is new in `@bookable/db/availability`** —
  distinct weekdays across everybody's `WeeklyWindow`, ascending, falling back
  to all seven when a business has no hours yet (a fresh install must not
  render an unfillable form).
- **`/staff/waitlist` now reads prefill params**: `clientId`, `serviceId`
  (REPEATED — the whole visit, first one wins the select, the rest are named on
  screen), `providerIds`, `fromDay`, `toDay`, `dayParts`. `serviceId` is
  deliberately shared with the freed-slot link, which also needs `at` and
  `minutes`, so the two doors cannot be confused.
- **`booking-panel.tsx` has `waitlistHref()` / `waitlistLink`**, rendered under
  `OpenDays` on both refusals.

## The rule A-110 leaves behind

**ONE FACT, TWO READERS, AND THE ENUM VALUE NOBODY EVER WROTE.** `expired` sat
in `WaitlistStatus` from A-023 and no code path has ever set it, while the
listing filtered on `status` alone and `matchFreedSlot` read `toDay` directly.
Silently dead and visibly live. **A status value with no writer is not a
lifecycle — it is a comment**, and the fix is to derive it rather than to add
the job that would eventually disagree. Grep for enum values with no writer;
each one is a promise the schema makes that the code does not keep.

Its companion, this repo's most-repeated defect, now caught the fifth time:
**one shared predicate plus a test asserting the two answers are EQUAL**, run
on a fixture interesting enough for them to differ. **A one-day window cannot
see it** — on `fromDay === toDay === today` the wrong question and the right
one return the same list — so the fixture's window is three weeks and the test
walks across its closing edge.

**And a green assertion can be vacuous because of a DEFAULT.** The prefill e2e
first checked the Service select with `Cut`, which is the catalogue's FIRST
option, so an empty form shows it too — the assertion would have passed against
no prefill at all. It now uses `Colour`. Whenever you assert a form field, ask
what that field shows with nothing filled in.

## What A-110 deliberately did not do

- **A lapsed entry is invisible, not closeable.** Its row stays `active`
  forever and no screen offers to clear it. A "lapsed — ring them or remove
  them" section on the panel is a real backlog row and **it is not written
  yet**.
- **A waitlist entry is still ONE service.** The panel refuses a whole visit;
  the form names the extras in a line of copy rather than modelling them.
  Multi-service entries are a schema change.
- **`openWeekdays` ignores date overrides.** A one-off open Sunday is not a day
  to stand waiting for.

## The A-109 flake this session found and fixed

`appointment-detail.spec.ts`'s `pastNoShow()` started her **40** minutes ago on
a 45-minute Cut with a 10-minute after-buffer, so the released span was
`startAt + 55` minus the click — **exactly 15 minutes, dead on A-109's
catalogue floor** — and `startAt` is floored to the whole minute, so it also
lost a uniform 0-59 seconds before anything else. `Math.round` tipped it to 14
about half the time and `/staff/opened` correctly dropped the row. It is now
**20** minutes, leaving ~35. **A test whose subject is not the bound must not
sit on it** — the mirror of A-109's own rule.

## Environment notes that cost previous sessions a pass

- **Run every command from the REPO ROOT.** The shell's cwd persists between
  calls: a stray `cd apps/web` makes `npm run test:e2e` skip the root's
  `dotenv -e .env.test -e .env.local` wrapper, so the sweep dies on
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
  benign. The whole 312-spec sweep is ~3.5m.
- **KILLING THE SWEEP ON THE ALARM COSTS YOU THE DIAGNOSTICS.** Playwright's
  `list` reporter buffers every failure block until the END of the run, so a
  killed sweep leaves a `✘` line and nothing else. If the failing test is not
  obviously catastrophic, let the run finish once to get the error, then fix.
- **Verify a new bound test against the UNFIXED code, and stub only ONE side.**
  Stubbing the shared predicate broke BOTH halves of the A-110 equality test,
  which made them agree and the test pass. Reproduce the real asymmetry
  instead: remove the predicate from the reader that never had it.
- **A hand-written appointment fixture must land on WHOLE MINUTES** —
  `appointment_instants_whole_minutes` refuses the seconds `new Date()` came
  with. Floor it.
- **A hand-written appointment fixture cannot set `blockedStart`/`blockedEnd`**
  — a trigger derives them from the row's own buffer columns, which default to
  0. Copy the buffers off the service whenever the footprint is what the test
  is about.
- **`density-seed.test.ts` has a 120 s per-test budget** and is the first thing
  that breaks under contention. The whole unit suite is **~185 s**. **Never
  overlap a vitest run with a playwright sweep.**
- **`bookable_dev` is the checkpoint-9 book (718 appointments)** and has **NO
  StaffUser** — call `seedStaffUser` from `@bookable/db/auth` in a script
  INSIDE the repo (a scratchpad path cannot resolve the `@bookable/*` aliases).
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` WITHOUT `FREEZE`
  invents violations** — always go through `e2e/axe.ts`.
- **No staff surface may hand-write a `tel:` link** — use `PhoneLink`.
- **The seed is not uniform.** Dana/Priya: 09:00-17:00 Tue-Sat, 12:00-13:00
  break. Marcus: split Thursday. Tess: no break, JUNIOR (Cut, Blow-dry, Fringe
  trim, Treatment only). **All four work Tue-Sat**, so Sunday and Monday are
  the only closed days — which is what A-110's `openWeekdays` e2e leans on.
- **The catalogue's FIRST service is `Cut`** — never assert a prefilled select
  with it.
- **"Cut" is a prefix of "Cut & finish"** — anchor service-button locators
  (`/^Cut45 min/`).
- **The seeded Colour carries SEGMENTS that must sum to its duration**, so a
  hand-written fixture whose body is not 120 minutes must use the **Cut**
  (45 min, buffers 0/10) or the **Blow-dry** (30 min, buffers 0/5).
- **A two-chair room is the cheapest fixture that can disagree with itself** —
  `resource.updateMany({ ..., skip: 2 }, { active: false })`.
- **e2e exercises the FIRST seed run**: `e2e/fixtures.ts` TRUNCATEs before
  every test, so a spec's `beforeEach` seeds an empty database.
- **Scope the pre-sweep kill to `$PWD`** (`pkill -9 -f "$PWD.*playwright"`),
  then `lsof -ti :3300 | xargs -r kill -9`, then verify BOTH are zero.
- **CI takes ~19-23 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
