# Next

**Phase 11 is closed and the backlog is EMPTY.** `grep ⬜ docs/prds/06-backlog.md`
returns only the legend line. A-105 is ✅, pushed (`23e5cb4`), CI run
34369048815.

**So the next session is a PHASE CLOSE, not a build item.** The established
shape, from the Phase 8/9/10 closes:

1. **Walk demo checkpoint 9** on a freshly reset, seeded database, and write
   `docs/reviews/20-demo-checkpoint-9.md`. Checkpoint 8's transcript
   (`19-demo-checkpoint-8.md`) is the format. The rule it left behind, and the
   thing to carry in: **a green run over the wrong page looks exactly like a
   green run** — print what you actually measured.
2. **Run the `salon-operator` agent** over `docs/PROGRESS.md` and the backlog
   and ask for the most consequential gap. Write
   `docs/reviews/20-operator-review-phase-11-close.md`.
3. **Scope Phase 12** into `06-backlog.md` from both, as
   `### Phase 12 — scoped <date> from demo checkpoint 9 and the operator
   review at the Phase 11 close`, rows numbered from 108 and items from A-106.

**Model: Opus for the close.** Both halves are judgement, not typing.

## What A-105 just changed underneath it

- **`confirmAppointment`'s `catch` now names the client in all three of its
  questions** — `sameTimeWithSomebodyElse` → `anyProviderAt`, and the
  `alternatives` fall-through. It passes `client.id`, the same holder the
  write above it used.
- **`listTimesOn` and `listAnyProviderTimes` are now four-line shells.** The
  bodies are `timesOn(serviceIds, providerId, day, holderKey)` and
  `anyoneTimesOn(serviceIds, day, holderKey)`, both private. `holderKey`
  deliberately does NOT appear on a `'use server'` export — those are
  browser-callable endpoints. Anything that needs the named question from a
  new caller calls the internal pair, server-side.
- **`booking.spec.ts` has 2 more tests** (`the chair she is already in
  (A-105)`), both verified red against the pre-fix code. The suite is now
  **305 tests in 32 files, ~5.7 min**.
- Nothing in the engine, the constraint, the transition table, any write path
  or any query in `packages/` moved. A-105 was three arguments.

## Known gap A-105 deliberately left

`anyProviderDays` / `listDaysWithOpenings` still take no holder. They are the
BROWSE-time day list, asked before anybody has said who she is, and strict is
right there — but a day whose only openings are her own chair will not appear
in her day list either. Worth a row if the operator raises it; not worth
widening a public endpoint speculatively.

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
- **The seed is not uniform, and three of four stylists differ.** Dana/Priya:
  09:00-17:00 Tue-Sat with a 12:00-13:00 break = 2100 min/week. Marcus: split
  Thursday (09:00-12:00, 15:00-19:00) clipped by the 18:00 close = 2040. Tess:
  no break = 2400, and she is JUNIOR — Cut, Blow-dry, Fringe trim, Treatment
  only.
- **The seeded Colour carries SEGMENTS that must sum to its duration**, so a
  hand-written appointment fixture whose body is not 120 minutes must use the
  **Cut** (45 min, buffers 0/10) or the **Blow-dry** (30 min, buffers 0/5).
- **A hand-written appointment fixture cannot set `blockedStart`/`blockedEnd`**
  — a trigger derives them from the row's own buffer columns, which default to
  0. Book through `bookAppointment`, or copy the buffers off the service.
- **A two-chair room is the cheapest fixture that can disagree with itself.**
  `resource.updateMany({ ..., skip: 2 }, { active: false })` — the idiom is in
  `holder-agreement.test.ts`, `staff-booking.spec.ts` and now `booking.spec.ts`.
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
