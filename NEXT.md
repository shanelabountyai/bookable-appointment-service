# Next

**Phase 12 is scoped and the backlog has eight rows on it.**
`grep "⬜ A-" docs/prds/06-backlog.md` returns **A-106 … A-113**, rows 108–115.
The Phase 11 close is done: `docs/reviews/20-demo-checkpoint-9.md` and
`docs/reviews/20-operator-review-phase-11-close.md`, both committed.

**So the next session is a BUILD item: A-106, row 108, top of the backlog.**

> **The desk cannot answer "when can you fit me in?", and the customer can.**
> `daysWithAvailability` (`slot-query.ts:306`) and `anyProviderDays`
> (`any-provider.ts:240`) both take `audience: 'public' | 'staff'` and **all
> four call sites pass `'public'`** — the `'staff'` arm is dead code. Three
> staff refusals dead-end instead: `booking-panel.tsx:416`, `:464`, and
> `move-panel.tsx:108` (which is where `/staff/conflicts`'s per-row "Move her"
> link lands). Reuse `daysWithAvailability` with `audience: 'staff'` — do not
> write a cheaper predicate. Cap at a fortnight. **Keep the date box beside
> it.** The fixture must be a MULTI-DAY absence.

**Model: `opusplan` or Sonnet is defensible — this is reuse, not design.** The
one part that is not routine is the fixture, and A-100's rule says why: on a
book where everyone works the same hours "tomorrow" is always the answer and a
one-day search passes. If you want Opus for anything, want it for the fixture.

## What the close just changed underneath it

- **Only docs moved.** No product code, no schema, no migration. `git show
  --stat` on the close commit is `NEXT.md`, `docs/PROGRESS.md`,
  `docs/RELEASE_NOTES.md`, `docs/prds/06-backlog.md` and the two review files.
- **The gate was not run and did not need to be** — CI's `paths-ignore` skips
  docs-only pushes, and nothing executable changed. **A-106 is a build item;
  the full gate applies to it.**
- **No new D-numbers were taken.** Rows 110 (A-108, the reminder catch-up) and
  114 (A-112, the cancel undo) each say DECIDE FIRST and carry the options with
  the operator's recommendation. Do not build either until its D-number is in
  `07-decisions.md`.

## The two rules the close leaves behind

- **Widening who is RENDERED is not the same edit as widening who can be ACTED
  ON.** A control is a reader too, its filter is usually the same boolean, and a
  screen that renders a row it will not let you touch fails no test — the
  assertion everybody writes is that the row is *there*. (Checkpoint 9, Scene 1;
  it is row 109 / A-107.)
- **A parameter with a default is a decision nobody ever makes again.** Grep for
  the values a function is actually CALLED with, not the values it accepts.
  (Operator review §8 — and it is exactly what A-106 is.)

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
  Both are allowed individually.
- **`bookable_dev` was dropped, recreated, migrated and seeded for the walk** and
  is currently the checkpoint-9 book (718 appointments). `bookable_test` is
  untouched. `npm run db:reset:test` if a spec ever looks wrong.
- **The demo book has NO StaffUser** — `db:seed:dev` does not seed one. To walk
  the staff app against `bookable_dev`, call `seedStaffUser` from
  `@bookable/db/auth` yourself, from a script **inside the repo** (a scratchpad
  path cannot resolve the `@bookable/*` workspace aliases).
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` WITHOUT `FREEZE`
  invents violations** — 18 on `/staff/design`, 15 on `/staff/day`, dark only,
  deterministic. Always go through `e2e/axe.ts`; a one-off script outside the
  suite is outside the lint rule that enforces it.
- **The seed is not uniform, and three of four stylists differ.** Dana/Priya:
  09:00-17:00 Tue-Sat with a 12:00-13:00 break = 2100 min/week. Marcus: split
  Thursday (09:00-12:00, 15:00-19:00) clipped by the 18:00 close = 2040. Tess:
  no break = 2400, and she is JUNIOR — Cut, Blow-dry, Fringe trim, Treatment
  only.
- **The seeded Colour carries SEGMENTS that must sum to its duration**, so a
  hand-written appointment fixture whose body is not 120 minutes must use the
  **Cut** (45 min, buffers 0/10) or the **Blow-dry** (30 min, buffers 0/5).
  Shortest sellable footprint in the whole catalogue is **15 min** (Fringe trim,
  10 + 5 after) — that number is row 111's whole finding.
- **A hand-written appointment fixture cannot set `blockedStart`/`blockedEnd`**
  — a trigger derives them from the row's own buffer columns, which default to
  0. Book through `bookAppointment`, or copy the buffers off the service.
- **A two-chair room is the cheapest fixture that can disagree with itself.**
  `resource.updateMany({ ..., skip: 2 }, { active: false })` — the idiom is in
  `holder-agreement.test.ts`, `staff-booking.spec.ts` and `booking.spec.ts`.
- Check `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity
  GROUP BY datname"` and `sysctl -n kern.memorystatus_level` **before** reading
  a stack trace. (Bare `psql` fails: there is no `shanelabounty` database.)
- **Scope the pre-sweep kill to `$PWD`** (`pkill -9 -f "$PWD.*playwright"`) — a
  sibling project's sweep may be running.
- **The seed alone is 17 s**; the 120 s hook budget stands.
- **The unit suite is 1590 passed + 1 skipped and takes ~2.6 minutes** — longer
  than the 120 s foreground budget, so background it. The e2e suite is **305
  tests in 32 files, ~5.7 min**.
- **CI takes ~19-22 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
