# Progress Log — Bookable

Mechanical build log, one entry per backlog item: what it built, what it
decided, what it left behind. Pair with `docs/RELEASE_NOTES.md` for the
portfolio-facing version of the same history.

---

## A-001 — Monorepo & app scaffold

**Built:**
- `apps/web`: Next.js 16 (App Router) + TypeScript + Tailwind v4, via `create-next-app`. Port 3300 hardcoded into `dev`/`start` scripts (never passed as `PORT=` at the command line — the rental-build footgun). shadcn infra wired (`components.json`, `lib/utils.ts`) but no components installed yet — first UI item pulls what it needs.
- `packages/db`: Prisma + Postgres, schema with datasource/generator only — no models. `packages/db/prisma/migrations/` empty, ready for A-003's hand-written migration.
- `packages/core`: given a `package.json` so npm workspaces recognizes it; existing `scheduling/` files untouched except two lint-driven touches (below).
- ESLint: root `eslint.config.mjs` (typescript-eslint) for `packages/**`, and `apps/web`'s own `eslint-config-next` config — both import a shared `eslint-rules/no-axis-crossing.mjs` module encoding the D-3 bans (`new Date(string)`, `Date.parse`, `get/setHours`, `toISOString().slice(0,10)`, `getTimezoneOffset`) as `no-restricted-syntax`, so the ban is enforced repo-wide from commit one, not deferred to A-002.
- Playwright + `@axe-core/playwright` in `apps/web`, config targets `localhost:3300`, `webServer` runs `e2e:server` (build+start) by default, `E2E_DEV=1` swaps in the dev server. One smoke spec proves the harness (page loads, axe finds no serious/critical violations).
- `.github/workflows/ci.yml`: throwaway Postgres service, `prisma migrate deploy` from scratch, `prisma migrate diff --exit-code` as the drift check, unit suite run twice (`TZ=UTC`, `TZ=Pacific/Kiritimati`), then the e2e leg.
- Local dev/test databases: `bookable_dev` / `bookable_test` on the existing local Postgres 17 cluster (not docker — see decision below), `.env.local` / `.env.test` (gitignored) wired per the `dotenv -e .env.test -e .env.local` first-file-wins pattern.
- Root `package.json` scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`, `e2e:server`/`build:test`/`start:test`, `db:migrate:*`/`db:status:*`/`db:reset:test`, `preflight` (swapcheck) wired as a `predev`/`pretest:e2e` hook.

**Decided:**
- **Local dev uses the existing brew-managed Postgres 17 cluster (default port 5432, per-project database names), not the starter's `docker-compose.yml`.** Docker isn't installed on this machine; the sibling projects (`rental_test`, `storage_test`, …) already use this exact pattern. `docker-compose.yml` is left as-is (untouched, still valid for anyone who does have Docker, and matches what CI's Postgres service container effectively provides) — nothing in A-003+ depends on which one is used locally, since both just produce a `DATABASE_URL`.
- **The D-3 lint bans landed in A-001, not deferred to A-002** (backlog lists them under A-002). Cost was a few lines in a shared eslint-rules module; the risk of *not* having them from commit one — a `new Date(string)` slipping into `apps/web` before A-002 exists to forbid it — was worse than the small time-shift.
- **`instantFromIso` in the starter's `types.ts` keeps its `Date.parse`**, with a targeted `eslint-disable-next-line` and a comment pointing at A-002 (it's a guarded fixture helper, not app logic, and rewriting it is explicitly A-002's job — not touched further here).

**Left behind:**
- `npm test` is still the Session-0 red state (37/37 `NotImplementedError`) — expected until A-008. Confirmed identical failure count under both required timezones, which is what A-001 is actually responsible for proving (the CI mechanism, not the engine).
- No Prisma models yet — `prisma migrate diff` drift check currently has nothing to check. It starts doing real work the moment A-003 adds the first migration.
- Removed `_to_delete/agents-duplicate/salon-operator.md` — a byte-identical duplicate of `.claude/agents/salon-operator.md`, explicitly marked for deletion in the starter.
A-001 committed and pushed at 449c539

---

## A-002 — `packages/core/time` (the axis boundary)

**Built:**
- `time/types.ts` — canonical home of the four branded types (`CalendarDay`, `WallTime`, `ZoneId`, `Instant`) plus **validating** constructors. `calendarDay('2027-02-29')` now throws `InvalidTimeValue` instead of silently becoming March 1 (spec LD-2); `zoneId('-05:00')` and `zoneId('CDT')` are refused because neither survives a transition; `instantFromIso` refuses a zoneless string (D-4).
- `time/zone.ts` — **the one module permitted to cross the axes.** `resolve(day, time, zone)` returns the three-armed `unique | gap | ambiguous`, never a bare `Instant`. Also `toLabel` (instant → business-zone label with offset + abbreviation), `startOfDay`, `localDayLengthMinutes`, `addDays`.
- `time/clock.ts` — `Clock` interface, `systemClock` (the only place in the repo that reads the wall clock), `fixedClock(at)` for tests.
- `time/zone.test.ts` — 29 tests, TDD (written and run red before `zone.ts` existed), every expected instant lifted verbatim from spec §3.
- ESLint: `no-restricted-imports` confines `temporal-polyfill` to `packages/core/time/**` — verified it fires outside and stays silent inside.
- `scheduling/types.ts` now re-exports the axis types from `time/` instead of defining its own copies, so there is exactly one definition of each brand.

**Decided:**
- **`resolve()` discriminates gap from ambiguous by round-trip, not by comparing instants.** `Temporal.TimeZone` is removed in temporal-polyfill v1 (verified: `undefined`), so `getPossibleInstantsFor` is unavailable. The naive alternative — compare the `'earlier'` and `'later'` disambiguation results — *cannot work*: both a gap and an ambiguity return two instants an offset-shift apart, in the same order. What separates them is that an ambiguous local time still converts *back* to the local time you asked for and a nonexistent one does not. That is the implemented test, and it is why the module does not depend on a removed API.
- **`gap` carries `earlier`/`later` too**, for explaining a refusal (which instants sit either side). They are explicitly not for coercing into — DST-8 is that luxon shifts forward, date-fns-tz shifts back, and both book a time the customer never chose.
- **`toLabel` returns the abbreviation via `Intl.DateTimeFormat` with an explicit `timeZone`.** Temporal exposes the offset but not the tzdata short name. An explicit zone means this never consults the process zone. Zones without a short name render `GMT+5:45` (verified for Asia/Kathmandu), which is correct and readable.
- **The `instantFromIso` `eslint-disable` from A-001 is gone** — it now goes through `Temporal.Instant.from`, so the repo has zero `Date.parse` call sites and the ban has no exceptions.

**Left behind:**
- `resolve()` handles `endsNextDay` windows only in the sense that `addDays` exists for the caller to use; the union-after-resolution logic (spec DST-7) is A-008's, not the boundary's.
- No tzdata-drift reconciliation (spec X-5, appendix item 9) — Phase 3, and correctly out of A-002's scope.
- The engine suite is still 37 red `NotImplementedError` — unchanged, and every fixture in it passed through the newly *validating* constructors without an edit, which is the useful signal that validation did not break the contract.
- Verified identical results under `TZ=UTC`, `TZ=Pacific/Kiritimati`, `TZ=America/Chicago` and `TZ=Asia/Kathmandu` (29/29 in all four).
A-002 committed and pushed at be75188
PO review + D-15..D-21 committed and pushed at bafeab1


---

## A-003 — Core data model, the exclusion constraint, and the invariant tests

**Built:**
- `packages/db/prisma/schema.prisma` — 22 tables covering every §8 entity. `businessId` on every core table; money integer cents; `CalendarDay` as `CHAR(10)` and `WallTime` as `CHAR(5)` (never `@db.Date`); instants `@db.Timestamptz(3)`.
- **The hand-written migration** (`20260815162006_core_data_model`) — Prisma-generated tables plus a hand-appended section containing the five things Prisma cannot express: `CREATE EXTENSION btree_gist`, the whole-minute + end-after-start + override-consistency CHECKs, the blocked-range trigger, the `appointment_no_overlap` EXCLUDE constraint, the `AppointmentEvent` append-only trigger, and the one-active-segment partial unique index.
- `packages/core/scheduling/status.ts` — the single source of truth for the 8 states, `ACTIVE_STATUSES` derived from `SLOT_FREEING_STATUSES`, with a test asserting the LIVE database constraint predicate still matches it.
- `packages/db/errors.ts` — `isSlotTakenError()`, with the verified reason it cannot be a `code` check.
- `packages/db/constraint.test.ts` — 26 tests written with raw `pg`, bypassing the application entirely.
- `packages/core/time/zone.ts` — added `toDate`/`fromDate`, the only sanctioned `new Date()` in the repo.
- CI now generates the client and asserts all four hand-written objects exist in a database built from scratch.

**Decided:**
- **`blockedStart`/`blockedEnd` are written by a `BEFORE INSERT OR UPDATE` trigger, not by application code.** They cannot be generated columns — `timestamptz_pl_interval` is `STABLE`, verified, and Postgres rejects the column outright with "generation expression is not immutable". The trigger is strictly better than app-side computation because no ORM call, script or psql session can write an inconsistent range. It also recomputes on UPDATE, so a reschedule cannot leave a stale range (tested).
- **Buffers are snapshotted onto `Appointment`.** Follows from the trigger: it must be able to recompute the range on UPDATE without re-deriving which service's buffers applied at booking time. Same reasoning as D-18's price snapshot.
- **`status` is a Postgres ENUM.** Adding a state is deliberately an `ALTER TYPE`, because CLAUDE.md treats it as a grep-every-reader event.
- **`WeeklyWindow.providerId` and `DateOverride.providerId` are nullable, meaning business-level.** AVAIL-04's "business hours ∩ provider hours" needs both patterns in one shape; a separate BusinessHours table would duplicate every column and every query.
- **`packages/core/time` is now an explicit lint exception for `new Date()`**, owning `toDate`/`fromDate`. The ban stays absolute everywhere else — the repo has zero other `new Date(` call sites.

**Verified against Postgres 17 rather than assumed** (each was flagged as unverified in the spec, or is a documented sibling-build defect):
- `timestamptz_pl_interval` is `STABLE`; `tstzrange` is `IMMUTABLE`; generated columns are rejected.
- `EXTRACT(EPOCH FROM ...)` is `IMMUTABLE`, so the whole-minute CHECK is legal; `date_trunc` would not have been.
- The exclusion violation is SQLSTATE **`23P01`**; the append-only trigger surfaces **`23001`** (`restrict_violation`) — my first guess of `2F004` was wrong and the test caught it.
- **Prisma surfaces `23P01` as `PrismaClientUnknownRequestError` with `code === undefined`** — NOT `P2002`, and there is no structured field carrying the SQLSTATE at all. Only the message string has it. The reflex `e.code === 'P2002'` silently falls through to a 500 while the race test still passes. `isSlotTakenError()` pins this with a test.
- `btree_gist` is required: without it `"providerId" WITH =` fails with "data type text has no default operator class".

**Left behind:**
- The engine suite is still 37 red `NotImplementedError` — A-008, which is now the next item.
- `ResourceType`/`Resource`/`ServiceSegment` exist and are unreferenced by the engine (D-12/D-20 affordances, deliberate).
- No seed data — A-011.
- The `bookable_shadow` database is created locally for the drift check; CI creates its own.
A-003 committed and pushed at f9dd882
