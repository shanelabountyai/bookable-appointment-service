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


---

## A-008 — The slot engine (pure)

**Built:**
- `computeSlots(SlotQuery) -> SlotResult` in `packages/core/scheduling/slot-engine.ts`. All 37 pre-written starter tests green.
- `slot-engine.properties.test.ts` — 21 fast-check property tests covering the §2 invariants: purity, order-insensitivity of both `busy` and `windows`, slot shape, grid alignment, "never returns a slot overlapping a busy blocked range", "never outside a window or crossing close", "never before now/lead", four monotonicity laws (busy, duration, buffer, now), explain/slot agreement, and the DST-day accounting.
- Total suite is now 115 tests, identical under `TZ=UTC` and `TZ=Pacific/Kiritimati`.

**Decided:**
- **Candidate-then-filter, not interval-subtraction** (spec §1.3). Costs short-circuiting; buys accumulated exclusion reasons, which is what converts the matrix from smoke tests into real tests — absence assertions otherwise pass for a dozen wrong reasons.
- **A `gap` resolves to the instant AFTER the gap for BOTH window edges.** This is what makes DST-7 work: split rows 01:00–02:00 and 03:00–04:00 become [07:00Z,08:00Z) and [08:00Z,09:00Z), which union into one contiguous window. Taking `earlier` for the close creates a one-hour phantom hole and silently loses every long booking on the transition morning — confirmed by mutation test.
- **An `ambiguous` edge takes `earlier` for an open and `later` for a close** — the widest honest reading of "open 01:00–02:00" on a day when both happen twice. The doubled hour is real capacity (FB-1).
- **Touching windows are merged**, not just overlapping ones: `a.end === b.start` is contiguous in physical time and treating them as two windows would reject any service spanning the join.
- **`InvalidTimeValue` now extends `InvalidSlotQuery`.** DEG-12 (`zoneId('CST')`) throws inside the argument expression, before `computeSlots` is ever called, so the engine cannot be the thing that throws. Rather than weaken A-002's validation or edit the starter's normative test, the narrower error became a subclass of the broader one. Definition moved to `time/types.ts` (re-exported from `scheduling/types.ts`, so no import site changed) because a subclass must be declared where its parent lives without an import cycle.

**Verified, not assumed:**
- **Generator sanity:** 500 generated queries produced 245 non-empty results (max 154 slots). Property tests that only ever see empty slot lists pass vacuously; this one does not.
- **Mutation-tested the suite's teeth**, three deliberate bugs, all caught: half-open -> closed intervals (6 failures), checking the body instead of the blocked range so buffers stop mattering (2 failures), and the DST-7 gap-close bug (1 failure).

**Left behind:**
- `daysWithAvailability`, the busy-set query and the horizon cap are A-026 (the adapter), deliberately — this item is the pure function only.
- `'nonexistent-local-time'` is defined in the contract but never emitted by the grid: with window-open anchoring every candidate is a real instant by construction. It belongs to the booking POST validation path (DST-8), which is A-009.
- Added `pretypecheck: clean:syncdupes`. `~/Documents` is iCloud-synced and duplicates Next's generated types as `routes.d 2.ts`, breaking typecheck with TS2300/TS6200 errors unrelated to the code. It had already cost two debugging detours.
A-008 committed and pushed at 8352f7a


---

## A-004 — Notification outbox + `ChannelAdapter`

**Built:**
- `packages/core/notifications/adapter.ts` — the `ChannelAdapter` contract (`supports`/`send`), `OutboundMessage`, `SendResult`, `ChannelSendError`. Deliberately dependency-free — no Prisma import — so `packages/core` stays independent of `packages/db`; `NotificationChannel` is a plain `'email' | 'sms'` union rather than the Prisma-generated enum.
- `packages/core/notifications/logging-adapter.ts` — the only adapter this build runs on. Logs every send to the console; the outbox row already exists before it's ever called.
- `packages/db/notifications/config.ts` — `notificationConfig()`: `NOTIFICATIONS_ENABLED` (kill switch, default true) and `NOTIFICATIONS_SANDBOX_TO` (redirect). Read per call, not cached, so a flip takes effect on the next call.
- `packages/db/notifications/enqueue.ts` — `enqueueNotification(db, input)`, the decide-and-record half. Idempotent on `dedupeKey`: a second call with the same key returns the *first* decision unchanged (verified — a different payload on the retry does not overwrite). Never throws for a missing recipient (P2-4's walk-in-no-phone case) or a killed switch — both are recorded as `suppressed` with a reason. Takes `Prisma.TransactionClient | PrismaClient`, so a caller's booking write and its confirmation enqueue commit or roll back together (verified with a deliberately-failing transaction).
- `packages/db/notifications/dispatch.ts` — `dispatchPendingNotifications(prisma, adapter, limit)`, the send half. Re-checks the kill switch before touching anything queued (verified: flipping it mid-backlog halts already-`pending` rows, not just future enqueues). Applies the sandbox redirect only to the actual `send()` call — the outbox row's `recipient` column always keeps the true intended address (verified).
- `packages/db/notifications/provider.ts` — the one line that wires in a real driver later.
- `packages/db/index.ts` — the Prisma client singleton (new; nothing needed it before this item).
- `packages/db/errors.ts` — added `isUniqueViolation()`, verified against a real P2002 (`PrismaClientKnownRequestError`, `meta.target: ['dedupeKey']`) — confirming a plain `@unique` field behaves nothing like the exclusion constraint's invisible `23P01` from A-003.
- 15 new tests (2 pure adapter tests, 13 against the real database).

**Decided:**
- **The kill switch is applied in `enqueue()`, not only in `dispatch()`.** "Notifications are still decided and recorded" (the property that makes "why didn't this go out" answerable) requires the decision to exist even for a notification that was never going to send. `dispatch()` re-checks it anyway, so an already-queued backlog halts within one call, not just future enqueues.
- **The sandbox redirect applies only at `dispatch()` time.** It changes where a real send goes, never what's on the record — enqueue always writes the true intended `recipient`.
- **No claim-before-send row locking in `dispatch()`, marked `ponytail:`.** Two concurrent dispatchers could pick up the same row. Deferred because nothing calls dispatch from more than one place yet (no cron exists — that's A-022). Upgrade path recorded in the code: an `UPDATE ... WHERE status='pending' RETURNING` claim, or a fifth `sending` status.
- **`OutboundMessage` carries `template`/`payload` raw, no `subject`/`body`.** The `NotificationOutbox` schema (frozen in A-003) has no subject/body columns — only `template: String` and `payload: Json` — and no template-rendering vocabulary exists yet. Inventing one now would be exactly the speculative work the schema's own shape already declines to assume.

**Verified, not assumed:**
- A plain `@unique` field (`dedupeKey`) surfaces through Prisma as `PrismaClientKnownRequestError`/`P2002`/`meta.target` — the opposite of A-003's exclusion-constraint finding, confirmed by probe before writing `isUniqueViolation()`.

**Left behind — and the thing that mattered most this item:**
- **Adding this item's second Postgres-touching test file broke A-003's, under BOTH timezones, with two different failure counts (6 vs 8) that looked at first like a real timezone bug.** It wasn't: vitest runs test files in parallel by default, and `constraint.test.ts` and the new `notifications.test.ts` both truncate/delete overlapping tables in `beforeEach` against the one shared local Postgres database — a real, reproducible deadlock and FK violations from two files racing each other, not from the code under test. Confirmed by running each file alone (both pass) and both together with file-parallelism forced off (both pass, together, three times). Fixed with `fileParallelism: false` in `vitest.config.ts`, which removes the race class for every future DB-touching test file too, not just these two.
- No cron/job runner yet to call `dispatchPendingNotifications()` — that's NOTIF-02/A-022.
- No route or write path calls `enqueueNotification()` yet — nothing sends until BOOK-06 (A-009) exists to call it. This item's whole job was to have the seam ready before that.
A-004 committed at 02edd72


---

## A-005 — Staff session, and the actor on every mutation

**Built:**
- `packages/core/auth/password.ts` — scrypt via `node:crypto`, no dependency. Random 16-byte salt per password, `timingSafeEqual` comparison, OWASP-floor parameters (N=2^14, r=8, p=1), stored self-describing as `scrypt$N$r$p$salt$hash` so cost can be raised later without locking anyone out. Exports `DUMMY_HASH_PROMISE` for the user-not-found branch.
- `packages/core/auth/session.ts` — HMAC-SHA256 signed session tokens, `signSession`/`verifySession`. No JWT library: nothing it offers (algorithm negotiation, JWKS, third-party verifiers) applies when one server signs and verifies. Expiry lives *inside* the signature. Secret and `now` are parameters, so it is unit-testable with no environment and no clock. 8-hour TTL.
- `packages/core/auth/actor.ts` — the `Actor` type (D-9), mirroring the Prisma enum as a plain union so `packages/core` stays free of `packages/db`.
- `packages/db/auth/staff.ts` — `authenticateStaff` (timing-equalised) and `findStaffById`.
- `packages/db/auth/seed-staff.ts` — creates/resets the single credential; **refuses to run with NODE_ENV=production**.
- `apps/web/lib/auth/session.ts` — the cookie, and `requireStaff()` / `currentActor()`. The one place a cookie becomes an Actor.
- `apps/web/lib/auth/actions.ts` — login/logout server actions, one generic error message for every failure.
- `apps/web/app/staff/` — a genuinely protected page and a login form (`useActionState`, `aria-live` on the error).
- Subpath `exports` maps on both packages plus `transpilePackages` — the packages ship TS source, so Next has to transpile them.
- 28 pure auth tests + 10 database tests + 7 new e2e specs.

**Decided:**
- **scrypt over bcrypt/argon2.** It is in the standard library and memory-hard; argon2 would mean a native build step for a marginal gain over correctly-parameterised scrypt. No new dependency for a security primitive.
- **A hand-rolled signed cookie over NextAuth.** D-9 says this explicitly — "stated as minimal so nobody builds Auth.js role machinery in month one". The sibling rental build uses NextAuth + full RBAC; copying it here would be building Phase 3 in Milestone 1.
- **`SESSION_SECRET` missing is a hard failure, never a default.** A fallback secret means every deployment that forgot to set one shares the same forgeable signing key.
- **`currentStaff()` re-reads the StaffUser row on every call** rather than trusting the cookie's contents, so deleting a staff user invalidates their live sessions on the next request with no revocation list to maintain.
- **One error message for unknown-email and wrong-password, and equal timing for both.** `authenticateStaff` verifies against `DUMMY_HASH_PROMISE` when no user is found, so the two branches cost the same ~100ms of scrypt — otherwise the login form is a user-enumeration oracle. Asserted as a ratio (<5x), not an absolute millisecond bound, because a tight timing assertion on shared CI hardware is a flake generator.

**Left behind:**
- **`ponytail:` no rate limiting or lockout on login.** The scrypt cost is the only brute-force control today. Reasonable for one shared credential on a single-tenant v1, but explicitly *not* a substitute for a limiter. Upgrade path recorded in `staff.ts`: A-013 already needs a `RateLimitCounter` with an advisory-lock consume for the manage-token route — build it once there and call it here too. **This is the most important thing to remember from this item.**
- No password *change* flow — A-025 (owner settings) is where that belongs.
- `currentActor()` exists and is tested, but nothing mutates yet, so nothing calls it. A-009/A-012 are its first real consumers.

**Found and fixed along the way:**
- **`apps/web` was still on create-next-app's `target: ES2017`** while the root tsconfig targets ES2022. Invisible until `transpilePackages` made apps/web compile `packages/core` — at which point the *older* target governed the *shared* code and the Temporal BigInt literal in `zone.ts` failed the production build. Fixed the target, and removed the BigInt entirely (`Temporal.Instant.fromEpochMilliseconds` was always the better call).
- **The Playwright process had no `DATABASE_URL`.** The web server got it via `e2e:server`, but the test runner itself did not, so `globalSetup` could not seed the staff credential. Root `test:e2e` now wraps with the same first-wins dotenv layering as every other script.
A-005 committed at d28e0c9


---

## Milestone 1 boundary — operator review, and the frozen things it caught

Not a backlog item. `docs/reviews/05-operator-review-milestone-1.md` at the close of Milestone 1. Every load-bearing claim was verified against the code and the live database before acting; all confirmed.

**Fixed in code (a defect in A-008 as shipped):**
- **The engine reported EVERY non-booking busy kind as `overlaps-time-off`.** An `ad_hoc_block` told the front desk a stylist was away when she was standing there. The matrix missed it because no fixture used `ad_hoc_block` and the one time-off test asserted `toContain`, which passes for a dozen wrong reasons. Each kind now reports its own reason, in a stable order (the busy array's order must not leak into a `toEqual` assertion). 5 regression tests.
- **`isSlotTakenError()` did not recognise a driver-level violation.** It matched only the message string — which carries the SQLSTATE through Prisma but NOT through node-postgres, where it lives in `error.code`. A-003's test exercised only the Prisma path, so the gap was invisible. Now checks the structured `code` first and falls back to the message, and requires the constraint name either way.

**New decisions:**
- **D-22 — running late is first-class.** A stored per-provider-per-day delta consumed by the engine as a `running-late` BusyInterval, NOT a rewrite of `startAt`. The contract vocabulary (`BusyInterval.kind`, `ExclusionReason`) landed immediately so A-026 cannot be written against the wrong shape; storage and UI are A-018.
- **D-23 — multi-service visits are v1 (VISIT-01).** Resolves a direct §3/§10 contradiction where VISIT-01 was declared in scope and simultaneously listed as Phase 3, and existed nowhere else. The deciding argument is that the workaround is *refused by the database*: two adjacent appointments overlap once one service's `bufferAfter` meets the next one's `bufferBefore`, so staff would override on every combination booking and learn to ignore the override marker D-8 depends on.

**Migration `20260815223953_operator_review_m1`:**
- **The exclusion constraint is now `DEFERRABLE INITIALLY IMMEDIATE`.** "Put Mrs. Hall at 2, move Jenny to 3" is a routine desk move with NO order of single-row updates that avoids a transient overlap — it died with `23P01`, which the write path would report as "that slot is taken" while staff were trying to *move* it. Verified before and after: the swap fails today, succeeds inside `SET CONSTRAINTS ... DEFERRED`, and ordinary single-row booking is untouched (`condeferred = f`), so A-009's race interleavings are unaffected. Deferrability cannot be altered in place — `ALTER CONSTRAINT` is foreign-key only (verified) — so the constraint is dropped and re-added with a byte-identical predicate.
- `NotificationOutbox.appointmentId` (nullable, indexed, `onDelete: Restrict`) — "was she actually told?" was otherwise a `LIKE` against a key format, and the reminder key deliberately embeds `startAtEpochMs`, so a rescheduled appointment's messages share no prefix.
- `Appointment.notes` — the per-visit note had nowhere to go but the pinned client note, where it would bury the allergy line.
- `Appointment.conflictAckAt`/`conflictAckReason` — the conflict stays derived; only the human acknowledgment is stored, because it is not derivable.

**Sequencing changed:** A-025 now also builds the SETUP seed and validates `lead >= max(cutoffs)`; the provider-deactivation impact preview moved to A-019 (it cannot run before appointments exist); A-011 became the DENSITY seed and moved ahead of A-010; A-009's signature is staff-shaped from day one with self-serve as the restricted caller; A-009 gains a ninth race interleaving (staff override vs. concurrent self-serve). New item **A-028** (VISIT-01) after A-009.

**Left behind:** R-8 (actor/audit on availability tables) routed to A-007, R-10 (client merge tombstone) to A-015 — both recorded on their owning rows rather than built now.
M1 operator review applied at **0747a85**.

> **History note.** That commit is mislabelled `Record commit SHA (4009482)`.
> The commit command carrying the real message contained unescaped double
> quotes, so the shell split it and the commit failed; the SHA-record command
> that followed then swept up the whole staged change set under its own
> message. The content is correct and complete — see the entry above and
> `git show --stat 0747a85` — only the subject line is wrong, and it is left
> uncorrected rather than force-pushed over. Lesson applied: commit messages
> of any length now go through a file (`git commit -F`), never an inline
> double-quoted string.


---

## A-025 — Business & provider setup

**Built:**
- `packages/core/settings/policy.ts` — pure validation. `validateBusinessPolicy` cross-checks `minimumLeadMinutes` against `max(business cutoff, every ACTIVE service's cutoff override)`; `validateServiceCutoff` guards the other write path; `worstCutoff` names the offender; `formatMinutes` renders owner-facing durations.
- `packages/db/settings/business.ts` — `getBusinessSettings`/`updateBusinessSettings`, re-running validation at the data layer (a form is one caller; the invariant belongs to the data). Loads the active services itself so the cross-check cannot be skipped.
- `packages/db/settings/providers.ts` — roster CRUD, `setProviderActive`, `countFutureAppointments`. Ordering is `displayOrder` then name, which is the order SVC-02's "any provider" tiebreak depends on.
- `packages/db/settings/setup-seed.ts` — the SETUP seed (operator S-1): 1 business, 4 providers, 8 services, qualifications, weekly hours, 1 date override. Idempotent, deterministic, refuses production.
- `apps/web/app/staff/settings` + `apps/web/app/staff/providers` + `lib/settings/actions.ts` — both behind `requireStaff()`.
- 31 pure policy tests, 20 database tests, 6 new e2e specs. Suite is now 232 unit + 14 e2e.

**Decided:**
- **The lead/cutoff rule is enforced on BOTH write paths, not at startup.** D-11 said "startup validation", which cannot work once D-19 lets each service override the cutoff: the dangerous pair is created by editing *either* the business policy *or* a service, and a startup check only runs when nobody is editing anything. Both writers call the same pure validator.
- **The validator takes the ACTIVE services as an argument** rather than reading them itself, so it stays pure and unit-testable, and the DB layer is the single place that decides what "active" means.
- **`formatMinutes` prefers hours up to three days** — "24 hours notice", "48 hours notice" is how this trade states a cancellation policy. Rendering 1440 as "1 day" is arithmetically identical and reads as if written by someone who has never taken the call. A test pins it.
- **The seed deliberately leaves Tess unqualified for colour work**, seeds Marcus a split shift, and gives everyone but Tess a midday break. A seed where every provider does every service at the same hours makes SVC-02's "an unassigned provider never appears" and AVAIL-01's "breaks belong to the window" untestable — which is most of what a seed is for.
- **Deactivation writes `Provider.active` and nothing else** (operator S-2). The AVAIL-05 impact preview is A-019; `countFutureAppointments` exists and returns 0 until A-009 can create any, which is exactly why the preview is not built here.

**Caught by CI, not by the local gate:**
- **The dual-TZ run failed on Kiritimati while UTC passed — and it was not a timezone bug.** All 20 settings tests died in `beforeEach` with `Appointment_providerId_fkey`. Cause: each DB test file cleaned up its own tables with a hand-maintained `deleteMany()` order, so whichever file ran LAST left rows that broke the next file — and CI runs the whole suite twice against one database, so the second run inherited the first's leftovers. It read exactly like the bug class the dual-TZ gate exists to catch, which is the second time that has happened (A-004 was the first).
- Fixed with `packages/db/testing/reset.ts`: one `TRUNCATE ... RESTART IDENTITY CASCADE` over every table, used by all four DB test files. CASCADE resolves the FK order itself, so no test has to know the graph or what ran before it. TRUNCATE is also the only thing that can reset `AppointmentEvent` at all — it is append-only by trigger, and the trigger refuses DELETE.
- Verified by running the suite three times back-to-back against one database (the thing CI actually does and the local gate never did).

**Left behind:**
- Provider reordering has a `displayOrder` field and an `updateProvider` path but no drag-to-reorder UI — the roster is four people and the field is settable; a sortable list is A-016's problem when the day grid needs column order.
- No service catalogue UI — that is A-006, next. `validateServiceCutoff` is written and tested, waiting for its caller.
A-025 committed at 0294254


---

## A-006 — Service catalog

**Built:**
- `packages/core/settings/service.ts` — pure validation: `validateService` (name/duration/buffers/price), `validateQualificationOverride` (SVC-02's per-provider duration/price overrides — independently optional, either/both/neither), `effectiveDurationMinutes`/`effectivePriceCents` (override-or-base resolution).
- `packages/db/settings/services.ts` — CRUD re-validating at the data layer (cutoff check reuses A-025's `validateServiceCutoff`, so a service saved here is held to the same D-11/D-19 rule as the business settings form); `qualifyProvider`/`unqualifyProvider` (upsert-based — re-ticking an already-qualified provider updates her overrides rather than erroring); `countServiceFutureAppointments` and `DeactivationRequiresConfirm` for SVC-03.
- `apps/web/app/staff/services` — add/edit/deactivate, and per-service qualification management, all behind `requireStaff()`.
- 23 pure tests, 22 database tests, 6 e2e specs. Suite is now 277 unit + 20 e2e.

**Decided:**
- **SVC-03's confirm gate is proven against a REAL appointment row**, inserted directly against the database (the same bypass-the-app pattern `constraint.test.ts` uses), rather than by constructing the error class. A-009 does not exist yet to create an appointment through the app, so this is the honest way to prove the gate actually fires — not just that the class has the right shape.
- **Both `setServiceActive` and `unqualifyProvider` share the same `DeactivationRequiresConfirm` gate**, scoped by an optional `providerId` on `countServiceFutureAppointments`. SVC-03 names both cases ("deactivating a service, or unassigning a provider") as one rule; giving them two separate mechanisms would have been two chances to get the count wrong.
- **The "any provider" assignment algorithm (fewest booked minutes, SVC-02) is deliberately not built here.** It needs real bookings to compute against, which don't exist before A-009 — the same reasoning A-025 already established for the impact preview (operator S-2).

**Found and fixed — the third occurrence of one bug class:**
- **CI's dual-timezone run failed again**, the same way as A-025: all 20 new database tests died in `beforeEach` on a foreign-key violation, because each DB test file was still clearing its own tables in a hand-maintained order. Root-caused this time rather than patched per-file: added `packages/db/testing/reset.ts`, one `TRUNCATE ... RESTART IDENTITY CASCADE` over every table, and every DB test file (including A-004's and A-005's) now calls it. CASCADE resolves the foreign-key order itself, so no test file has to know the graph.
- **The same pollution class showed up a THIRD time, in e2e.** `fullyParallel: true` let different spec files mutate the same global provider/service rows concurrently — A-025's provider spec and A-006's qualification spec both use "Dana" — producing strict-mode locator violations that had nothing to do with either feature. `fullyParallel: false` alone was not enough (it only serializes tests *within* one file; different files still ran across Playwright's worker pool). Fixed properly with `workers: 1` plus a shared `apps/web/e2e/fixtures.ts` that resets and reseeds the database in a `beforeEach` before every single test — replacing the one-time `globalSetup`, which only reset once for the whole suite and let state accumulate test over test. Every spec file now imports `test`/`expect` from `./fixtures`. As a side effect the suite got faster (52s → 12s): a small, freshly-reset dataset renders quicker than an ever-growing one.
- Two of the four e2e failures along the way were genuine test-authoring bugs, not pollution: a `getByText('Colour')` assertion matched the rejected service's own name *inside the error message it was checking*, and `li:has-text('Cut')` matched every card because "Cancellation **Cut**off" is a substring collision — fixed by scoping to an exact-text filter on the service-name element instead of a whole-subtree substring match.

**Left behind:**
- No `/staff/services/[id]` detail page — everything lives in one expandable card per service on the list page, which is enough for eight services and gets crowded well before eighty; A-016 era problem if it ever matters.
A-006 committed at 9c6022d


---

## A-007 — Availability model

**Built:**
- `packages/core/availability/windows.ts` — the precedence chain, pure and entirely on the CALENDAR axis. Windows are minutes-from-local-midnight integers (an overnight close of `02:00` is 1560, not 120), so the arithmetic is DST-agnostic by construction: "Dana works Tuesdays 9–5" is a rule about the wall clock and stays true whatever the offset does that week. Resolution to instants is one later step and belongs to `packages/core/time`.
- `toMinuteWindow` (AVAIL-01 validation), `unionWindows`, `intersectWindows` (AVAIL-04), `effectiveWindows` (AVAIL-02's override-replaces rule), `resolveAvailableWindows` (the whole wall-clock chain), `toWindowInput` (back to the shape `SlotQuery` wants).
- `packages/db/availability/` — `resolveDayWindows` (business ∩ provider for one day), `findAbsences` (instant-overlap predicate), and writes for weekly windows, date overrides, time off and ad-hoc blocks, each stamped with an actor.
- Migration `20260816010658_availability_audit_columns` — `createdByActor`/`actorRef` on `WeeklyWindow`, `DateOverride`, `TimeOff`, `AdHocBlock` (operator R-8).
- `apps/web/app/staff/availability` — business-level and per-provider hours, date overrides, time off/blocks, all behind `requireStaff()`.
- 39 pure tests, 22 database tests, 10 e2e specs. Suite is now 338 unit + 30 e2e.

**Decided:**
- **The pure module never touches instants, zones or Temporal.** Only the first two lines of AVAIL-03's chain (business override-or-weekly ∩ provider override-or-weekly) are wall-clock; everything below them — breaks aside — is on the physical axis and is the engine's job. That is why time off and ad-hoc blocks are returned as instant intervals here and subtracted by the engine, not folded into windows.
- **`resolveDayWindows` takes `weekday` as a parameter rather than deriving it from the day string.** Deriving it would mean parsing a date, which is exactly the axis crossing D-3 forbids this module from making. The caller already holds a zone.
- **`upsertDateOverride` replaces child windows wholesale.** An override replaces the pattern (AVAIL-02); a half-updated set of child windows would be a pattern nobody chose.
- **Nothing in the availability write path checks for appointments it strands** (D-2/AVAIL-03). Recording "Dana called in sick" must always succeed even with nine appointments booked; surfacing those nine is A-019's impact preview. There is an explicit test asserting time off over an existing appointment is ACCEPTED and the appointment is untouched — the absence of a refusal is the requirement, so it is tested as one.

**Verified, not assumed:**
- **Mutation-tested the precedence chain**, three deliberate bugs, all caught: intersection → union (6 failures — the business-holiday rule), override merging instead of replacing (1), and silently dropping a break that falls outside its window (1).

**Found and fixed — the fourth and final form of the isolation bug:**
- The shared e2e fixture added in A-006 **was not running for most spec files**. A bare `test.beforeEach()` at module scope in a shared module registers against whichever spec file imports it FIRST — Node caches the module, so the registration statement never runs again and every other file silently gets no reset. It failed in the least obvious way possible: every spec file passed when run alone, and the suite failed only when two files ran together, with data leaking between tests inside whichever file lost the race. Replaced with a proper Playwright **auto fixture** (`base.extend(..., { auto: true })`), which is per-test by construction in every file regardless of import order. Confirmed with two consecutive full-suite runs.
- Two more genuine locator bugs, found by reading Playwright's captured DOM rather than guessing: `getByText('Time off')` matched four elements (heading, explanatory paragraph, `<option>`, and the row), and the earlier `main > ul > li` count assertion was masking the real leak rather than measuring anything.

**Left behind:**
- The availability UI takes time off as offset-bearing ISO text (D-4 forbids a `{date, time}` payload). Correct but unfriendly; a proper picker that composes an instant belongs with the day grid (A-016), which is the first surface where staff enter times routinely.
- `daysWithAvailability` and the busy-set query that feeds `SlotQuery` are A-026, as sequenced.
A-007 committed at 7dce285


---

## A-026 — Availability → SlotQuery adapter

**Built:**
- `packages/db/scheduling/busy-set.ts` — `findBusyAppointments`, raw SQL because neither `tstzrange`, `&&` nor `COALESCE` over a range type is expressible through Prisma. Status filter derived from `ACTIVE_STATUSES`, the same module the exclusion constraint's predicate comes from (D-15).
- `packages/db/scheduling/slot-query.ts` — `buildSlotQuery` (business policy + zone, per-provider service overrides, A-007's resolved windows, the busy set), `computeDaySlots`, and `daysWithAvailability` (SLOT-07).
- `packages/core/time` — added `weekdayOf`, because deriving a weekday means parsing a date and every call site that does it independently is another chance to parse through the process timezone (D-3).
- 19 database tests. Suite is now 364 unit + 30 e2e.

**Decided:**
- **`audience` defaults to `'public'`, the SAFE value.** It controls two things: the D-21 horizon cap and whether `explain` is set. A route that forgets to pass it gets the restricted treatment — the direction a mistake should fail in, since `explain` leaking `overlaps-booking` to an anonymous visitor tells them exactly when the provider is with a client (spec §1.3). Enforced here *as well as* at the route, because "enforced at the route" is one forgotten line away from a leak.
- **An unqualified provider is an explicit refusal, not an empty result.** SVC-02 says such a provider never appears in that service's flow; a caller asking for an impossible pair has a bug, and returning "no slots" would hide it. A deactivated provider or service *does* return empty, because that is a real, temporary state rather than a programming error.
- **`daysWithAvailability` runs the same pure engine, once per day, rather than a cheaper approximation.** A date picker computed a different way is a date picker that greys out a day the booking page will sell, or offers one it then refuses. It walks days with `addDays` on the calendar axis, never by adding 86_400_000 ms, and carries a 400-iteration guard so an inverted range cannot spin.
- **The busy-set query range is widened by the service's own buffers and a day either side.** A candidate's blocked range extends past the window on both sides, so a booking sitting just outside the window can still collide with the first or last candidate; querying only the window would miss it.

**Verified, not assumed:**
- **Mutation-tested the two ways this query is silently wrong**, both caught: dropping the `COALESCE` so an override's zero-width range blocks nothing (the D-16 hole — 1 failure), and hand-typing a status list that forgets `no_show`/`completed` (1 failure).
- The D-16 test asserts the fixture *itself* first — that the row's own blocked range really is empty and `overriddenFromRange` really is set — so it cannot pass because the fixture was written wrong.

**Left behind:**
- **`running-late` BusyIntervals are not produced yet.** The engine vocabulary exists (D-22, added at the M1 boundary) but the per-provider-per-day delta has no storage until A-018, so there is nothing for the adapter to read. The shape is ready; the row is not.
- No caching. `daysWithAvailability` over a 90-day horizon runs the engine 90 times, each with its own queries. Correct and fast enough for a 4-chair salon; the obvious fix when it matters is one busy-set query for the whole range rather than one per day.
A-026 committed at 59ee9b7


---

## A-009 — The booking write path

**Built:**
- `packages/db/booking/book.ts` — `bookAppointment`, STAFF-shaped from day one (operator S-3): nullable client, injected actor, `isOverride` + reason, no horizon cap, with self-serve as the restricted caller passing `audience: 'public'`.
- `packages/db/booking/errors.ts` — `SlotTaken` (409 with refreshed alternatives), `SlotNotOffered`, `BookingRejected`.
- Writes: appointment + snapshotted service line (D-18) + `AppointmentEvent` + confirmation enqueued through the outbox *inside the same transaction* (BOOK-06/D-14), with a manage-link placeholder until A-013.
- `races.test.ts` — 15 tests: the spec's eight interleavings, the operator's ninth, plus three the mutation testing forced me to add. The nightly SQL-invariant fuzz (50 concurrent bookings, asserting zero overlapping pairs) runs under `FUZZ=1`.
- Suite is now 379 unit + 30 e2e.

**Decided — D-24, the advisory lock:**
- The write path takes a transaction-scoped advisory lock on `(providerId, businessDay)` before re-running the engine. **Not** the correctness mechanism for overlap — the D-2 constraint remains that. It closes the one gap the constraint deliberately does not cover: a staff override stores a zero-width range, so the constraint does not defend overridden time and only the in-transaction re-check does. Two concurrent transactions would otherwise both pass and both commit (operator R-9).
- **Consequence:** the spec's scripted "A reads, B reads, B commits, A writes → 23P01" interleaving is no longer reachable through the write path. The loser now re-runs the engine after the winner commits and finds the time occupied. An occupied slot maps to the same `SlotTaken` → 409 as a constraint violation, so the caller cannot tell which defence fired.

**Two real bugs the mutation testing found — and it found them by NOT failing:**
- **The advisory lock keyed on `floor(epochMs / 86_400_000)` — a UTC day bucket, not a business day.** In America/Chicago an 18:45 and a 19:15 booking on the same evening straddle UTC midnight, land in different buckets, and were never serialized against each other — precisely the case the lock exists for. An axis crossing (D-3) hiding inside a lock key. Test 1e pins it.
- **`bookAppointment` read the system clock.** The engine already refuses to (CLAUDE.md); a write path that reads it instead is the same defect one layer out, and cannot be tested against a fixed booking date without waiting for that date. `now` is now an injected parameter.

**On the mutation testing itself:**
Three mutations initially SURVIVED — removing the 23P01 mapping, removing the lock, and breaking the lock key. That meant those behaviours were asserted nowhere. Fixing it required understanding *why* each was unreachable:
- The 23P01 mapping is unreachable through the normal path *because* the lock works, so it needed an explicit, deliberately-ugly `__unsafeSkipSerialization` seam. Untested defence-in-depth is just an untested branch.
- The lock is invisible for ordinary bookings *because* the constraint already guarantees exactly-one. Its value is only visible in the override race, so test 1f scripts that by holding the very lock the write path takes, from a separate session, forcing the ordering rather than sampling it.
All three mutations are now caught, verified over repeated runs.

**Left behind:**
- The manage link is a placeholder string until A-013 mints real scoped tokens.
- One service line per appointment; VISIT-01's multi-service composition is A-028.
- The busy-set query window is ±24h around the day, so an appointment longer than ~24 hours would be missed by the engine (the constraint would still refuse it). Not reachable with any seeded service; worth widening when segmented durations land.
A-009 committed at a3ebf4c


---

## A-028 — Multi-service visits (VISIT-01)

**Built:**
- `packages/core/scheduling/visit.ts` — `composeVisit`, pure. Duration is the SUM of the lines; `bufferBefore` comes from the FIRST line and `bufferAfter` from the LAST. Inner buffers do not stack.
- `packages/db/scheduling/slot-query.ts` and `packages/db/booking/book.ts` now take `serviceIds: readonly string[]` and compose the visit before handing the engine a single service.
- One ordered `AppointmentServiceLine` per service, each snapshotting its own `priceCents`/`durationMinutes` (D-18).
- 9 pure composition tests + 7 database tests. Suite is now 395 unit + 30 e2e.

**Decided:**
- **Buffers do not stack between lines, and that is the whole item.** A buffer protects the gap between two *clients* — tidying the chair, washing the bowl. Inside one visit the client never leaves, so the colour's "10 minutes before" is time the stylist is already standing with her. Stacking would silently add 25 minutes of dead time to every cut+colour and the salon would wonder why its book stopped fitting. Consequence: the engine needed **no change** — a composed visit is just a longer service with one buffer at each end.
- **`serviceIds` replaced `serviceId` outright** rather than sitting alongside it as an optional `additionalServiceIds`. Two ways to say the same thing is exactly the dead flexibility that rots; `AppointmentServiceLine` has been plural-shaped since A-003 (D-12) for the same reason. The compiler listed every call site, which is what a canonical shape change should do.
- **Caller order is preserved through both the adapter and the write path.** A `findMany` returns database order, which would silently reorder the client's appointment — and since buffers come from the ends, "cut then colour" and "colour then cut" are genuinely different blocked ranges. There is a test for exactly that.

**Verified, not assumed:**
- Mutation-tested the composition rule, both caught: stacking the inner buffers (5 failures) and taking the buffers from the wrong ends (5 failures).

**Open — an unexplained single test failure:**
- During the first dual-timezone run after this item, `TZ=Pacific/Kiritimati` reported **1 failed / 394 passed** while `TZ=UTC` passed cleanly. I could not reproduce it: 18 subsequent full runs (10 Kiritimati-only, plus 5 UTC-then-Kiritimati pairs replicating the exact original sequence) were all clean, and the failing test name was not captured before the output rolled.
- **This is recorded rather than dismissed.** This project's own rule is that a flaky test is a broken test, not a retry candidate. The most likely candidates are the new concurrency tests — 1f holds a session-level advisory lock while another transaction blocks on it, and 8b races two identical idempotency keys — but that is a hypothesis, not a diagnosis, and I am not claiming a fix I did not make.
- **If it recurs, capture the test name first**: `npm test 2>&1 | tee /tmp/run.log` and read `/tmp/run.log`, rather than re-running and losing the evidence.
A-028 committed at 47097d0


---

## A-011 — The density seed

**Built:**
- `packages/db/settings/density-seed.ts` — appointments on top of A-025's setup seed, booked through the REAL write path (`bookAppointment`), not raw inserts. Slower, and worth it: every seeded appointment is one a user could actually have made, and the seed doubles as an integration test of the booking path, the engine, the availability chain and the constraint agreeing.
- `packages/db/seed.ts` + `db:seed:test` / `db:seed:dev`; `db:reset:test` now reseeds, so a reset produces a realistic book rather than an empty schema.
- Output: **225 appointments, 8 clients**, 8 on spring-forward and 6 on fall-back.
- 13 tests asserting the seed's *properties*, not that it ran.

**Decided:**
- **Anchored to fixed date constants, never `now`** (CLAUDE.md). A seed anchored to the current date makes the DST fixtures exist in March and vanish in July with nothing failing.
- **The seed opens the two DST days explicitly.** Both are SUNDAYS and the setup seed opens Tue–Sat — so without a `DateOverride` the two days the entire project exists for would contain zero appointments, and no test would go red to say so. This is the exact silent failure the fixed-anchor rule is about, one level deeper, and it now has its own test.
- **A client with a shared phone number** (D-17's household case) and one with 3 no-shows (CLIENT-04's threshold) are seeded deliberately, because both are cases the UI must render and neither appears by accident.

**Three real bugs found while writing the tests:**
- **Service picking ignored qualification.** The seed picked any service for any provider, but the setup seed deliberately leaves the junior stylist unqualified for colour work (SVC-02) — so the seed threw. Now picks from the provider's own qualified set.
- **"Fraction of the slot count" is not "fraction of the day".** Slots overlap at the grid interval, so an 8-hour day offering 29 sixty-minute starts holds about 7 appointments. Sizing the target off `slots.length` filled every column solid — destroying the one thing the seed exists for, which is that the columns look *different*. Now sized off actual capacity.
- **A `findMany` with no `orderBy` broke determinism.** Postgres returned qualifications in whatever order it liked, so the seeded PRNG indexed into a differently-ordered list each run. A seeded generator is only reproducible if everything it indexes into is itself ordered.

**And one bug in my own test, worth recording:**
- The determinism test compared **provider ids** — cuids, regenerated by every reset. It was asserting that the database's id generator is deterministic, which it never can be. Diagnosed by diffing the two runs rather than guessing: the row *sets* were identical and only the ids differed, so the seed was correct all along. Now compares provider **name**.

**Left behind:**
- The seed takes ~4 seconds because every appointment goes through a real transaction with an advisory lock. Fine for a seed; it is why the tests share one seeding rather than reseeding per test.
- **The unexplained single failure recorded under A-028 did not recur** across the many full runs this item required. Still unexplained, still recorded there.
A-011 committed at 1596d7a

---

## A-010 — Customer booking flow UI

**Built:**
- `apps/web/app/book/page.tsx` + `booking-flow.tsx` — five screens (service → who → day → time → details), two required text inputs, no page reloads.
- `apps/web/lib/booking/public-actions.ts` — the public server actions, every one calling the engine with `audience: 'public'` so the booking horizon applies and `explain` is withheld.
- `apps/web/e2e/booking.spec.ts` — 7 specs: end-to-end booking verified in the database, the five-screen/two-input contract, keyboard-only time selection, the live region, a D-10 lexicon assertion, axe on all five screens, and server-side validation with the browser's `required` stripped off.

**Decided:**
- **The browser never handles a date.** `listDaysWithOpenings` computes the window from *today in the salon's zone* and returns each day with its label already formatted (`{ day, label }`). The first draft had the client deriving weekday names with Zeller's congruence — correct arithmetic, wrong place: a hand-rolled calendar in a client component is the axis crossing of D-3 waiting to be rewritten by hand, and the one conversion module already does it. The visitor's "today" is also not the salon's, so a customer in Auckland would otherwise be offered a day the salon has not reached.
- **No pre-loaded days on the server.** Days depend on service *and* provider, neither known at page load, so pre-computing them was a slot grid nobody asked for.
- **`confirmAppointment` takes the calendar day explicitly** rather than slicing it off the instant. `at` is UTC, so a 23:00 Chicago appointment carries *tomorrow's* UTC date and the "here are other times" fallback would list the wrong day. Caught before it shipped, and the parameter carries the reasoning in a comment.
- **A match on phone alone does not reuse a client.** The name must match too (D-17): a household shares a number, and a mother booking for her daughter would otherwise silently inherit the mother's record, her notes and her no-show count.

**The bug the production build caught, which a dev server never would:**
- `/book` had no dynamic input, so Next prerendered it **at build time** and shipped the service catalogue as static HTML. All seven specs failed on an empty service list against a database that plainly had one — the page had been built before the row existed. In production this means a salon adding a service never sees it appear, and one retiring a service keeps selling it until the next deploy. Fixed with `export const dynamic = 'force-dynamic'`. This is precisely the defect class the "e2e runs against a production build" convention exists to expose; the dev server renders every request and would have stayed green.

**Also fixed:**
- The live-region text was written from a `useEffect`. It is a pure function of state, so it is now derived during render — an effect would only have been a second copy that can disagree. (Lint caught it; the lint was right.)
- `readableDay` was briefly exported from a `'use server'` module, where every export must be an async function.

**Left behind:**
- "Anyone available" is not offered yet — the customer picks a named provider. The action layer is already plural-shaped for it.
- The confirmation screen promises a manage link that A-013's tokens have not built yet.
- Multi-service visits compose in `packages/core` (A-028) but the customer flow still books one service; the actions take `serviceIds` arrays throughout, so the UI is the only thing missing.
A-010 committed at 32409f8

---

## Demo checkpoint 1 — walked at the Milestone 2 boundary

Full transcript and findings: `docs/reviews/06-demo-checkpoint-1.md`. Walked 2026-08-16, scripted rather than clicked so the record is transcript rather than recollection. Four of five narrated steps passed on the first walk.

**The defect it found — every outbox row orphaned from its appointment.**
- `NotificationOutbox.appointmentId` was never written. 228 seeded rows, all `NULL`. The column, its index and its `onDelete: Restrict` were added at the M1 boundary on the operator's recommendation (R-4) so A-027 can answer "was she actually told?" in one indexed lookup — and nothing ever populated them.
- **Three items touched it and each was correct in isolation.** A-003 added the column and index. A-004 built a correct `enqueueNotification` whose `EnqueueInput` simply had no such field. A-009 enqueued the confirmation inside the booking transaction, passing the appointment id **in the payload JSON** — which looks identical in a passing test and is unusable as a lookup.
- **A-009 had no test of its outbox enqueue at all.** Its tests are the race tests, which assert appointment rows. A-004's tests exercise enqueue thoroughly, but enqueue was never asked to store an appointment id. The missing assertion belonged to neither item; it belonged to the seam. That is the exact failure class rental's checkpoint predicted (D-28).
- Fixed by adding `appointmentId` to `EnqueueInput` and passing it from `book.ts`. `packages/db/booking/confirmation.test.ts` is the regression suite; reverting the one-line fix fails 5 of its 6 tests.

**A bad test, found in the fix written for the finding.** The regression suite originally asserted "refuses to delete an announced appointment". It passed — and passed with the fix reverted, because `AppointmentEvent`'s own `onDelete: Restrict` blocks the delete first and the event log is append-only by trigger, so the outbox's restrict can never be observed alone. A true assertion that cannot fail for its stated reason reads like coverage and isn't. Removed, with a note in the file so it does not get helpfully re-added.

**A stale example in the checkpoint's own prose, deliberately not "fixed".** The backlog narrates "11:15 first after the 10:00 booking"; the engine offers 11:00 and is right — the seeded Cut is 45 minutes with a 10-minute after-buffer, so the 10:00 blocks 10:00–10:55. `11:15` is the answer for the 60-minute/15-minute service used in `races.test.ts`, which is what the prose predates. Recorded rather than changed in either direction.

**The A-028 flake, now half-diagnosed and honestly still open.**
- It recurred once during this item's gate, under `TZ=Pacific/Kiritimati`, and this time the test name was captured: `races.test.ts` **1d** — "a constraint violation through the write path maps to SlotTaken, not a 500". The rejection was a raw `PrismaClientUnknownRequestError` instead of `SlotTaken`.
- **It is not timezone-related.** 6 runs of the file alone and 17 full suites — 23 consecutive clean runs — did not reproduce it. Both observed occurrences were simply the second suite run of a gate, i.e. under load.
- **No fix has been applied, because the cause is still unknown.** The plausible story is that 1d deliberately disables D-24's advisory lock, so its two lock-free writers can deadlock and Postgres raises `40P01` where the test expects `23P01` — which `book.ts` does not map. That is a hypothesis, and asserting it as a cause is precisely the mistake CLAUDE.md warns about.
- **What was done instead:** a permanent diagnostic in 1d printing the error code, meta and message on the failing path only. Every contention failure Postgres can raise there arrives as the same error class, so the previous assertion could only ever report "not SlotTaken" — which is why two investigations produced no diagnosis. The next occurrence will produce one.
- Production is not exposed by the hypothesised path: the real booking path always takes the advisory lock, and `__unsafeSkipSerialization` is a test-only seam. The lock-free path 1d defends is what A-018/A-019's deferred multi-row moves will use, which is where mapping contention errors will need deciding on evidence.
Demo checkpoint 1 committed at 8a6c6c4

---

## A-012 — Appointment state machine

**Built:**
- `packages/core/scheduling/transitions.ts` — the §7 table as data, and `canTransition(from, to, context)` as the one decision point. Pure; the engine's companion module `status.ts` owns the status SETS, this one owns the EDGES.
- `packages/db/appointments/transition.ts` — `transitionAppointment`: resolves the cutoff from real rows, applies the decision, writes the actual timestamps, appends the event. One transaction.
- 103 pure tests + 18 integration tests + 2 new drift guards. 536 unit tests total, identical under both timezones.

**Decided:**
- **The test transcribes the PRD, it does not read the implementation.** The §7 grid in `transitions.test.ts` is written out as a text table so it diffs by eye against `00-master-prd.md` §7. A parameterised test that walks the implementation's own structure proves only that the structure is self-consistent — it would have happily confirmed a wrong table. All 64 ordered pairs are asserted, including the diagonal and including `booked` as a destination.
- **The system actor is powerless, on purpose.** No automatic transition exists in v1: nothing marks an appointment `no_show` because the clock passed it, because a stylist running forty minutes late would watch the book cancel her afternoon. A test asserts this so adding an automatic transition has to be a decision.
- **A customer inside the cutoff is reclassified, not blocked.** `cancelled` is refused and `cancelled_late` is allowed (APPT-05). Refusing outright just produces a no-show instead, which is strictly worse for the salon and loses the data the `cancelled_late` split exists to capture.
- **The cutoff boundary resolves toward the salon.** Exactly on the cutoff counts as inside — recoverable by a phone call, where the reverse silently loses a chargeable slot. Decided once, in one function, with the reasoning at the call site.
- **The write is conditional on the status it was decided against** (`UPDATE ... WHERE id = ? AND status = ?`). Under `READ COMMITTED` two front-desk taps can both read `booked` and both write, producing one status and two events that disagree. Same reflex as the exclusion constraint: never check-then-write as the mechanism.
- **A correction may clear timestamps but never stamp them.** Correcting to `no_show` clears the arrival times, because a client who never arrived cannot have a check-in time, and the prior values move into the event payload. Correcting the other way sets nothing: the correction happens up to seven days later, so writing `now` as `endedAt` would be a fabricated measurement that a utilization report would then average in.
- **`status_corrected` is a distinct event type** from `status_changed`. "We got this wrong" is a different fact from "this happened", and A-027 renders them differently.

**A bug caught in my own code before it shipped:** `timestampsFor` set `endedAt: now` for any transition to `completed` — including the APPT-06 correction, which is exactly the fabricated measurement the comment three lines above it forbade. Fixed by passing the correction flag in.

**Structural guards added (the "a status enum is never one edit" rule):**
- The live Postgres `AppointmentStatus` enum is asserted equal to `APPOINTMENT_STATUSES`. The existing guard proved the *constraint* agreed with the module; nothing proved the *enum* did, so a ninth status added to `schema.prisma` alone would have left every derived list ignorant of a value rows can hold.
- The transcribed §7 grid is asserted to have a row and column for every status, so a new state fails with "row X is missing columns" rather than an unreadable `.includes` error.

**Verified by mutation (5 of 5 caught):** opening a closed cell, dropping the after-start precondition on `no_show`, widening the seven-day boundary by one tick, letting a customer perform terminal corrections, and flipping the cutoff boundary to strictly-after.

**Left behind:**
- No UI. A-016's day grid and A-027's detail panel are the surfaces; wiring buttons here would be speculative.
- `transitionAppointment` opens its own transaction, so it cannot yet be composed inside a caller's. A-014's reschedule is a same-row UPDATE and does not need it; A-018's multi-row column push will, and that is where the seam gets opened deliberately.
A-012 committed at 5894d2b

---

## A-013 — Manage token

**Built:**
- `packages/core/auth/manage-token.ts` — mint / hash / expiry. Pure, and the third credential in that folder alongside the staff password and the staff session.
- `packages/db/appointments/manage-token.ts` — `issueManageToken` (revokes on reissue), `verifyManageToken`, `repointManageTokens`, `revokeManageTokens`.
- `packages/db/rate-limit.ts` + `RateLimitCounter` table — one-statement atomic counter, first DB-backed limiter in the repo.
- `apps/web/lib/manage/token-gate.ts` — the gate both the page and the cancel action come through.
- `apps/web/app/manage/[token]/` — the customer's page, and cancel.
- `apps/web/lib/customer-format.ts` — D-10's "one formatter for customer-facing times", moved out of `public-actions.ts` where a second copy was about to be written.
- A-009's `MANAGE_LINK_PLACEHOLDER` is gone: the booking write path mints the real token inside its transaction.
- 7 pure + 21 integration tests (+2 on the booking seam), 6 e2e. 564 unit tests total, identical under both timezones.

**Decided:**
- **The token is a LOOKUP value, not a signed one.** The staff session is an HMAC-signed payload anyone holding it can read; that shape is unusable here, because the URL is a customer surface and D-10 forbids an internal identifier reaching one. 256 random bits carry nothing and are looked up by hash.
- **sha256, not scrypt.** scrypt's cost exists to make a *guessable* secret expensive to guess. A CSPRNG token is not guessable, so the cost would buy nothing and would be paid on every tap of a link from an SMS. The hash is there so a database dump is not a folder of live links.
- **Every failure is one outcome.** Unknown, revoked and expired all return `null` from `verifyManageToken` and produce the same sentence — TOKEN-02's non-enumerating message. A differentiated error is the oracle a random token exists to deny.
- **Exactly ON the expiry is dead.** An expiry is the first instant the link stops working; "one millisecond later" is a boundary nobody can state in a sentence.
- **The grace is a physical 24 hours, not "tomorrow at the same time".** Tested across both DST transitions: 24 physical hours after a Saturday 16:00 appointment lands at 17:00 on the wall after spring-forward and 15:00 after fall-back. A calendar-day implementation passes every month except two.
- **`repointManageTokens` ships here, not in A-014.** Reschedule owns the *move*; this module owns `end + 24h`. Writing that arithmetic a second time in A-014 is how two surfaces come to disagree about when a link dies.
- **The rate limiter is a database table, not an in-process Map.** The deploy target is serverless: every instance would hold its own Map, so the enforced limit would be N x the configured one with N set by autoscaling. A counter that lies about the number it enforces is worse than none, because it is trusted.
- **The limiter is one statement** (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`), no transaction and no lock. Read-then-write under `READ COMMITTED` lets two requests both read 9 and both write 10 — the same check-then-write reflex the exclusion constraint exists to avoid. A concurrency test asserts 12 concurrent calls lose no count.
- **The limiter is in the GATE, not on the page**, so the limit the page enforces cannot be walked around by posting the cancel action directly. It is consumed *before* the token is looked up, so a guessing loop pays for its guesses.
- **Cancel ships here.** A-014 owns reschedule and A-021 owns confirm; no row owned cancel, and a token that grants nothing cannot be tested for scope. It is ~15 lines on top of A-012's state machine.
- **The cancel path never computes a cutoff.** It asks for `cancelled`, and A-012's own refusal (`inside-cancellation-cutoff`) is what selects `cancelled_late`. A second cutoff calculation on a customer surface is precisely the duplicated status logic the transitions module exists to prevent.
- **The status→copy map is a total `Record<AppointmentStatus, string>`**, so a ninth state is a compile error rather than a blank line on a customer's screen. `cancelled` and `cancelled_late` deliberately read the same: the split is the salon's revenue record, not a label for the person who cancelled.
- **The cancel form carries the TOKEN back, not an appointment id** — so there is no internal identifier in the markup at all, and the form holds no authority of its own.
- **`Referrer-Policy: no-referrer` on `/manage/*`, and `noindex`.** The link's authority is its URL, so the URL must not travel in a `Referer` header or sit in a search index.

**A flaw caught in my own test before the sweep finished:** the cancel spec asserted the action's success sentence, which lives inside the form that `revalidatePath` unmounts — a race against a re-render that would have been a "flaky test" later. It now asserts the re-rendered page state instead, which is the real feedback a customer sees.

**Left behind:**
- Confirm and reschedule are not wired to the token yet — A-021 and A-014 own them, and both come through `openManageLink` when they land.
- The limiter's window is fixed, not sliding: a caller can spend the budget either side of a boundary, up to 2x the limit. Marked `ponytail:` with the upgrade path. Irrelevant against bulk PII retrieval, which is what it defends.
- The caller key is the first hop of `x-forwarded-for`; behind a proxy that does not set it, everyone shares one bucket. Vercel always sets it, so the ceiling bites only in local dev.
- `authenticateStaff`'s `ponytail:` note asked for exactly this machinery so staff login could use it too. Not wired — one shared credential with a ~100ms scrypt cost is not the surface under threat, and doing it unasked is A-013 building A-005's item.
A-013 committed at 7cec2c9

---

## A-014 — Reschedule

**Built:**
- `packages/core/scheduling/transitions.ts` — `canReschedule(from, context)`, a second small table beside §7, sharing its clause machinery.
- `packages/db/appointments/reschedule.ts` — `rescheduleAppointment`: one transaction, one same-row `UPDATE`, engine re-run inside, both-sides event, token re-pointed, outbox row. Plus `rescheduleOptions`, the read the customer's screen uses.
- `packages/db/scheduling/busy-set.ts` — `excludeAppointmentId`, threaded through `buildSlotQuery`/`daysWithAvailability`.
- `apps/web/app/manage/[token]/reschedule-form.tsx` + three server actions — the customer half of demo checkpoint 2.
- Race interleaving **6** from spec §4.5, which nothing could test until today.
- 29 pure + 25 integration + 1 race + 1 e2e. 619 unit tests total.

**Decided:**
- **The engine must not see the appointment it is moving.** The exclusion constraint compares the updated row against *other* rows, so a 09:00→09:30 move does not false-conflict — but the engine, re-run in the same transaction, sees the row at its old time and refuses its own destination as `overlaps-booking`. Without `excludeAppointmentId` an appointment could never move within its own duration of where it is, which is the most common reschedule there is. The spec's §4.6 sample glosses over this; the test that catches it is the one that fails when the flag is removed.
- **The write is conditional on the time it was decided against** (`WHERE id = ? AND startAt = ?`). Same reflex as A-012's status-conditional update: two front-desk taps moving one appointment to two different times would otherwise both pass their engine re-checks and both write, leaving one start time and two events that disagree. `AppointmentAlreadyMoved` is distinct from `SlotTaken` — the destination may be free; it is the *source* that changed.
- **One advisory lock, on the DESTINATION provider-day.** The source day needs none: freeing time can never create a conflict. And because a move stays within one provider, there is exactly one lock — which is why spec §4.6's canonical-lock-ordering warning does not apply here. Cross-provider reassignment (A-019) is where that has to be paid for.
- **The appointment keeps the duration it was booked with** (D-18's snapshot), not the catalogue's current one. A reschedule moves an appointment; it does not re-sell it. A service shortened last week must not silently shorten an appointment somebody already agreed to.
- **`rescheduleOptions` exists so the screen and the write path ask the identical question.** Both go through one function with the same exclusion and the same snapshotted duration — two callers assembling that separately is how a UI comes to offer a time the server then refuses.
- **The reschedule affordance is asked of `canReschedule` with the real actor and cutoff**, not approximated from the status. A form shown thirty minutes before an appointment that then answers "call us" is worse than saying so up front.
- **A reschedule is not a status change.** No `status_changed` event, no status write, and a test asserts both — modelling it as a transition is what makes it look like a cancel-and-rebook.
- **The customer is told.** An `appointment.rescheduled` outbox row keyed on the destination instant: two moves are two messages, a retry is one. Not in the backlog row, added because a move nobody is told about is the silent change Goal 2 forbids.
- **Provider change, service change and overriding are all deliberately absent**, each with the row that owns it named in the file header.

**Verified by mutation (4 of 4 caught):** dropping the busy-set exclusion, dropping the conditional write, never re-pointing the token, and using the live duration instead of the snapshot. Each was caught by exactly one test.

**Left behind:**
- Staff have no reschedule surface yet — A-016's grid and A-027's detail panel are where it belongs, and the write path is already staff-shaped.
- The customer's DAY list uses the live service duration (via `daysWithAvailability`) while the TIME list uses the snapshot. They differ only if the catalogue changed since booking, and only in whether a day appears at all; the times a customer can actually pick are always the snapshot's.
- `SlotTaken` from a reschedule carries no alternatives. Unlike a first booking the customer still has her appointment, so the honest answer is "that time went, yours is unchanged" — a list of alternatives here would invite a second attempt at the exact moment the first failed.
A-014 committed at 27208cd

---

## A-015 — Client record

**Built:**
- `packages/core/clients/` — `normalizePhone`/`isPlausiblePhone` (moved out of the booking flow before a second copy was written) and `naturalIntervalDays`.
- `packages/core/time/zone.ts` — `daysBetween`, the calendar-axis inverse of `addDays`.
- `packages/db/clients/clients.ts` — lookup, search, history, pinned note, `mergeClients`, `rebookSuggestion`.
- Migration: `Client.mergedIntoClientId`/`mergedAt` — R-10's tombstone.
- `/staff/clients` and `/staff/clients/[id]` — search, pinned note, history, merge panel, rebook.
- Booking flow accepts a server-resolved prefill, so "rebook last visit" opens on the day list.
- 10 pure + 32 integration + 7 e2e. 661 unit tests total.

**Decided:**
- **Every lookup returns a LIST, and nothing in the module ever decides two records are the same person.** D-17 is the reason: a household shares a number, and collapsing a mother and daughter merges an allergy note with a no-show counter. The code only carries out a decision a human made.
- **The losing record survives a merge as a tombstone.** Deleting it makes the old number unknown to the salon at exactly the moment it is needed — six weeks later, when she rings from it. Deleting is impossible anyway: `AppointmentEvent` is append-only with `Restrict` FKs.
- **Merge chains are FLATTENED, not followed.** Merging B into C re-points every tombstone already aimed at B, so resolution is one hop forever — no recursive query, no cycle, and no depth guard to get wrong.
- **Notes are concatenated, never replaced.** The one failure here that hurts somebody is a merge that silently drops "allergic to PPD" because the survivor already had a note. Contact details fill gaps only: overwriting the survivor's phone with the loser's would undo the decision staff just made.
- **`clientHistory` includes no-shows and late cancels.** Hiding them makes the front desk look unprepared, and it is the same data A-020's counter reads — two sources would eventually disagree about one appointment.
- **The rebook interval is her own rhythm**, read from the gap between her last two kept visits, on the calendar axis. Six weeks is six weeks whatever the clocks did in between; the millisecond version floors to 41 days every spring. Default 28 days when there is no rhythm to read — short, so the front desk scrolls forward to correct it, which is the cheaper direction to be wrong in.
- **The prefill is resolved server-side and handed over whole**, and every failure (retired service, departed stylist, hand-edited URL) falls back to the normal flow rather than erroring a public page.
- **The staff client page deliberately does NOT follow D-10's lexicon.** It shows the real status, because "no-show" is the word the front desk and the reports use; D-10 governs customer surfaces.

**A vacuous test of my own, caught by mutation:** "ignores cancelled appointments" put the cancelled visit EARLIER than the kept one, so `ORDER BY startAt DESC` picked the right answer regardless — it passed with the status filter deleted. Rewritten with the cancelled visit as the most recent, where it actually bites.

**Verified by mutation (4 of 4 caught, after the fix above):** replacing notes instead of concatenating, dropping the chain flattening, overwriting the survivor's contact details, and counting cancelled visits as the last visit.

**Left behind:**
- No standalone "create client" screen. The booking flow creates them, and A-017's staff booking owns choose-or-create at the point it is actually needed.
- No merge audit beyond the tombstone itself (`mergedIntoClientId` + `mergedAt`). `AppointmentEvent` is appointment-scoped and there is no client-scoped log; adding one for a single event type would be scaffolding.
- "Rebook" lands in the CUSTOMER booking flow, so it is capped by the self-serve horizon and cannot override. A-017 replaces the destination; the suggestion it carries is already computed here.
- The soft "this client already has an appointment then" note (D-17) belongs on the staff booking surface, which is A-017.
A-015 committed at d100979

---

## A-016 — Staff day grid

**Built:**
- `packages/core/scheduling/spans.ts` — the engine's wall→instant window resolution, **extracted rather than copied**, plus `subtractSpans` for gaps.
- `packages/db/day/day-view.ts` — `loadDayView`: every provider's column for one business day.
- `apps/web/lib/day/view-model.ts` — the server-side transform: every label and every offset computed in the salon's zone before anything reaches the browser.
- `/staff/day` — the grid, the single-stylist list view, day navigation, and a 15-second refresh.
- 10 pure + 20 integration + 10 e2e. 691 unit tests total.

**Decided:**
- **The axis crossing moved, it did not multiply.** `resolveEdge`/`resolveWindow`/`union` came out of the slot engine into a shared module and the engine now calls it. The grid has to place working hours on a physical timeline, which is the same crossing — and its rules (gap → the instant *after*, ambiguous open → earlier / close → later, union only *after* resolving) are subtle enough that a second implementation would be a second set of DST bugs. All 205 engine tests passed unchanged after the move, which is what makes it an extraction rather than a rewrite.
- **A pre-existing fork deleted on the way past.** `slot-query.ts` held a private copy of A-007's precedence-chain lookup alongside the public `resolveDayWindows`. Two answers to "what hours does this provider work today" is exactly the fork that lets the grid draw a window the engine will not sell from — and neither screen looks wrong on its own.
- **A gap is not a slot.** A slot is "somewhere this 45-minute service fits, on the grid, with buffers"; a gap is "nobody is in this chair between 2:15 and 3:00". The front desk is asked the second question all day and it has no service in it yet, so gaps are interval subtraction, not an engine call. Breaks are subtracted too — lunch is not bookable time.
- **The grid reads the D-16 range, not the blocked one**, so a staff override occupies its true span in the column even though its blocked range is zero-width (D-8). The database never lies and neither does the day view; that is what `overriddenFromRange` is stored for.
- **A cancellation frees its time AND stays on screen.** Both halves matter: the slot must be sellable again, and "she cancelled" is what the front desk needs when the client turns up anyway.
- **No `Date` in the client component.** Every time on screen is formatted server-side in the salon's zone; what crosses to the browser is minutes-from-the-top and text. A front desk laptop still set to a holiday timezone shows the same grid as the terminal beside it.
- **Refresh is `router.refresh()` every 15 seconds** — half the 30-second budget. It re-runs the *same* server component, so the refresh path and the first render are one code path; a client-side fetch-and-merge would be a second way of building the grid, and the two would drift.
- **The now-line comes from the server's clock**, not the browser's, and is hidden when the day being viewed is not today — a now-line on Thursday's page pointing at Tuesday's 2pm is a lie the eye believes.
- **Colour is never the only signal.** Status is in every chip's accessible name, cancellations are struck through as well as faded, and the status map is total over `AppointmentStatus` so a ninth state is a compile error rather than an invisible chip on a Saturday.
- **Keyboard operability is native.** Chips are real links in chronological DOM order rather than a custom roving-tabindex grid: Tab reaches everything, Enter opens the client record, and there is no key handling to get wrong. Arrow-key navigation is the upgrade path if the desk ever asks for it.

**A real accessibility defect, caught by axe before it shipped:** the gutter's hour labels and the gap text were `zinc-400`/`zinc-500` at 12px — 2.62:1 and 4.39:1 against their backgrounds, both under WCAG AA's 4.5:1. Small grey text is exactly where contrast quietly fails, and it looked fine. Darkened to `zinc-600`, with the measured numbers written next to the constant so the next person does not lighten it back.

**Scope narrowed, and the owner confirmed it:**
- The row says **"clickable gaps with lengths"**. Gaps render with their lengths and are *not* interactive. A-017 owns booking from the grid, so today a gap button would have nowhere to go, and a focusable element that does nothing when activated is worse than plain text. **Asked and answered 2026-08-17: leave it to A-017**, which now carries the note. Making them buttons is a two-line change in `day-grid.tsx`.

**Left behind:**
- No status controls on the chip — A-027's detail panel owns those, and A-018 owns check-in.
- The client chip carries phone and pinned note; the no-show **flags** the row also asks for are CLIENT-04, which A-020 builds.
- `loadDayView` runs one round of queries per provider concurrently (`ponytail:` noted). The roster is bounded by the chair count (D-20); batching by `providerId IN (...)` is the fix if that ever changes.
A-016 committed at ef24fe1

---

## A-017 — Staff booking & override

**Built:**
- `packages/db/booking/walk-in.ts` — `walkInOptions` (who can take her, soonest first) and `clientAlreadyBookedAround` (D-17's soft note).
- `apps/web/lib/booking/staff-actions.ts` — the UNRESTRICTED caller: nullable client, no horizon, no lead time, exclusion reasons visible, override available with a reason.
- `/staff/book` — one page, two entry modes (from a gap, or walk-in), sharing everything after the first choice.
- A-016's day-grid gaps are links now, carrying the INSTANT.
- D-25 recorded in `07-decisions.md`.
- 19 integration + 9 e2e. 710 unit tests total.

**Decided:**
- **D-25: the lead time is a self-serve rule.** D-11 introduced it to close one trap — a customer books five minutes out and is instantly inside the cancellation cutoff, unable to undo it without ringing. That trap cannot close on staff, who are not bound by the cutoff either (APPT-05). Applying it to them breaks BOOK-04's walk-in outright: with the seeded 120-minute lead time the front desk could not book the person standing in front of it, and every walk-in would have to be routed through a BOOK-05 override — which would make the override marker meaningless.
- **The refusal is a STEP, not a dead end** (D-8's hardest-won point). The engine's reasons are shown in the front desk's own words, with the override box beside them: "she already has a client then", not "outside-working-window".
- **One action for both paths.** An override is the same booking with a reason attached; a separate `overrideBooking` action would be a second write path to keep in step.
- **"Starting now" means AS SOON AS POSSIBLE**, not this exact minute. The engine's earliest offered slot is almost never `now` to the second, and booking off-grid would either mark an ordinary walk-in as an override or leave a sliver nobody can sell.
- **The walk-in returns a LIST.** "Priya at 2:15 or Dana at 3:00" is a choice made out loud with the client present; a function that picked would be overruled half the time.
- **A walk-in provider must be qualified for the WHOLE visit** (VISIT-01), not just the first service.
- **Service selection order is the visit order** — the buffers come from the ends, so "cut then colour" is a different appointment from "colour then cut".
- **D-17's clash note is computed at search time**, so it is visible while choosing rather than after booking — and it never blocks: one number can be a household, and even the same client twice is the salon's call.

**Two real defects the e2e specs caught, both mine:**
1. **A misnamed Prisma relation reached the browser as a 500.** `providers` instead of `serviceProviders`, inside a `...(x ? {…} : {})` spread — which widens the object and stops TypeScript checking the keys in it. Rewritten as a plain conditional so the compiler checks both branches. The lesson generalises: a conditional spread into a typed query object is a hole in the typechecker.
2. **"Book outside hours" was the one BOOK-05 case with no way past.** The engine explains CANDIDATES, and a time outside every working window is never a candidate — so it refused with an EMPTY reason list, and the panel gated the override on having reasons. The first case BOOK-05 names was a flat refusal, which is precisely what D-8 exists to prevent. The override is now offered on any engine refusal, with reasons as decoration rather than a gate.

**A third, in the spec itself:** it pinned A-016's fixed Tuesday, which is in the past — rendering a past day is fine, booking one is correctly refused as `in-the-past`. The spec now walks forward to the next Tuesday the seeded roster works.

**Left behind:**
- No "change the time" list on the booking page: it books the instant it was opened with. Picking a different time is what the day grid is for, and a second slot picker here would be a second answer to "when is she free?".
- Editing an existing appointment (status controls, notes) is A-027's detail panel.
- The client search creates a record with the typed text as BOTH name and phone when it looks like neither; `normalizePhone` drops non-digits, so a name-only entry simply gets a null phone. Good enough for the desk; A-020's flags surface will want a proper two-field create.
A-017 committed at 5616d8c

---

## A-018 — Check-in & running late

**Built:**
- Migration: `ProviderRunningLate` — one row per provider per business day, with actor and timestamp.
- `packages/db/day/running-late.ts` — set / clear / read, and `runningLateInterval`, which is how the engine sees it.
- `packages/db/day/push-column.ts` — `previewPush` and `pushColumn`, one transaction with `SET CONSTRAINTS appointment_no_overlap DEFERRED`.
- `slot-query.ts` feeds the delta to the engine as a `running-late` BusyInterval; the day view carries it; the grid shows "+40 min" and projected starts.
- 20 integration + 6 e2e. 730 unit tests total.

**Decided:**
- **The delta and the push are deliberately different mechanisms, and the tests can tell them apart.** The delta says "Dana is forty behind" and moves nothing; the push rewrites `startAt` and tells everybody. A test that could not distinguish them would let one quietly become the other — which is how the confirmation a client is holding ends up disagreeing with the book.
- **Zero clears rather than storing a zero.** "On time" is the absence of a claim; a stored zero renders as "+0 min", which reads as a system that thinks lateness is interesting when it is not.
- **The overrun runs from NOW, not from the appointment that caused it.** The claim being made is "the next forty minutes of this column are already spoken for" — which is exactly what a paper day-sheet conveys and software usually cannot. It needs no cleanup job: the interval simply stops covering anything once it is worked off.
- **Keyed on the business day**, so a delta cannot survive to tomorrow and nothing has to remember to clear it overnight.
- **Projected starts are shown BESIDE the scheduled time, never instead of it** — and only for appointments that have not started. She was booked for 14:00 and her confirmation still says so.
- **The push previews through the SAME function it executes with.** A separate "check" function is the one that eventually disagrees with the action.
- **A push that would put anything past closing is refused whole.** APPT-04's "refuses silently-lossy shifts": a column that half-moved is worse than one that did not, and the preview names the client who is stuck.
- **The deferral is scoped to that one transaction.** `SET CONSTRAINTS ... DEFERRED` is the only place in the codebase that asks for it; everywhere else the check stays immediate, so nothing else silently gains the same latitude.
- **The manage link follows a pushed appointment** rather than being reissued — she is holding the message it arrived in (TOKEN-02).
- **A 480-minute cap on the delta**, because the only way to type 400 is by accident and the delta would then hide the rest of the day from the booking page.

**Verified by mutation:** removing `SET CONSTRAINTS ... DEFERRED` breaks the back-to-back push (two tests). The deferral is load-bearing, not decoration.

**Two fixture mistakes of my own, both correct behaviour underneath:** a three-appointment push whose last item genuinely ended past closing (the refusal was right), and a spec that skipped `typecheck` between writing and running — the branded `Instant` type caught a bare number in the production build, which is exactly what it is for.

**Left behind:**
- Check-in and in-progress still have no buttons; A-012 built the transitions and A-027's detail panel is where the controls belong. The timestamps they write are already what the delta is *not* derived from (D-22).
- The push starts at the next appointment, not an arbitrary time the user picks. "From here" in a salon means "from the client who has not sat down yet", and a time picker would be a second way to say the same thing.
- Running EARLY is not modelled. Nobody is kept waiting by it.
A-018 committed at 6526fde

---

## A-019 — Availability-change impact workflow

**Built:**
- `packages/db/availability/impact.ts` — conflicts DERIVED four ways: absence overlap, hours edit, provider deactivation, and the day's combined view.
- `packages/db/availability/reassign.ts` — `reassignAppointment` / `reassignMany`, same-row provider change.
- `clearConflictAcknowledgments` wired into every absence write and delete.
- `/staff/conflicts` — the screen the front desk opens the morning somebody calls in sick.
- 23 integration + 8 e2e. 753 unit tests total.

**Decided:**
- **A conflict is DERIVED, never stored** (operator R-7). It is a fact about *other* rows — an absence, a changed window — and a stored `hasConflict` flag goes stale and lies on exactly the day this screen matters. The only thing stored is the human acknowledgment, because that is not derivable from anything.
- **The acknowledgment is cleared in `availability.ts`, not in the workflow.** Every path that writes or deletes an absence gets it for free and cannot forget it — and the import stays one-directional, since `impact.ts` already needs `resolveDayWindows` from there. (I built it the other way first and had a two-module import cycle; it worked, and I removed it anyway.)
- **Clearing is scoped to the overlapping range.** An afternoon absence must not wipe an acknowledgment somebody made about the morning.
- **Reassignment is a same-row UPDATE** (like D-6's reschedule): the appointment keeps its id, so the manage link still works and the history does not fork. Only the provider changes — the time does not, which is why the client may not need telling at all.
- **The exclusion constraint decides whether the new provider is free**, not a check in this module. A bulk reassign therefore cannot half-succeed into a double-book.
- **Each reassignment is its own transaction, on purpose.** The demo checkpoint's own words are "three reassigned to Priya, six kept-flagged" — an all-or-nothing bulk action that rolled back because of one awkward 2pm would make the front desk do all nine by hand.
- **The bulk result names what did NOT happen.** A message that only counted successes would leave six clients quietly unhandled, which is the failure mode this whole item exists to prevent.
- **"Where qualified" is enforced against the WHOLE visit** (SVC-02/VISIT-01), not just the first service.
- **The phone number is on every row**, as a `tel:` link. The resolution to most of these is a call, and a list you have to click nine times to use is a list the front desk copies onto paper.
- **Cancelling requires a reason**; keeping does not. Taking a client's appointment away is the one action here that needs a sentence somebody can read back to her on the phone.

**A duplicate-label problem the e2e caught:** three fields on the page were labelled "Why?" — the bulk reassign and the per-row keep and cancel. axe passes that, but a screen reader reads three identical fields. The bulk one is now "Why move them?".

**And the same re-render race as the cancel and reschedule surfaces:** after a successful bulk reassign there is nothing stranded, so the list — including the form holding the summary — is replaced by the empty state. The spec asserts the page's real feedback and the database, not a message that is racing its own re-render. Third time this pattern has appeared; it is worth remembering that in this app the PAGE is the confirmation.

**Verified by mutation (2 of 2 caught):** never clearing acknowledgments, and dropping the qualification check on reassignment.

**A flaky test from A-017, caught by this item's full sweep and fixed here.** The walk-in spec counted the offered times immediately after choosing a service — before the transition that loads them had settled — so an empty count meant "still looking", not "nobody is free". It passed on timing luck when A-017 shipped and failed today. It now waits for whichever terminal state arrives (`options.or(nobody)`) before branching. Worth stating plainly: that was a broken test, not a flaky one, and the repo's own rule about race tests applies to any test that races a request.

**Left behind:**
- "Offer a new time" links to the day view rather than opening a staff reschedule picker. `rescheduleAppointment` exists and is staff-callable (A-014), but its only surface today is the customer's manage link; a staff reschedule picker belongs with A-027's detail panel, where the rest of the per-appointment controls live.
- The cancellation goes through the state machine and the event log; the outbox notice for it is A-020/A-022's territory.
- `conflictsForDay` runs a query per provider per absence. Bounded by the chair count (D-20) and a day's absences; batching is the fix if a much larger roster ever appears.
A-019 committed at ab3fe60

---

## A-027 — Appointment detail panel

**Built:**
- `packages/db/appointments/detail.ts` — the read model: appointment, client (with the pinned note), services, the event log, the outbox rows, and a derived conflict flag.
- `apps/web/lib/appointments/event-language.ts` — APPT-07's plain-language log, total over every event type the codebase writes.
- `/staff/appointments/[id]` — the panel, with status controls and the per-visit note.
- Day-grid chips now point here instead of at the client record.
- 10 e2e. 753 unit tests total (this item is UI over existing write paths; its logic lives in modules already covered).

**Decided:**
- **The event log is rendered in sentences, not rows.** `status_changed {"from":"booked","to":"no_show"}` is a database record; "Changed from booked to a no-show by the front desk" is an answer to the question somebody is actually asking six weeks later. The formatter is typed total over the eight event types, so a ninth is a compile error rather than a raw enum on screen — the same reflex as the status colour map.
- **The status buttons come from the §7 table**, asked with this actor and this clock, so a button can never offer a move the write path then refuses. A no-show before the appointment starts is not disabled — it is *absent*, because the table says it does not exist yet.
- **The screen sends the status it displayed** (`expectedFrom`). Two people at the desk tapping different buttons produces "somebody else got there first — it is checked in now", not a silent overwrite.
- **The pinned client note is first on the page and unmissable.** An allergy note nobody scrolls to is a note nobody reads (CLIENT-03).
- **The override marker carries its reason** (BOOK-05/D-8) — a marker without one is a marker staff learn to ignore.
- **Chips on the day grid now go to the appointment, not the client.** The front desk's next question is "what happened to this one?", the client is one link further on, and a walk-in with no client record finally has a destination.
- **A staff surface, so D-10's customer lexicon does not apply.** This screen says "no-show" because that is the word the front desk and the reports use.

**Three of my own mistakes, in the specs rather than the app:**
1. **A dynamic `await import()` of a workspace package** inside a Playwright spec — `exports is not defined in ES module scope`. Made static, and I fixed the same latent pattern in A-019's conflicts spec before it bit.
2. **`return promise` inside `try/finally`**, so the helper disconnected Prisma while the booking's interactive transaction was still open. It surfaced as `Response from the Engine was empty`, which reads like a database fault rather than a harness one. `return await` fixes it; the note is written next to both.
3. An assertion that matched the override reason in *both* the banner and the log — both appearances are wanted, so the assertion is scoped rather than the UI changed.

**Left behind:**
- No staff reschedule picker on this panel; A-019's conflict list links to the day view for "find another time". `rescheduleAppointment` and `rescheduleOptions` are both staff-callable already, so this is a picker, not a mechanism.
- Cancelling from here goes through the state machine and the log; the outbox notice is A-020/A-022's.
- The conflict flag is derived per render with two `count` queries. Fine for one appointment; A-019's day-wide version is the one with the batching note.
A-027 committed at b0d189a

---

## Demo checkpoint 2 — walked at the Milestone 3 boundary

Full transcript and findings: `docs/reviews/07-demo-checkpoint-2.md`.

**It found two real defects, both fixed here, both invisible from inside the items that introduced them:**

1. **The day column showed the neighbouring days.** `loadDayView` queries local midnight ±24h — the busy set needs that width so a neighbouring day's buffers still subtract, and an overnight window needs it to exist at all — but the *displayed* appointments were never clipped back. On the seeded week, Dana's Tuesday column held 29 appointments running into Wednesday afternoon; two were hers that day. Every A-016 test passed, because each seeds a single day and the defect needs a neighbour with rows in it. Fixed by clipping the column to the day and its own windows; regression test books Monday, Tuesday and Wednesday on purpose and is mutation-verified.

2. **A gap the grid offered was not a time the engine would sell.** A gap opens where the previous appointment's buffer ends (13:35); slots sit on the salon's 15-minute grid. Clicking a gap booked 13:35, was refused with `SlotNotOffered` carrying *no reasons* (a non-candidate has no exclusion entry), and the panel then offered an **override for a slot that was completely free** — the exact thing that makes the override marker meaningless. Fixed: a gap link is a starting point, and the panel lists the real offered times, preselecting the first at or after it.

**And a regression I introduced fixing (2), caught by A-017's own suite:** the first version fell back to the day's first offered slot when nothing was offered at or after the requested time, which silently turned "book her at 18:00, after we shut" into a 9am booking and reported success — making BOOK-05's outside-hours override unreachable. The fallback is now the requested time itself. Two defects in one seam pointing opposite ways: one forced an override where none was needed, the other prevented one where it was.

**One product question raised for the owner rather than decided quietly** (review §9): "push the column" is all-or-nothing, and on the seeded Saturday the largest push the product accepts is **+5 minutes** while Dana is 38 behind — one client at 16:00 vetoes the whole operation. A-019's bulk reassign, built two items later, is deliberately partial. Recommendation is a named partial push; it changes APPT-04's meaning, so it is not mine to make.

**Smaller observations, no code change:** the checkpoint's prose does not match the seed (no 2:15 gap, no 10:00 client on Dana's Saturday); a customer cancelling via her manage link produces no outbox row and nothing tells the salon; a reassignment does not tell the client she has a different stylist; event rows are stamped by the database clock while domain decisions use the injected `now`.
Demo checkpoint 2 committed at f342ac3

---

## D-26 — push-the-column becomes a named partial (checkpoint 2's product question, answered)

**Owner's call, 2026-08-18: option (2), the named partial push.** Recorded as D-26 in `07-decisions.md`, superseding the all-or-nothing reading of APPT-04.

**Built:** `previewPush`/`pushColumn` now move everything that can move and return `leftBehind` — each one named, with why. The action and the column control say what stayed as well as what went.

**The consequence found while building it:** an appointment left behind still occupies its old time, so anything that would shift onto it cannot move either — **and that cascades backwards**. Without the cascade a partial push hands the database a real overlap and the whole transaction fails at COMMIT, which is strictly worse than either alternative: the desk sees a total failure naming no pair. With it, a fully packed column still reports "nothing moved, here is who is in the way" — better than a bare refusal, but honestly not the same as "now it works". Two tests pin it: one asserts the partial move, one asserts the cascade leaves the database untouched.

**`PushRefused` is gone.** A refusal is now data on the result rather than an exception, because with a partial push "some stayed" is the ordinary case, not the exceptional one.
D-26 committed at 25d8fd6

---

## A-020 — no-show & late-cancel machinery (CLIENT-04, D-27)

**Built:** rolling 12-month no-show and late-cancel counts, derived on every read; the flag on five surfaces (client search, client record, appointment detail, the booking panel's picker, the day-grid chip); the references behind the count, each linking to the appointment whose log says who marked it; and the self-serve block at the write path with the staff bypass.

**Decided (D-27, owner, 2026-08-19 — answers OQ-3):** 3 in a rolling 12 months, per business, `0` = lever off. Only `no_show` blocks; `cancelled_late` is counted and shown but never blocks — blocking it would sanction the client who rang ahead exactly as hard as the one who did not turn up, which teaches her not to ring. The staff bypass costs nothing to use and is recorded on the booking event (`overNoShowFlag`), rather than demanding a typed reason on the busiest surface in the salon.

**Where the interesting decisions went:**
- **The window is a calendar year, not 365 days.** `oneYearBefore` is in `core/time` beside `addDays`, and the comparison is against `startDay` (the denormalized business-zone label), not `startAt`. 365 days is a day out either side of a leap year, and an instant comparison puts a client's 8pm appointment on the last day of the window inside it in the salon's calendar and outside it in UTC.
- **A threshold of 0 means OFF.** The settings form accepts it (the policy validator only demands a non-negative integer), and the obvious `count >= threshold` would have blocked every client in the salon — an owner turning the lever down to nothing would take the booking page offline, and it would look like an outage rather than a setting. One guard, one test, mutation-verified.
- **No upper bound on the window.** A late cancellation is made *inside* the cutoff, so its appointment is usually still in the future when it is counted; capping at today would drop exactly the one the desk is looking at.
- **The block is at `bookAppointment`, not on the screen**, and `audience` is the whole of the bypass — there is no `bypassBlock` flag, because the front desk is already the unrestricted caller (S-3) and a second way to say "staff" is a second thing to get wrong.
- **Counted derived, never stored.** A no-show corrected under APPT-06 un-blocks her immediately, and old misses age out with no job to run and none to forget to run.
- **The counting statuses live in `core/scheduling/status.ts`**, as `MISSED_STATUSES` and `SELF_SERVE_BLOCKING_STATUSES`, not in the query — a ninth status would otherwise be counted by one and ignored by the other with nothing failing.

**The trade-off worth stating (D-17 vs CLIENT-04):** the block is keyed on the client RECORD, so a blocked client can get past it by typing her name differently — a new (phone, name) pair is a new record. Keying it on the phone number instead would block every member of a household that shares one, which is the exact harm D-17 exists to prevent. The comment sits at the identity-resolution site in the public flow, not buried in the gate.

**Left behind:**
- Nothing tells the client she was blocked, and nothing tells the salon she tried. The outbox notice is A-022's territory.
- The seeded no-show history is pinned to fixed 2026 dates, so the demo's offender ages out of the window in 2027 while the seed stays green. The e2e spec seeds relative to today for exactly this reason; the seed itself is a demo-data question, not a correctness one.
- Reschedule is not gated. A blocked client with an existing appointment can still move it through her manage link, which is deliberate: the lever is on new bookings, and refusing a reschedule would produce a no-show instead.
A-020 committed at abb1d1d

---

## A-021 — the confirm loop (APPT-02)

**Built:** the customer's half of confirm, through the manage link — an "I'll be there" button gated by the same §7 table the write path asks, going through `openManageLink` and `transitionAppointment` exactly like cancel and reschedule already do. Plus the staff call-down view: everybody booked tomorrow who has not yet confirmed, one row per client with a `tel:` link, and a one-tap "Confirmed" button that goes through the existing `changeStatus` action.

**Most of this already existed.** A-012 built the whole state machine, including both `booked → confirmed` clauses (`actor: 'staff'` and `actor: 'customer_token'`, no precondition on either), `confirmedAt` on the schema, and the timestamp write. Staff manual-confirm was already live on the appointment detail page as a side effect of A-012's transition table plus A-027's `StatusControls`. "No auto-cancel ever" was already true by omission — §7's table has no `system` actor row anywhere, and that absence is itself commented as deliberate. **A-021's actual scope was two surfaces, not a state machine:** the manage-link affordance, and the call-down list nothing had built yet.

**Where the interesting decisions went:**
- **The call-down list is derived, same reflex as AVAIL-05's conflicts and CLIENT-04's counters.** Nothing stores "needs a call" — a row drops off the list the instant somebody confirms, by either path, because the query is just `status = 'booked' AND startDay = tomorrow`.
- **Sort order stays chronological.** OQ-5 asks whether it should instead rank by ticket value or no-show risk — still open, so this ships the plain reading rather than guessing at an unanswered question, with a comment at the query pointing back to OQ-5.
- **The call-down button reuses `changeStatus`, not a new action.** One row's confirm is `staff` moving `booked → confirmed`, the exact case the appointment detail page already exercises; a second write path would be a second thing that could drift from the table.

**Left behind:**
- Nothing reminds a client to confirm — that is A-022's reminder job, whose token-carried confirm/cancel actions this loop's manage-link action now exists to receive.
- The call-down list has no bulk action; the desk works it one call at a time, same shape as AVAIL-05's conflicts list.
A-021 committed at 0cb80cf

---

## A-022 — the reminder job (NOTIF-02, NOTIF-03)

**Built:** `sendDueReminders`, a pure-window + DB pair — `reminderWindow()` in `core/notifications` computes `[now+24h, now+24h+5m)` on plain instant arithmetic (spec X-3/X-4), and `packages/db/notifications/reminders.ts` queries `{booked, confirmed}` appointments inside it, one `enqueueNotification` per appointment keyed on `reminder-24h:{id}:{startAtEpochMs}` (P1-7, already the dedupe contract). The first HTTP route handler in the app (`/api/jobs/reminders`, bearer-secret gated, refuses closed if `CRON_SECRET` is unset) triggers it and then calls `dispatchPendingNotifications` — nothing else in the repo was calling dispatch on a schedule, so this route is also the first thing that makes the whole outbox actually send. `vercel.json` schedules it every 5 minutes.

**Decided (D-28):** the job REISSUES the manage token per reminder rather than reusing the one from booking — the raw token is only ever held in memory at mint time (only its hash is stored, TOKEN-01), so nothing later can recover an old one. Reissuing revokes the original confirmation's link, which is intended: the reminder is itself a new outgoing message, and "the newest message's link is the live one" is the same rule D-5 already applies to a corrected-phone-number resend, not a new exception.

**Where the interesting decisions went:**
- **"Skips terminal/rescheduled-away" is two different guarantees.** Terminal is `REMINDER_ELIGIBLE_STATUSES = ['booked', 'confirmed']` in `core/scheduling/status.ts` (a positive allow-list — `TERMINAL_STATUSES` would have let `checked_in`/`in_progress` through by accident, since neither is terminal). Rescheduled-away needs no code at all: D-6 means reschedule is a same-row UPDATE, so a moved appointment is simply absent from the query at its old `startAt` and present at its new one — nothing to skip, because nothing to find.
- **The window is 5 minutes wide (X-4) on purpose**, matching the cron interval exactly: an interval trigger firing at least that often never leaves a gap, and a tick that re-sweeps an appointment already handled is a harmless no-op at the dedupe key, never a double send.
- **The dedupe check runs BEFORE the token is touched**, not just inside `enqueueNotification`'s own unique-constraint catch. A tick that re-sweeps an already-queued appointment would otherwise needlessly revoke a token a client might already be holding from the first message — checked-then-acted, not caught-after-acted.
- **Physical 24 hours, not a calendar day (X-3).** On the spring-forward morning, a 09:00 appointment's reminder fires at what the salon's own wall clock the day before calls 08:00 — documented and asserted, not treated as a bug to chase, per the spec's own resolution of an otherwise-undocumented ambiguity.

**Left behind:**
- **The dispatcher's claim race is now live, not hypothetical.** `dispatch.ts` has carried a documented `ponytail` note since A-004 that two concurrent dispatchers could double-send; this job is the first real caller. Left as-is — the trigger is one scheduled route, not proven-concurrent — with the comment updated to say so and the same upgrade path (a claim-row `UPDATE ... RETURNING`) still named.
- **No second-touch reminder.** OQ-5 (still open) asks whether a 2h-before day-of reminder is wanted; this ships the one NOTIF-02 actually specifies.
- **Vercel's Hobby tier only runs cron daily.** `vercel.json`'s 5-minute schedule assumes Pro, or an external scheduler hitting the route with the bearer token — a deployment-tier question, noted in the route's own comment, not a correctness one.
A-022 committed at 43edf22

---

## A-023 — waitlist, staff half (WAIT-01, WAIT-02)

**Built:** `packages/core/waitlist/day-parts.ts` — the closed vocabulary an entry's free-text `dayParts` draws from (seven weekday tags off `weekdayOf`'s own 0-Sunday convention, plus `morning`/`afternoon`/`evening`), and `matchesDayParts` (a conjunction — "Saturday morning" requires both, not either). `packages/db/waitlist/waitlist.ts` — entry CRUD (`createWaitlistEntry` validates the range, the tags, and that the client/service/providers actually belong to this business) and `matchFreedSlot`: pre-filters candidates in SQL (same service, this provider acceptable via `providerIds.isEmpty OR has`, day in range), then does the one thing SQL can't — the fit check (`bufferBefore + effectiveDurationMinutes(override) + bufferAfter <= freedMinutes`, one lookup per call since every candidate wants the same service) and the day-part match — in JS over what's left. `apps/web/app/staff/waitlist/` — the standing queue, an entry form (client search reused from A-015/A-017, native `<input type="date">` for the range), and, when reached with a freed interval in the URL, "who wants this slot?" with a `Book` link straight into A-017's existing staff-booking flow. The appointment detail page (A-027) grew the one link that populates that URL — visible only once a cancel actually freed the time (`SLOT_FREEING_STATUSES`), built from `blockedStart`/`blockedEnd` (D-16 — the buffer-inclusive range the constraint actually let go of, added to `loadAppointmentDetail`'s read model alongside the primary service line's id).

**Decided:** No `WaitlistStatus` module to mirror `core/scheduling/status.ts` — that file's whole justification is "many readers, one status enum" (D-7's rule), and this status column has exactly one reader today (`matchFreedSlot`'s `status: 'active'` filter) plus one setter. Building the module ahead of a second reader would be exactly the speculative abstraction CLAUDE.md warns against elsewhere; revisit if OQ-4's automation adds one.

**Where the interesting decisions went:**
- **The freed interval is `blockedEnd - blockedStart`, not `endAt - startAt`.** That's the range the exclusion constraint actually stops defending on cancel — buffer-inclusive — so a waitlisted client's own buffers are checked against what's really open, not just the body of the appointment that left.
- **"Fits" is a duration/buffer sum against one fixed window, not a second run of the slot engine.** WAIT-01 only needs "would this service fit in what just opened," not "where in the day would it fit" — that second question is what A-017's booking flow (reached via the `Book` link) already answers properly, with the real busy set. Re-deriving it here would be the day-grid-vs-engine fork `packages/core/scheduling/spans.ts`'s own comment warns against.
- **A multi-service visit's freed slot only offers its PRIMARY (first-ordinal) service to the waitlist.** Matching a freed visit's second service is a real gap — nobody waits for "a colour that happens to follow a cut" — deferred until an operator asks for it.
- **`dayParts` is a conjunction, not an either/or.** "Any Saturday morning, Dana or Priya" (the operator review's own example) reads as AND between weekday and time-band; mixing so an entry could ask for "Saturday OR Sunday mornings" is left out, same reasoning as above.

**Left behind:**
- **No automated offer.** OQ-4 (soft-hold vs. first-to-accept) is explicitly still open and gates it — this page only ever answers a human "who," never sends anything itself.
- **No expiry job.** A stale entry sits in `active` until staff mark it `fulfilled`/`cancelled` by hand; nothing ages an entry out on its own. Not asked for by WAIT-01/02, and the schema's own `createdAt` is there for whenever it is.
- **The e2e's own accessible-name collisions were the interesting part of writing it**: the Service `<select>`'s accessible name concatenates every option's text, and "Root touch-up" contains "to" as a substring — `getByLabel('To')` for the date range needed `{ exact: true }`. And a server action's mutation must be waited on for its own visible effect before navigating away — `page.goto()` right after a click aborts an in-flight request exactly like closing a tab would.
A-023 committed at f817a2f

---

## A-024 — the owner dashboard (RPT-01, RPT-02, RPT-03)

**Built:** `packages/core/reports/utilization.ts` — RPT-02's frozen formula as pure functions: `availableMinutesForDay` (working-window spans minus breaks minus absences, reusing the exact `resolveWindow`/`union`/`subtractSpans` triple the day grid and engine already share, run DIRECTLY on the resolved spans rather than through `computeSlots` — a window's unbookable tail shorter than one grid interval is real working time, not idle time, per RPT-02's own "grid dead-zones count as unbookable, not idle") and `utilizationFraction` (`null`, never `0`, on a zero denominator). `packages/core/reports/week.ts` — `weekOf`, a Monday-Sunday bounds helper; Tue-Sat business hours mean Monday/Sunday just contribute nothing to either side of the formula, which is a cleaner boundary than special-casing the business's closed days. `packages/db/reports/dashboard.ts` — `dashboardSummary` (bookings, cancels split normal/late, no-shows grouped by provider, utilization per provider, one week) and `listReportAppointments`, the single parameterized query every tile's drill-down link points at (RPT-01's "every tile drills into the underlying filtered list" — one list, not four). `apps/web/app/staff/dashboard/` — the four tiles plus prev/next week navigation, and `.../appointments` — the filtered list.

**Decided:** The density seed (`packages/db/settings/density-seed.ts`) needed a real gap closed to make RPT-02's AC assertable at all — every DEMO_WEEK appointment it books is left in `booked` forever, and the numerator needs `{completed, no_show}` minutes. A-024 walks Dana's DEMO_WEEK book through the REAL transition table (`booked → checked_in → in_progress → completed`) for the "week already happened by demo time" case, and two appointments (the last two, chronologically — deterministic under the seeded PRNG) go to `cancelled_late` instead, which is also demo checkpoint 3's "two seeded offenders." The frozen constant itself — `1290 / 2100`, Dana's DEMO_WEEK — was read off a run of the real seed and pinned in `packages/db/reports/utilization-constant.test.ts`, not hand-derived: nobody can hand-derive it, since the seed books greedily against the live engine and a slot it offers can still be taken by the time it's written.

**Where the interesting decisions went:**
- **RPT-03 (reschedules excluded from the cancellation rate) needed no code.** Reschedule is a same-row UPDATE (D-6), so a moved appointment simply isn't counted at its OLD week anymore — the identical free lunch A-022's reminder job got from the same decision, noted there and now here a second time.
- **"Bookings" is a gross count**, every appointment scheduled that week regardless of what happened to it since — parallel to "cancels" and "no-shows" being subsets of the same set, and the honest number for "how much did the desk actually book," as distinct from what survived.
- **The numerator is a plain JS sum over a `findMany`, not a SQL aggregate.** A `groupBy` cannot sum a computed expression (`endAt - startAt`), and the row count here — one small salon, one week — is nowhere near where a raw aggregate would earn its keep.
- **A provider with availability but nothing completed reads 0%, not n/a.** Those are different facts, and RPT-02 says so explicitly; the distinction only bites on the zero-DENOMINATOR case (no roster that week), asserted as its own test.

**Left behind:**
- **No revenue tile.** RPT-01 never asks for one, and the four named tiles (bookings, cancels, no-shows, utilization) are the whole of what's specified.
- **No date-range picker beyond week navigation.** Prev/next week, named in the URL, is what A-016's day grid already established as the pattern here; a custom range is a bigger UI than four tiles justify without one being asked for.
- **`seedDensity` is one step less safely re-runnable than it looked** — its own `TimeOff.create` for Marcus already wasn't idempotent before this item, and the new transition step inherits the same posture (fresh-database invocation only, which is how `db:reset:test` and the test suite both use it). Not new risk, just the same one, now touched by one more step.
A-024 committed at 9e82f5c


## Scoping pass — segmented durations (SEG-01..05, A-029, A-030, OQ-7)

**Built:** No code (commit `45e79e7`). The first Phase 3 item was written up to the same standard every MVP row got, *before* implementation: a new **SEG** epic in `docs/prds/00-master-prd.md` §5 (five stories), two backlog rows in `docs/prds/06-backlog.md`, and one open question in `docs/prds/07-decisions.md`.

**Decided:** **Segments split into two tickets, and the split is the point.** A-029 (M) models and renders segments with the engine and the database untouched; A-030 (L) lets the engine offer the gap. The line between them is exactly the line the operator drew in `docs/reviews/01-operator-review.md` §2 — "medium on whether the builder should do overlap-booking in v1 vs. just modeling the segments and exposing the gap to staff; booking into the gap manually first is a defensible v1." A-029 is safe under either answer to OQ-7, so it can be built now; A-030 cannot.

**Where the interesting decisions went:**
- **The finding that forced the split: `appointment_no_overlap` ranges over ONE `tstzrange` per `Appointment` row, and a range cannot express a hole.** Gap booking means an appointment's provider-occupancy becomes a *set* of spans, so the constraint's unit stops being the appointment. That is a migration of the single most load-bearing invariant in the build (D-2), and it drags A-009's nine race interleavings, D-16's zero-width override range, A-014's same-row reschedule, A-018's deferred column push, A-019's bulk reassign and A-026's busy-set query with it. Written up as **OQ-7** with three candidate shapes rather than settled mid-item.
- **Corrected a claim the backlog was making.** Phase 3 read "the first three exist as D-12 schema affordances precisely so none of them is a migration." True of the *tables*, false of the *constraint* — for segments and for resources alike, the affordance bought the cheap half. The correction is written into the backlog next to the rows it affects, not silently edited away.
- **A gap never scales with a provider's duration override (SEG-02).** Colour develops for 35 minutes regardless of who mixed it; applying a stylist's speed to chemistry would silently mis-time every segmented booking. The override scales active segments only, integer minutes, remainder to the last, and is refused at save time if any active segment would reach ≤ 0.
- **`Service.durationMinutes` stays authoritative** and must equal the sum of active segments. That is what makes A-029 additive: a single-segment service is byte-identical to a v1 service, so the footprint the exclusion constraint already ranges over cannot drift from the parts.

**Left behind:** OQ-7 unanswered, deliberately — A-030 names it as a dependency and says not to start before it is decided. Resource pools have the same latent constraint problem and no ticket yet.

## A-029 — segments modeled and visible (SEG-01, SEG-02, SEG-03)

**Built:** (commit `9fc30ed`) `packages/core/settings/segments.ts` — the pure half: `validateSegmentStructure` (the rules a parts list obeys on its own terms), `validateSegments` (those plus the sum invariant), `scaleSegments` (a provider's duration override re-times the ACTIVE parts and never the gap), `gapSpans`, and `visitGapSpans` (the same across a VISIT-01 multi-line visit, each line re-timed to its own D-18 snapshot). `packages/db/settings/segments.ts` — `listSegments`, `segmentsByService`, `replaceSegments`. One migration, `20260819183000_segments_beyond_one`, dropping the partial unique index that pinned every service to one active segment. A parts editor on the service card, gap stripes on the day grid, a "free inside it" row on the appointment panel, and three-part Colour + five-part Balayage in the setup seed.

**Decided:** **The parts are the source of the total.** `replaceSegments` writes the segments and sets `Service.durationMinutes` from their sum in one transaction. The first design validated a proposed list against the *stored* duration, and a db test immediately caught the deadlock that creates: the duration guard on `updateService` refuses a total that disagrees with the parts, so a segmented service could never be lengthened or shortened by any sequence of edits. The owner would have found that, not a test, if the two guards had been written a day apart.

**Where the interesting decisions went:**
- **A gap never scales with a provider's duration override (SEG-02).** Colour develops for 40 minutes regardless of who mixed it. Only the active parts absorb an override, proportionally, with the rounding remainder on the last one so the total stays exact — and an override that cannot leave every active part at a minute or more is refused at save time, naming the gap minutes that will never shorten. A test sweeps six awkward totals and asserts the parts re-add exactly every time.
- **No backfill, because no rows means one implicit segment.** `segmentsOrWhole` gives an unsegmented service a single active part of its whole duration, so every service built before this item is already correct and the migration is one `DROP INDEX`.
- **A leading or trailing gap is refused.** Provider-free time at the start means the service starts later; at the end it means the client is in a chair the provider has already left. Both are buffers, which exist and which the exclusion constraint already ranges over.
- **The stripe is not a booking target.** The constraint still defends the whole footprint, so a link there would offer a booking the database then refuses. Staff book the gap through the existing BOOK-05 override — the operator's own "defensible v1". A constraint test now pins that: `still refuses a booking landing inside a segmented appointment (pre-A-030)` is a deliberate tripwire that should fail when A-030 lands, so whoever breaks it has read OQ-7 first.
- **The gap is in the accessible name, not only in the hatch.** `40 min free from 10:50` is part of the chip's label, because a stripe says nothing to a screen reader and the free minutes are the entire point of the screen.
- **One pre-existing defect surfaced and was fixed at the root:** the qualification row rendered `errors._confirm` and nothing else, so any `ServiceRejected` on an override — a zero duration, a non-integer price, and now the gap rule — made the button do nothing and say nothing. It now renders every error, so a new rejection reason cannot go silent.

- **A repeat of a trap the services spec already documents.** Playwright's `hasText` is substring AND case-insensitive, so the parts editor's own help text — "colour developing" — made every service card match `hasText: 'Colour'`, and the test opened the Cut card instead. The services spec carries the same warning about "Cut" matching "Cancellation cutoff". Both specs now find a card by its name exactly, via a named helper rather than an inline filter.

**Left behind:** Segments are read from the service at render time, not snapshotted onto the appointment, so re-splitting a service redraws an old appointment's stripe. Harmless while this is display-only; A-030 needs the snapshot. The sum invariant is validation-plus-test rather than a trigger, marked `ponytail:` in the source with that upgrade path. OQ-7 still unanswered, and A-030 still blocked on it.

## A-030 — gap booking, and the exclusion constraint's unit changes (SEG-04, SEG-05, D-29)

**Built:** (commit `886c794`) Migration `20260819234500_appointment_blocks` — `AppointmentBlock` (one row per span the provider is actually working), `appointment_block_no_overlap` moved onto it byte-identically apart from its table, the `appointment_blocks` trigger that derives those rows, `Appointment.segmentPattern` as a D-18-style snapshot with a CHECK, and a backfill so the invariant is continuous rather than briefly absent. `visitPattern` and `patternGapSpans` in core; the snapshot written in `book.ts`; the busy-set query rewritten to read blocks.

**Decided:** **The pure slot engine was not touched, and did not need to be.** A colour contributes *two* busy intervals with its developing time between them, so the engine offers that time without knowing segments exist — the same shape of result VISIT-01 got, where a composed visit was just a longer service. SEG-04 turned out to be a schema change plus one query, which is why this landed well inside its L.

**Where the interesting decisions went:**
- **The blocks are written by TRIGGER, as `blockedStart`/`blockedEnd` already were.** The property worth keeping is that no ORM call, script or psql session can write an inconsistent range. Had application code emitted these rows, a path that forgot would UNDER-block and double-book, and the constraint could not tell. So the fan-out D-29 warned about mostly evaporated: `book`, `reschedule`, `push-column` and the bulk reassign still write `startAt`/`endAt` exactly as before and the trigger re-cuts the blocks.
- **`segmentPattern` is snapshotted, not read live.** Same reasoning as the buffer snapshot beside it. It also closes the gap A-029 knowingly left: re-splitting a service no longer re-cuts an appointment already in the book, and a test asserts precisely that — the alternative silently frees 70 minutes of a client's appointment that nobody agreed to free.
- **A CHECK constraint PASSES when it evaluates to NULL.** The pattern validator returned NULL for a malformed pattern, so the constraint accepted every one of them — including a pattern ending on a gap, which would leave the last worked part unblocked and let the database double-book it. A test caught it; the sentinel is now `-1`, a real value, so the comparison is definitively false. This is the single most dangerous bug of the item and it looked exactly like working code.
- **A gap that does not line up with the booking grid is a gap nobody can sell.** A failing e2e found it: with the colour's first part at 50 minutes, a 10:00 booking leaves its gap at 10:50–11:30 and the 15-minute grid has no candidate inside it that also fits a blow-dry. The seeded colour is now 45/40/35, which puts the gap on the grid. The feature is worth nothing if the free minutes are unreachable.
- **A-029's hatched stripe was deleted rather than kept.** The day view already emits a real bookable gap chip there now, derived from the same busy set the engine uses, so it cannot disagree with what is actually bookable — and it is clickable and labelled, which the stripe was not. Gap chips now paint *above* appointment chips, because after A-030 the one gap the desk most wants to click is the one inside a colour.
- **The A-029 tripwire did not fire, and that is a lesson worth keeping.** It was written to fail when A-030 landed, but it booked into the gap of an appointment with *no* pattern — one continuous block, correctly refused before and after. A tripwire that does not encode the new capability is not a tripwire. It was replaced with tests that assert the capability in both directions: accepted inside the gap, still refused when spilling into the second worked part.

**Left behind:** `providerId` and `status` are denormalised onto the block because a partial exclusion constraint cannot join; the trigger is their only writer and the predicate is still asserted equal to `ACTIVE_STATUSES`. Resource pools remain the next Phase 3 item and now have a table to hang a second axis on, which was half the reason for choosing this shape.

## A-030 follow-up — the deadlock CI caught, and the diagnostic that named it

**Built:** (commit `815183b`) No schema change. Race test 1d rewritten from a two-writer race into a scripted single-writer test; nothing else.

**Decided:** **The 2026-08-16 unknown-cause flake is no longer unknown.** That test failed once under `TZ=Pacific/Kiritimati`, did not reproduce in 23 runs, and was deliberately left recorded as UNKNOWN rather than "fixed" on a plausible story — with two `console.log` lines added so a repeat would be a diagnosis instead of a third investigation. It repeated on the A-030 push, in CI, and printed `40P01 deadlock detected`. The diagnostic paid for itself exactly as intended, and it stays.

**Where the interesting decisions went:**
- **The cause: two lock-free writers, and a window A-030 widened.** Before A-030 the appointment tuple and its exclusion check happened inside one `INSERT`. Now the appointment goes in first and the block the constraint ranges over goes in from an AFTER trigger a statement later, so both writers can get their tuples down before either checks — and each then waits on the other's transaction. A-030 did not open that window; it made it wide enough to hit. The failure mode matters: `40P01` is not `23P01`, so it did not map to `SlotTaken`, and the loser of a race would have got a 500 instead of "somebody just took it".
- **The fix is in the test, not the code, and that is the honest place for it.** The test's own premise was two writers with serialization deliberately skipped — a scenario in which a deadlock is a legitimate Postgres outcome. It now scripts a raw uncommitted holder against one lock-free write path, which cannot form a cycle and provokes a guaranteed 23P01. That restores what CLAUDE.md requires of this file: a race test is deterministic, and a flaky one is broken rather than a retry candidate.
- **Two fixes were tried and REVERTED, which is worth recording.** An advisory lock inside the block trigger removed the deadlock but inverted the ordering for writers that deliberately bypass the application lock, breaking the staff-override race (1f). Narrowing D-24's lock key from (provider, business day) to the provider alone — attractive because a day-keyed lock never serializes an appointment running past midnight against one keyed to the adjacent day — broke 1f on its own. Both were backed out. The midnight-crossing observation is real and still unaddressed; it is a gap in D-24, not in A-030, and it does not belong in a fix for a deadlock.

**Left behind:** D-24's lock key is still (provider, business day), so two overlapping bookings either side of midnight serialize on different keys. The exclusion constraint still refuses them, so this is not a correctness hole — it is a case where the loser is refused by the constraint rather than by the engine re-check, and therefore where the 23P01 path matters. Worth its own row if the salon ever works past midnight.

## Scoping pass — resource pools (RES-01..05, A-031, OQ-8)

**Built:** (commit `de73b79`) No code. A `RES` epic in `docs/prds/00-master-prd.md` §5, one backlog row (A-031), and one open question (OQ-8).

**Decided:** **A-030 invalidated the reasoning behind D-20, and that is why this row exists.** D-20 ruled the resource axis out of v1 on a single premise — "for a 4-chair salon with 4 stylists the pool never binds, so the axis would be enforcement theatre". Gap booking exists *precisely* so a client occupies a chair while her provider works on someone else, so the pool now binds with the roster unchanged. This is a consequence of shipped work, not a new feature request.

**Where the interesting decisions went:**
- **The evidence is a passing test, not an argument.** `apps/web/e2e/segments.spec.ts` books a second client into Dana's column while the first is developing — two chairs, one stylist. Four stylists doing that is eight clients in four chairs, every booking accepted.
- **The seed's `CHAIR_COUNT` guard now protects the wrong thing.** It asserts the roster does not exceed the chairs, citing D-20. That was the right guard for the old premise and cannot see the new one; A-031 replaces it.
- **Provider occupancy and resource occupancy are different sets, and that is the whole epic.** A block is a span the provider is working; a chair is held for the entire envelope, gaps included. RES-02 says so explicitly because it is the one thing a reader will assume wrong.
- **OQ-8 turns on whether the database may enforce it at all.** A Postgres exclusion constraint cannot express "at most N overlapping" — that is cardinality, not overlap. Naming N chairs converts one cardinality constraint into N overlap constraints and inherits everything D-2 gives the provider axis; a bare capacity number is what an owner would ask for in words and is the one shape that cannot have that guarantee. Worth the owner's name on it before the write path is built, for exactly the reason OQ-7 was.

**Left behind:** A-031 unstarted and gated on OQ-8. The over-capacity condition is currently undetectable in the product — not merely unenforced — so until A-031 lands, nothing surfaces it to the desk.

## A-031 — resource pools, the axis A-030 made load-bearing (RES-01..05, D-30)

**Built:** (commit `c6435de`) Migration `20260820011500_resource_holds` — `Service.requiredResourceTypeId` (nullable), `Appointment.resourceId` (nullable), the `AppointmentResourceHold` child table, the `appointment_resource_no_overlap` exclusion constraint, and the trigger that writes the hold. `packages/db/booking/resources.ts` chooses the chair; `book.ts` calls it; `NoResourceFree` reports a full room; `isSlotTakenError` now recognises both exclusion constraints. The setup seed creates a `Chair` type with four chairs and points every service at it.

**Decided:** **The hold is a separate table, not a column on `AppointmentBlock`** — and this was corrected mid-item, after the option presented at decision time said otherwise. A block is a span the PROVIDER is working; a chair is held for the whole envelope, gaps included. Hanging the chair off blocks would have released it during the developing hour, which is the one interval the client is most certainly sitting in it. D-30's decision was unaffected; only the table it hangs on, and the correction is recorded inline in the decision.

**Where the interesting decisions went:**
- **A capacity number could never have had the guarantee.** A Postgres exclusion constraint cannot express "at most N overlapping" — that is cardinality, not overlap — so "no more than 4 clients at once" could only ever be a count-then-write, which is the pattern D-2 exists to forbid and which two concurrent transactions defeat. N named chairs turn one cardinality question into N ordinary overlap questions. The objection to naming chairs — that nobody wants to — evaporates under auto-assignment: the owner names them once and no one at the desk ever picks one.
- **The chooser is not the enforcer.** `findFreeResource` picks the first free chair; the constraint is what guarantees it stays free. Two transactions can both pick Chair 1, and the loser is reported as `SlotTaken` — the same outcome as losing a race on the provider axis (RES-03). A test writes a conflicting hold in raw SQL, bypassing the application entirely, and is refused by name.
- **A staff override holds no chair at all**, the same reasoning as D-8's zero-width provider range: the constraint must never be the thing that refuses staff a knowing decision. "We'll do her at the backwash" is a real answer, and software that refuses it outright sends the desk back to paper.
- **`completed` and `no_show` still hold their chair; only cancellations free it.** Same predicate, derived from the same `ACTIVE_STATUSES` as the provider axis. And the range is half-open, so back-to-back clients share a chair at the boundary — with `'[]'` the salon would lose a seating every hour.
- **The seed's `CHAIR_COUNT` assertion was replaced, not deleted.** It guarded D-20's premise that the roster must not exceed the chairs. The roster size was never the thing to guard; the concurrent *client* count is, and only the database can guard it.

**Left behind:** A visit takes its FIRST line's resource requirement — one chair per visit, marked `ponytail:` in the source. A service needing two types at once (a chair *and* the backwash) is a different data shape and nobody has asked for it. Chairs are not yet visible anywhere in the UI: the desk sees a refusal with a reason, but not which chair anyone is in, and no screen shows the room filling up. That is the obvious next row if the salon wants it.

## Operator review at the Phase 3 boundary (`docs/reviews/08-operator-review-phase-3.md`)

**Built:** No code. The review, five backlog rows (A-032..A-036) and one moved up from the unscoped list (A-037).

**Decided:** **The finding is a pattern, not five gaps.** Three mechanisms were built correctly at the write path and each deferred its operator-facing half to the next row, which deferred it again — staff reschedule went A-014 → A-016 → A-027 → A-019 and back to the day view, arriving nowhere. The most consequential one: `rescheduleAppointment` has exactly one caller in the app and it is the CUSTOMER's manage link, so the desk's only way to move a 3 o'clock to 4 is cancel-and-rebook, which A-012 correctly records as `cancelled_late` against a client who did nothing wrong. Both load-bearing claims were verified by grep before the review was committed.

**Left behind:** A-033..A-037 unstarted. A-036's cancel half needs an owner's answer before it is built (some desks make the call first, deliberately); its reassign half does not.

## A-032 — the room is visible to the engine (RES-03, RES-04, D-30)

**Built:** (commit `ea3d37b`) `packages/db/scheduling/resource-load.ts` — a sweep over `AppointmentResourceHold` producing the spans in which every chair of a type is held, fed into the busy set as a new `resource-full` kind. One new `ExclusionReason` (`no-resource-free`) and one line in the engine. `book.ts` maps that reason to `NoResourceFree`; both action layers now catch it — the customer gets the "just been taken" wording with refreshed alternatives, the desk gets RES-04's override with the reason spelled out.

**Decided:** **The cardinality question is answered in the adapter so the engine never has to ask it.** "Are all four chairs taken?" is a counting question and the engine takes intervals — which is exactly why D-30 had to name four chairs at the database rather than store a capacity number. The same move works here: sweep the holds once, emit the spans where concurrent holds reach the chair count, and hand the engine intervals it subtracts the way it subtracts a break. The pure engine's diff is one `if`, and it still does not know what a chair is.

**Where the interesting decisions went:**
- **A full room is its own reason, not `overlaps-booking`.** Marcus has no client at all when the room fills, and telling the desk he does is the wrong-explanation failure that gave `ad_hoc_block`, `time_off` and `running-late` their own reasons after the Milestone 1 operator review. The exclusion assertion checks the reason (`toEqual(['no-resource-free'])`), never a `not.toContain`.
- **`NoResourceFree` stayed the error, rather than the engine path throwing `SlotTaken`.** A full room is neither of book.ts's two existing answers: nobody took this slot, and it *was* genuinely on offer. Keeping one error for one condition also left A-031's suite passing untouched, which is the signal that the layering was right — the chooser's refusal and the engine's exclusion are the same fact arriving at different times.
- **The customer is not told the SALON is full.** She is told the time has gone, with the times that remain. How many chairs the business has and how full it is are occupancy facts about the business (spec §1.3, D-10's lexicon), and the public branch deliberately shares wording with `SlotTaken` rather than getting its own.
- **`excludeAppointmentId` was carried onto the resource axis too.** Without it, a full room makes every reschedule inside the hour impossible, because the appointment's own chair blocks its own destination — the exact defect the busy set already carries that parameter to avoid (spec §4.6). Tested.
- **Half-open on this axis as well.** The sweep processes an end event before a start event at the same instant, so a hold ending at 11:00 frees its chair for one starting at 11:00. With `'[]'` the salon loses a seating at every boundary — the same defect the exclusion constraint would have had, now with a unit test that fails if the tie-break is reversed.
- **Zero chairs of a required type means ALWAYS full, not never full.** The sweep returns nothing for a capacity of zero and the caller turns the whole query window into one busy interval, so the surface renders "nothing available" rather than an error it cannot explain.

**Left behind:** A time the room cannot seat is now removed for STAFF as well as the public, so the override is reached by submitting the time and being refused — exactly as a double-book is today. The operator asked for the excluded times to be *shown* to staff with their reasons instead; the engine already returns them under `explain`, so that is a staff-surface change and it belongs with A-033's picker. Also: capacity is read per day per provider inside `daysWithAvailability`, so a 28-day date-picker walk now costs two more queries per day. It has not been measured and the room is four rows.

## A-033 — the front desk can move an appointment (APPT-05, D-6, operator P-1)

**Built:** (commit `d762955`) `apps/web/lib/appointments/reschedule-actions.ts` and the move panel on the appointment detail page, over the write path A-014 shipped fifteen items ago. The conflicts screen's "find another time" now opens that panel instead of the day view. `readableReason` moved out of the booking panel into `apps/web/lib/scheduling-words.ts`, shared by both surfaces.

**Decided:** **This was a missing CALLER, not a missing mechanism** — and the gap was invisible from inside every item that created it. `rescheduleAppointment` and `rescheduleOptions` had exactly one caller in the whole app: the customer's manage link. A-014 built the write path and deferred the surface to A-016/A-027; A-016 deferred to A-027; A-027 recorded "no staff reschedule picker" in its own left-behind; A-019 deferred to the day view. Four items, each handing it to the next, each correct in isolation.

**Where the interesting decisions went:**
- **The cost of not having it was a false record, not just friction.** Cancel-and-rebook inside the cutoff is `cancelled_late` by A-012 — correctly — so the workaround branded a client who had done nothing wrong, on five surfaces and in the owner's cancellation tile. The e2e asserts the absence directly (`cancelled` and `cancelled_late` both count zero after a staff move); a refactor that quietly routed this through cancel-then-book would pass every other test in the repo.
- **Two documented exclusions were left closed and became OQ-9, rather than reopened mid-item.** `reschedule.ts` says in its header that provider change and override are deliberately absent — the first citing spec §616's deadlock warning, the second because a silent override would make BOOK-05's marker and A-018's audited push meaningless. Both are worth revisiting and neither is a decision to take while building a screen; that is the rule OQ-7 and OQ-8 established. Recorded with the analysis that motivates it, including the finding that **the sick-stylist case cannot be composed from the two existing primitives**: reassign fails on the source time, reschedule fails on the source provider, and the destination is free the whole time.
- **A native date box, not the customer's 28-day list.** She is browsing; the desk is on the phone with somebody who has already said "next Tuesday". A date input answers that in one gesture and costs zero engine runs, where the day list costs one per day — and staff are uncapped by the horizon (D-21), so there is nothing to clamp it to.
- **The panel's presence is `canReschedule`, asked with the real actor and clock.** Same discipline as A-027's status buttons: the screen never holds its own opinion about what is legal. An appointment in the chair shows no panel because the §7 table says so, and there is an e2e for exactly that.
- **The chip on the day grid was deliberately NOT given a second control.** It is one link with an aria-label; nesting a button inside an anchor is an accessibility footgun, and the chip already leads to the panel.

**Left behind:** OQ-9's two halves (provider change, override). The day grid still routes through the detail page rather than offering an inline move. `MoveOption` duplicates the shape of the customer flow's `OfferedTime` — three fields, two different lexicons (D-10), and merging them would put customer wording one import away from a staff screen.

## A-038 — reschedule across providers (APPT-05, D-31, answers OQ-9)

**Built:** (commit `0c8b128`) `toProviderId` on `rescheduleAppointment` and `rescheduleOptions`, a provider control on A-033's move panel, and `packages/db/qualification.ts` — one module for "can she do this whole visit?", now shared with A-019's bulk reassign.

**Decided:** **The lock reasoning D-31 was recorded with was wrong, and building the row is what found it.** The decision text said a cross-provider move needs one advisory lock on the destination provider-day and no ordering, because the source calendar is only ever vacated. That argument is right about the *advisory* lock and misses the constraint: **an exclusion constraint does not fail fast against an uncommitted conflicting row — it waits on the other transaction.** Two desks doing the two halves of a swap therefore deadlock on each other's old blocks, and Postgres resolves it as `40P01`, which is not `23P01`, does not map to `SlotTaken`, and reaches the desk as a 500. The correction is recorded inline in D-31; the decision itself did not change.

**Where the interesting decisions went:**
- **The fix is the canonical ordering spec §616 named all along, and it is three lines.** Sort the two keys, deduplicate, take them in order. An ordinary same-day time move still takes exactly one lock, so nothing about the common path changed.
- **It closed a pre-existing hole as a side effect.** The identical cycle has been reachable since A-014 for a SAME-provider move across two days — two appointments swapping days on one provider — because only the destination day was ever locked. Nobody had hit it; it was there.
- **The ordering is tested as a property, not as a race.** Both halves of a swap produce the same key order, asserted directly. Running the swap concurrently and watching for a deadlock would be the flaky race test CLAUDE.md forbids — and it would pass on a broken build most of the time.
- **Both events, one transaction.** APPT-07 names "provider change" as its own kind of event, and collapsing a two-axis move into a single `rescheduled` row would lose the half the client actually rings about. `conflictAckAt` is cleared when the provider changes, for the same reason A-019 clears it.
- **The qualification rule stopped being two copies.** "Where qualified" is the operative half of the bulk reassign's name and it is now the same sentence on both surfaces; a drifted copy would put a client with a stylist who cannot do her colour.
- **`BookingRejected`, not a refusal type.** An unqualified or inactive destination provider is the caller handing over an impossible pair — not a race, and not a rule about the appointment's state. It is refused before anything is locked or written.

**Left behind:** OQ-9's override half stays closed and unbuilt: "move her to 6pm, we'll stay late" is still an override booking (BOOK-05), which is where its audit trail lives. The move panel hides the provider control when only one provider is qualified, so a single-stylist salon never sees it. Nothing surfaces the deadlock class itself — if a third write path is ever added that moves an appointment's range, it must take the same ordered lock pair, and only this file's comment says so.

## A-034 — the chair follows the move (RES-03, D-26, D-30, operator P-3)

**Built:** (commit `d69ddb1`) `chairForMove` in `packages/db/booking/resources.ts` (one rule, shared), the chair re-pick in `rescheduleAppointment`, and a chair PLAN inside `previewPush` that the push then executes. `findFreeResource` gained `excludeAppointmentId` and `preferResourceId`. `push-column.ts` now defers `appointment_resource_no_overlap` alongside the block constraint and maps `23P01` to `SlotTaken`.

**Decided:** **The first test was the fixture, and it failed on the most ordinary push in the salon.** One stylist, two consecutive clients, "we're running half an hour behind" — both hold Chair 1 legitimately, because half-open ranges let the 15:00 take the chair the 14:00 vacates, and shifting the pair puts the first on top of the second. The desk got a raw `23P01` from the middle of the write loop, on a push the preview had just promised. No exotic room, no gap booking, no concurrency.

**Where the interesting decisions went:**
- **The root cause was two things, and the deferral was the one nobody had noticed.** A-018 deferred `appointment_block_no_overlap` to COMMIT precisely because a shift moves each appointment across the next one's old range. A-031 then added a second exclusion constraint with the same shape and the same need — and it was never added to the deferral, so the resource axis was checking IMMEDIATELY inside a transaction built on the assumption that intermediate states are allowed. Carrying `resourceId` forward is the other half; either alone still breaks.
- **`reassignAppointment` needed no change, and that is a finding rather than an omission.** The backlog row named all three write paths on the ground that all three carry `resourceId` forward unchanged. True — but carrying it forward is only a defect when the ENVELOPE moves, and a reassign changes the provider and nothing else. The hold the trigger rewrites is the identical chair over the identical range, so re-running the chooser there could only churn a client into a different chair for no reason. The claim is now a test (`impact.test.ts`), so a later change that makes a reassign move the time fails there instead of at somebody's chair.
- **The chair is chosen in the PREVIEW, not in the write loop.** A-018's own rule is that the preview runs the check the action executes, and D-26 requires an appointment that cannot move to come back as `leftBehind` rather than as an exception. A chair picked during the writes could satisfy neither: it could not be shown, and discovering "no chair" halfway through leaves a transaction to abandon.
- **The two axes feed each other, so they settle in a loop.** A client with nowhere to sit stays put; one that stays put blocks anything shifting onto her PROVIDER time; that can strand a third. The chair plan therefore runs inside a fixpoint with D-26's existing cascade, and it terminates because problems are only ever added. Tested with a negative push (pull the column an hour earlier), where a chair failure at 13:00 strands the 15:00 through the provider axis — `no-chair-free` and `blocked-by-one-that-stays` in the same result.
- **Preferring the chair she is already in is not cosmetic.** Without it a uniform shift re-seats the whole column against `ORDER BY name`, which walks clients between chairs for nothing and can exhaust a full room the old seating fitted perfectly. With it, an ordinary "we're half an hour behind" changes no seating at all — asserted.
- **`NoResourceFree`, not `SlotTaken`, and the reschedule had TWO places to say it.** A-032 taught the engine to exclude a full room, but `findOffered` did not map the reason, so a full room reached the desk as "not offered" — the one refusal that does NOT lead to RES-04's override. That mapping is now there, and the write-time `chairForMove` repeats the refusal as the backstop for the race between the check and the write.
- **The customer is still not told the salon is full.** The manage flow maps `NoResourceFree` to the same sentence as `SlotTaken` deliberately: how full the room is is an occupancy fact about the business (spec §1.3, D-10), and A-032 made that call for the booking path already.

**Left behind:** The chair plan is greedy first-fit, marked with its ceiling — a uniform shift keeps every existing chair so greedy cannot do worse than the seating the room already has, but a contrived room could strand a client a global re-shuffle would seat, and she surfaces as `leftBehind` rather than as a wrong answer. `pushColumn` still takes no advisory lock, so the window between the plan and COMMIT is a genuine race; it now surfaces as `SlotTaken` instead of a 500, which is the honest answer but not a closed hole. The write-time backstop in `rescheduleAppointment` is reachable only by that same race and so has no test. And a move still never STARTS or STOPS holding a chair: an override that holds none deliberately (D-30) keeps holding none after it moves, which is asserted rather than assumed.

## A-035 — status controls on the day chip (APPT-03, Goal 3, operator P-4)

**Built:** (commit `5529e66`) `availableTransitions` in `packages/core/scheduling/transitions.ts` — the list of legal moves for THIS appointment right now, which the detail panel had been assembling inline — plus `StatusActions`, one client component rendering `changeStatus` where the desk already is. The grid chip carries the next step; the stylist's own list carries the whole set; `DayView` now carries the business cancellation cutoff so the §7 table can be asked properly on the day.

**Decided:** **The operator's complaint was a COST, so the acceptance test is one**: the client is checked in from the day in one interaction, without the page changing. It was four interactions and two page loads, for the most frequent action in the salon — and `provider-day.tsx` rendered "Checked in" as a dead label with no write path behind it.

**Where the interesting decisions went:**
- **The four lines the detail page used to compute its buttons became a function, and that was the actual item.** A second surface assembling "what can I do to this?" for itself is the rental `VERIFIED` defect starting over — two screens agreeing with each other and disagreeing with the write path. `availableTransitions` is now asked by both, and the buttons on both are what it returns.
- **The chip asks the table WITHOUT a reason, and that is the whole filter.** A chip has no reason box, so asking with a placeholder would offer a button the write path then refuses. Asking without one means the walk-out and APPT-06's terminal corrections — the only reason-requiring edges — stay on the panel where a reason can be typed. No second list decides that; the table does.
- **Two edges are held off the chip deliberately, and that IS a surface decision rather than a legality one.** Cancelling is legal from a chip with no reason, and a mis-tap on a phone would end a client's appointment with no record of why. Confirming belongs to the call-down, a different errand at a different time of day. Both are named in the code with the reason.
- **The button is `available[0]`, never a hardcoded status.** A booked chip offers "Check in", a checked-in chip offers "Start", one in the chair offers "Finish" — asserted, because a hardcoded "Check in" would be right on the demo and wrong by 10:05.
- **A-033 declined to put a second control on this chip, and it was right about the reason.** Nesting a button inside an anchor is invalid and an accessibility footgun. The button is now a SIBLING of the link, which costs the link its full-height click target on chips that have one — a trade the comment records.
- **The chip renders one button, not four, because of geometry rather than principle.** A chip is `minutes × 1.5` pixels tall and the seeded fringe trim is ten minutes. The space test counts the lines the chip has already spent (every line is truncated to exactly one, so it is countable rather than a guess) — a **clipped** button is worse than an absent one, being invisible to the eye and still in the tab order. Under the threshold the chip is the link alone, one tap from the panel that has everything.
- **`DayView` carries the cutoff even though nothing on the chip consults it.** The chip offers no cancel edge, so the only clause that reads it is unreachable from here — but passing a zero would be a lie the day somebody adds one.

**Left behind:** A refusal REPLACES the buttons on the chip and the message is one line, which the grid's `overflow-hidden` will truncate on a short chip; the 15-second refresh brings the truth regardless, and the refusal is a race rather than an ordinary outcome. The grid still shows one action per chip, so no-show from the grid is one tap further away than from the list. `STATUS_TEXT` (provider list), `STATUS_WORDS` (accessible names) and `STATUS_ACTION_LABELS` (buttons) are now three status vocabularies in the web app — the third was consolidated into one place by this item, the other two are different tenses for different jobs and were left alone.

## A-036 — reassign and cancel tell the client (AVAIL-05, NOTIF-01, D-32, operator P-5)

**Built:** (commit `3d7b65c`) An `appointment.provider_changed` outbox row per appointment a bulk reassign actually moves, and an `appointment.cancelled` row for every staff cancellation, both enqueued INSIDE the transaction that does the write. A `notify` flag on `reassignAppointment`/`reassignMany` and on `transitionAppointment`, surfaced as an "I've already rung them" checkbox on the conflicts screen. A "Told: …" line on every conflict row, read from `NotificationOutbox.appointmentId`.

**Decided:** **D-32 — the notice is ON by default and the desk may silence it.** The owner's alternative was an opt-in "and text her" tick, rejected because an unticked opt-in box IS the silent cancellation AVAIL-05 forbids, and it will be unticked on the morning a stylist calls in sick — the one morning the feature exists for. Default-on makes the worst case a redundant text after a phone call, not a client arriving to a salon that is not expecting her.

**Where the interesting decisions went:**
- **The cancel notice went into `transitionAppointment`, not into the conflicts screen's action.** The ticket named the conflicts screen; the conflicts screen is one of four callers. `transitionAppointment` is the ONE place a status is written (A-012), so putting it there means the detail panel's cancel and A-035's day-grid chip send it too — patching the caller the ticket named would have left every sibling caller still silent, which is the shape of the defect rather than a fix for it.
- **Staff only, and the list of statuses is derived rather than typed.** A client cancelling through her own manage link does not need telling what she just did, and nothing in this product cancels on its own (A-021: no auto-cancel, ever) — so the guard is `actor.type === 'staff'`. Which statuses count comes from `SLOT_FREEING_STATUSES`, not from a hand-typed pair, because CLAUDE.md's rule is that a status list is never one edit and a ninth status must not be able to become a silent cancellation.
- **`cancelled_late` is told too.** The split is about who wears the cost, not about who gets told — and a staff late-cancel is the salon's decision, not the client's, so it is exactly the one she most needs to hear about. Asserted, because "late" reads like a reason to say nothing.
- **In the transaction, and the tests are about what happens when it rolls back.** A reassign the exclusion constraint refuses must leave no message promising a move that did not happen, and a transition that loses its race must leave no second cancellation notice. Both are tested by making them fail, not by making them succeed — the same coupling booking and its confirmation have had since A-009.
- **The reassign notice keys on the DESTINATION provider**, the shape the reschedule uses for the destination instant: moving her to Priya and then to Sam is two messages, retrying the move to Priya is one.
- **The conflicts screen's "Told" column is never empty for a real appointment**, because booking already told her once. That is what makes it useful — it shows the LATEST thing she heard, which is what changes what the next phone call says. The test asserts the confirmation first and the newer notice after, so the ordering is the assertion rather than an assumption.

**Left behind:** The suppression checkbox exists only on the conflicts screen; a cancellation from the detail panel or the day-grid chip always tells her, which is the safe direction but is an inconsistency a later item may want to close. The reassign dedupe key cannot distinguish a third move back to a provider the client was already told about (A→B→A→B sends three messages, not four) — the same limitation the reschedule's instant key has carried since A-014, kept for consistency rather than fixed here. No template rendering exists yet for either message: the outbox carries the key and the payload, as every notification in this build does, and the content system arrives with the first real provider driver (D-14).

## A-037 — named staff identity (D-9, D-33, APPT-07)

**Built:** (commit `46390db`) `StaffUser.name`, `pinHash` and `active`, with `email`/`passwordHash` made NULLABLE; an optional `act` inside the signed session cookie; a desk switcher on `apps/web/app/staff/layout.tsx` — the segment's first layout — reading a name and a 4–6 digit PIN; a "Who works here" roster screen; and `AppointmentEventRow.actorName`, resolved in one query per log, so APPT-07's sentences say "by Priya".

**Decided:** **D-33 — the PIN switches identity INSIDE an already-authenticated session; it is not a login.** The two alternatives were a PIN replacing the password outright and a full credential each with no PIN. The first puts a 10,000-guess door on a public form that `staff.ts` already records as having no rate limiter; the second is correct and nobody would use it, which is exactly why four people share one login today. The chosen shape leaves the authentication boundary untouched and makes only the *switch* cheap.

**Where the interesting decisions went:**
- **A staff IDENTITY is not an ACCOUNT, and that is a migration.** The stylist who needs her name on a check-in does not need a way to sign in from home; issuing her a credential to satisfy a `NOT NULL` is a credential somebody has to rotate. `email` and `passwordHash` became nullable, Postgres treats NULLs as distinct under the `(businessId, email)` unique index so any number of PIN-only rows coexist, and `authenticateStaff` matches on email — so such a row can never sign in. Asserted from both directions.
- **Off-boarding DEACTIVATES; it never deletes — and the feature's own purpose forces that.** `actorRef` is a bare string with no foreign key (it carries manage-token ids too), so deleting a staff row would take the name off every event it ever stamped. "Who moved this appointment" losing its answer the day somebody leaves is precisely the failure this row exists to fix. `findStaffById` now filters on `active`, which ends live sessions on the next request with no revocation list — the property the old comment claimed for row deletion, kept by a different mechanism.
- **A deactivated ACTING person falls back to the account holder rather than logging the terminal out.** Off-boarding the Saturday temp must not throw the front desk out of the system mid-shift. Two lines, and the alternative is a support call on the worst possible day.
- **`act` rides inside the signature, and switching does not extend the session.** An id a client could edit would let anyone put anyone else's name on anything, which is the whole audit trail. `sub` and `exp` are carried through unchanged — taking the desk is not a re-authentication, and it must not silently buy another eight hours. A forged `act` and a non-string `act` are both tested.
- **The switcher is a layout, not a component pasted onto fifteen pages.** It is only useful where the person already is, and a per-page copy is fifteen chances to forget one. `currentStaff()` rather than `requireStaff()`, because `/staff/login` lives inside this segment and a guard there would redirect the login page to itself; every page below still guards itself exactly as before.
- **One generic message for every switch failure**, the same reflex the sign-in form uses: an unknown id, a wrong PIN and a person with no PIN set are indistinguishable, or the switcher becomes a probe for who works here on a screen anyone at reception can read. `verifyStaffPin` equalises the timing with the same dummy hash.
- **The business comes from the SESSION, never from the form.** That is the entire security boundary of the switch: a posted id must not be able to put a name from another salon onto this salon's audit log. Tested with a real second business and the right PIN.
- **Identity, not roles.** No permissions matrix, no RBAC. Every staff member can do exactly what a staff member could do before; the only change is that the log knows which of them did it.

**Left behind:** The bar shows who is at the desk but nothing ever hands it BACK automatically — whoever tapped last stays until somebody else taps, which is honest for a shared terminal and wrong for a walk-away. A timeout on `act` is the obvious next move and is not built. The roster screen is reachable by any staff member, so anybody can set anybody's PIN; that is the direct consequence of "identity, not roles" and closing it means opening the roles question D-9 deferred. `actorRef` is still rendered nowhere but the appointment event log — A-007's `createdByActor`/`actorRef` on the availability tables (operator R-8) now have names to show and no screen showing them. And the PIN has no rate limiter, inheriting `staff.ts`'s existing `ponytail:` note; it sits behind an authenticated session, which is the reason that is tolerable and not the reason it is fine forever.

## Phase 3 close — operator review, and the pattern behind five findings

Full review: `docs/reviews/09-operator-review-phase-3-close.md`. Walked 2026-08-21, when the second-pass rows (A-032..A-037) closed and the scoped backlog ran out for the second time. Every finding carries the grep or the `file:line` that proves it, and the two claims that are only half-proved say so — the shape that made the previous review's P-3 useful.

**The previous pattern is confirmed closed.** All five of `08`'s findings — mechanism shipped at the write path, operator surface deferred to the next row which deferred it again — were built as A-032..A-036, and its unscoped recommendation as A-037.

**The new pattern has a different shape, and it is one defect wearing four faces.** Every write path in this build takes an arbitrary day and an arbitrary instant. Every staff *screen* hands it either today's grid or a slot the engine already offered. So: no way to book six weeks out (P-6), no way to reach a client's future appointment (P-6), no way to knowingly double-book (P-9), no way to see what freed up on Thursday (P-10). Scoped as A-039..A-043, ranked by what costs money on a specific day rather than by tidiness.

**Two of the six rows FINISH a row already marked ✅** — A-041 is A-019's deactivation preview, which `grep -rn "listDeactivationImpact" apps packages` shows was built and wired to exactly nothing; A-039 is A-033's other half, which gave the *move* a date box and left the *booking* without one. That trade — a surface for a capability already paid for, over a new capability — is the one the operator says to take every time, and it is why nothing from the unscoped list was promoted.

**A-040 is the only CORRECTNESS RISK in the set** and it is the ordinary case, not an edge: the client card names a cut-and-colour and the Rebook button books a cut, because it carries `serviceIds[0]` into the *customer's* flow — which also drops the resolved `clientId`, loses D-25's staff lead-time exemption and D-21's uncapped horizon, and applies CLIENT-04's block to a client standing at the counter.

**What was explicitly ruled OUT, and stays out:** recurring appointments (the standing-series shape is not what a salon needs; a correctly-wired rebook-at-checkout is, and that is A-040); a week or month grid (the fix for P-6 is a date box — a second answer to "what does Dana have on" can disagree with the first); a chair-visualisation screen (D-30, unchanged); automated waitlist offers until a person answers OQ-4; and notification templates until a real driver exists (D-14). On OQ-5, the recommendation is to leave the call-down chronological and build no second reminder touch — a day-of reminder reaches people already on their way and teaches them to ignore both.

**The unscoped list keeps its order and nothing on it is urgent**, with one piece pulled forward into A-044: A-037's roster screen lets anybody at the counter set anybody's PIN, which makes the audit trail A-037 exists for forgeable by the person most motivated to forge it. The fix is a guard on the password session, not the roles matrix D-9 deferred.

## A-039 — the desk can reach a date (operator P-6, BOOK-04, CLIENT-01)

**Built:** A native `<input type="date">` (`DateJump`, `apps/web/components/date-jump.tsx`) beside Previous/Today/Next on `/staff/day`, navigating straight to `?day=` — the mechanism (`safeDay` treating a hand-typed day as ordinary input) already existed and simply had no control that produced the URL. The staff booking panel (`booking-panel.tsx`) now owns its own day: a date field re-fetches offered times for the newly chosen day without a round trip to the grid, reusing the same `loadFor` fetch the service picker already triggers. The client record's History section is split into **Upcoming** (soonest first) and **Past** (most recent first), and every row — both sections — links to `/staff/appointments/{id}`, replacing what was plain, unclickable text.

**Where the interesting decisions went:**
- **A function prop cannot cross the server/client boundary, so `DateJump` takes plain data.** `basePath` and `extraParams` (a `Record<string, string>`), not a `makeHref` callback — the day grid is a server component and a function reference is not serializable across that boundary. The component builds its own `URLSearchParams` and calls `router.push`.
- **The panel's gap-preselect anchor is scoped to the day it came from.** The existing "preselect the first offered time at or after the tapped gap" logic (demo checkpoint 2's fix) used the URL's `at` unconditionally; once the day can change client-side, an `at` from a different day is meaningless and was silently mis-anchoring the picker. `anchor = nextDay === initialDay ? at : null` — the gap's instant only applies to the day it was tapped on.
- **The "Back to the day" link after a successful booking now points at the day just booked, not the day the panel opened on** — the desk may have moved forward from the URL's day inside the panel (A-039's whole point), and sending them back to the wrong day after booking would be the same defect from the other side.
- **The split is `startAt` compared against a captured `now: Date`, not a stored flag.** Same discipline as A-019's conflicts and A-020's counters: derived on every read, so a booking that moves from upcoming to past between two page loads needs no migration and no job.
- **History rows kept the existing convention** — a small "Details" link beside the row's content, not the whole `<li>` wrapped in an anchor — the same shape A-035 chose for the day-grid chip and the reason is the same one: a link wrapping other interactive content is an accessibility footgun, and a sibling costs nothing.

**Regression tests:** an e2e in `day-grid.spec.ts` jumps six weeks ahead via the date field and asserts the heading; an e2e in `staff-booking.spec.ts` books a service, changes the day inside the panel, and asserts the resulting appointment's `startDay` is the *new* day, not the one the panel opened on; an e2e in `clients.spec.ts` seeds one appointment a decade in the past and one a decade in the future, asserts they land in separate headed sections, and clicks the upcoming row's link through to the appointment detail page.

**Left behind:** A-040 (rebook carrying every service, the staff audience, and the resolved client id) still routes through the customer's `/book` flow and depends on nothing this row changed — it needs the panel to accept a day, which now exists, but the Rebook button itself is untouched. A-042's override reachability (a time entry over the day's grid instants, not just offered ones) is the next piece of the same "the desk can only act on today, or on a slot the engine already offered" pattern and is not built here.

## A-040 — rebook books what she actually had (operator P-7, VISIT-01, CLIENT-01/04, D-17/21/25)

**Built:** The client record's "Rebook" button now points at `/staff/book` instead of the customer's `/book`, carrying **every** `serviceId` in visit order, the provider, the suggested day, and the resolved `clientId`. `/staff/book` learned to read `services` (repeated param) and `client`, resolves them server-side, and hands the panel `initialServiceIds`, `initialClient` and `initialSlots`. `BookingPanel` seeds its state from those three.

**The defect was one line, and it had four consequences.** `service: rebook.serviceIds[0]!` — the card said "Cut + Colour with Dana" and the button booked a Cut. `rebookSuggestion` had been returning the full ordered array since A-015; only the link was throwing it away. The other three came free with the destination being the public flow, and none of them is visible from the link itself:
- **`audience: 'public'`** on the engine calls and the write, so D-25's staff lead-time exemption and D-21's uncapped staff horizon were both lost on the surface staff use most.
- **The `clientId` was discarded and re-resolved by (phone, name)**, so "Jen" typed where the record says "Jennifer" creates a second record — splitting her history, her pinned note and her rolling no-show count. That is the exact harm D-17 exists to prevent and A-015's merge exists to clean up after.
- **CLIENT-04's self-serve block applied**, so a flagged client standing at the counter got "We can't book this one online. Please call the salon" — from the salon. Verified the fix restores the intended behaviour rather than merely bypassing it: `book.ts:153` refuses only on `audience === 'public'`, and `book.ts:404` still records D-27's `overNoShowFlag` with the counts that were showing, so "who did we book over a flag?" keeps its answer.

**Where the interesting decisions went:**
- **The fix was the destination, not a patch to the public flow.** `bookAsStaff` was already correct on every one of the four counts — nullable client, staff audience, ordered `serviceIds`, override available. Nothing in the write path changed. The whole row is an entry point pointed at the right door, which is what the operator's "surface missing from a capability already paid for" means in practice.
- **`initialSlots` is computed on the SERVER, not in a mount effect.** The panel previously only ever loaded times in response to a click, so a prefilled panel would have rendered empty and then filled in. Calling `staffSlotsFor` from the page (it is an async function; a server component invoking it crosses no serialization boundary) means the rebook screen arrives with its list already there.
- **The time is deliberately NOT preselected.** "Same again in six weeks" names a day, never a time — defaulting to the morning's first offered slot would book a time nobody chose, and `ready` already refuses to submit without one, so the desk gets "Choose who and when" rather than a silent wrong default. This is the opposite call from the gap-tap path, and for the opposite reason: a gap names an actual time.
- **A dropped service is SAID, not silently omitted.** Prefill filters requested services against what this provider is still active and qualified for — a service retired last month is ordinary. But silently selecting a shorter visit is the same class of defect as the one being fixed, so the page counts what it dropped and says so in a line above the panel.
- **`findClient` resolves tombstones (R-10)**, so a rebook link from a record that has since been merged lands on the survivor rather than 404-ing or attaching to a dead row.
- **The flag comes with her; the "already booked around then" note does not.** The first is a property of the client (D-27, shown never enforced). The second is computed against the slot being booked, and no slot is chosen yet — the same reason `findClientsForBooking` omits it when it has no span.

**Regression test** (the operator named this one exactly): a two-line completed visit (Cut then Blow-dry) 28 days before the next Tuesday the roster works, so the suggested day is that Tuesday and shares its weekday and hours. Clicking Rebook asserts the staff URL and that both chips read `1. Cut` / `2. Blow-dry` with `aria-pressed=true`, then books and asserts the appointment has both lines **in the original order**, the same `clientId`, and that the business's `Client` count is unchanged.

**Left behind:** `resolvePrefill` in `apps/web/app/book/page.tsx` now has **no in-product caller** — it handles `/book?service=&provider=&from=`, which only the old Rebook link emitted, and its only test moved to the staff path with this row. It was left in place deliberately rather than deleted: it is a working public capability a marketing or share link could legitimately use, and removing a public URL contract is the owner's call, not a side effect of fixing where one button points. If it is not wanted, deleting it is a clean ~20-line removal. Separately, the prefill drops services this provider can no longer do and says how many, but does not say **which** — the desk sees the count and the remaining chips, which is enough to notice and not enough to know what to re-add without opening her history.

## A-041 — deactivation and absence say what they just stranded (operator P-8, AVAIL-05)

**Built, in two parts, matching the two halves the finding named.**

**Part 1 — provider deactivation is a two-step confirm.** `settings/actions.ts:toggleProviderActive` now calls A-019's `listDeactivationImpact` before writing `Provider.active`: if the list is non-empty and the form was not submitted with `confirm=true`, the write is skipped and the state carries the count and the list back instead. `providers-client.tsx` renders that list inline — each row's day, time, client, phone (as a `tel:` link) and services — with a "Deactivate anyway" button that resubmits the SAME form. Confirming writes through exactly as before.

**Part 2 — writing an absence says what it stranded.** `availability-actions.ts:addAbsence` still writes unconditionally — D-2/A-007's rule that recording an absence must always succeed is untouched — but now runs `appointmentsInRange` against the absence's own window immediately after, and returns the count plus which day to send the desk to. `availability-client.tsx` renders "N appointment(s) now stranded" with a "Deal with them" link straight to `/staff/conflicts?day=`. The screen's own paragraph has said "which appointments it strands is shown for a person to resolve" since A-007 shipped; this is the first row that made it true.

**Where the interesting decisions went:**
- **Deactivation gates; absence never does — same D-2 rule, two different write shapes, on purpose.** A provider's `active` flag is a discrete state with an obvious point to pause at before flipping it, and SVC-03 already established a confirm-gate as this codebase's answer for exactly that shape. An absence write has no such moment — "Dana called in sick" cannot wait for a click, so it always lands and only the SENTENCE THAT COMES BACK differs. Treating them identically would have meant either gating an urgent write (wrong) or leaving deactivation to warn nobody (the defect being fixed).
- **The confirm gate shows the LIST, not a count**, which is the whole reason for building this over SVC-03's own shape rather than just reusing its `DeactivationRequiresConfirm` class: A-019 had already built the richer version (client, phone, day, time, services) for exactly this screen, and a bare "40 appointments" forces a second trip to find out who. `listDeactivationImpact`'s own `when` field was bare TIME (correct for `/staff/conflicts`, which is scoped to one day already) — fixed to include the day, since this list spans months and a Tuesday and a Thursday do not deserve the same label.
- **The confirm resubmission uses a native submitter name/value pair, not a `pendingConfirm` client state flag.** SVC-03's existing `service-card.tsx` uses a two-click dance (click "Deactivate anyway" to arm a flag, click "Deactivate" again to actually submit with it) because of how its action-wrapper closure captures state. A submit button carrying its own `name="confirm" value="true"` sidesteps that entirely — the browser includes it in the FormData only when IT was the button clicked, so "Deactivate anyway" submits correctly on the first click with no state and no stale-closure risk. Verified end to end rather than assumed: an e2e clicks it once and asserts the write.
- **No provider-scoping was added to `/staff/conflicts`.** The absence path's "Deal with them" link goes to `?day=` only, same as A-019 built it. The row's own text called a day-scoped link "at minimum" sufficient; adding a provider filter to the conflicts screen is a real but separate piece of work, not required to close this gap.

**Regression tests:** an e2e in `settings.spec.ts` seeds a provider with one future appointment 30 days out, asserts the confirm box names the client, her phone, and the count, asserts nothing changed on first click, then confirms and asserts both the provider and the untouched appointment. An e2e in `availability.spec.ts` seeds an appointment, writes overlapping time off, asserts the write succeeded AND the stranded count, then follows the link to the conflicts screen and finds the client there.

**Left behind:** weekly-hours edits and date-override changes are the other two AVAIL-05 triggers the finding named ("on any hours edit / time off / block / deactivation") and are not wired to this pattern — `saveDateOverride`/`createWeeklyWindow` still return a bare success with no conflict count. The mechanism this row built (`appointmentsInRange` against the write's own window, day computed for the link) applies directly; it was left out to keep this row at its S size rather than silently growing it, and is the natural next slice if the owner wants the full AVAIL-05 sentence rather than its two highest-frequency triggers.

## A-042 — the override is reachable from a screen (operator P-9, BOOK-05, D-4, D-8)

**Built.** Every piece of D-8's knowing double-book already existed and was tested — `isOverride` + reason, the trigger-written zero-width blocked range, `overriddenFromRange`, `override_booked`, the detail marker, D-24's advisory lock. What did not exist was a way for a human to cause the refusal that puts the override on screen: `chosenSlot` could only ever be a slot the engine had *offered* or an `at` from the URL, and the only links that emit an `at` are gap chips — free time by construction. Three changes, no new booking logic.

**1. `staffSlotsFor` returns the whole column, not the sellable part of it.** The engine has returned `excluded` with per-candidate reasons on `audience: 'staff'` since A-026; nothing read them. It now merges `slots` and `excluded` into one chronological `GridTime[]` carrying `reasons: readonly string[]` (empty = bookable), and the panel renders a refused time dimmed, with `readableReason` beside it, still tappable. That tap is the door: it produces the refusal, which produces the override box. A-032's deferred half, closed.

**2. `instantForTime(day, wallTime)` — a server action for times the grid cannot contain.** With candidates anchored to window-open, 18:00 on a day that shuts at 17:00 is never an engine candidate and so can never appear as a refused chip. That is BOOK-05's *first* case and A-038's "move her to 6pm, we'll stay late". The panel's `<input type="time">` sends `{day, "18:00"}` and gets back an INSTANT — all three arms of `resolve()` answered, never collapsed: `unique` selects, `gap` says the clocks went forward and refuses, `ambiguous` returns BOTH instants as two chips ("first time round" / "second time round") because on fall-back day only a person can say which 01:30 she meant. D-4 holds — the form still carries the instant, never `{date, time}`.

**3. A per-column door on the day grid.** `Book with {name}` in the column header, carrying `provider` and `day` and no `at`. Until this link, a fully booked column had no entry into the panel at all, which is why the regression test could not have been written before.

**Where the interesting decisions went:**
- **`SlotTaken` now carries the engine's reasons, defaulting to empty.** Before this row, `SlotTaken` on the staff path was nearly always a genuine race, so `staff-actions` hardcoding `['overlaps-booking']` was right. A-042 makes a *deliberate* tap on an occupied time the ordinary case — and `book.ts` reaches `SlotTaken` for `overlaps-buffer`, `overlaps-time-off` and `overlaps-block` too. Keeping the hardcode would have answered "she already has a client" when the truth was "it runs into another appointment's buffer": exactly the wrongly-explaining screen `scheduling-words.ts` was written to prevent. Empty stays empty and stays honest — a lost race arrives through the exclusion constraint with nothing to say, and `['overlaps-booking']` is still the right guess *there*. `reschedule.ts`'s `SlotTaken` was deliberately NOT changed: its consumer words it as "that time went while you were deciding", which is a race framing that reasons would not improve, and passing an unread argument is the dead flexibility this repo keeps out.
- **The preselect filters to bookable.** `loadFor`'s "first offered time at or after the gap" now runs over `offered.filter(s => s.reasons.length === 0)`. Missing this would have armed the override for a desk that only tapped a gap — the precise way an override marker stops meaning anything, and the same reasoning that made demo checkpoint 2 stop booking raw gap starts.
- **Pure `in-the-past` exclusions are dropped from the list; anything else stays.** A whole morning of "that time has passed" is noise on every afternoon of the year and is the one exclusion nobody can act on. A past time that is *also* occupied still shows, with the reason that matters.
- **The typed times are kept beside the grid, not merged into it**, and cleared on any day or service change. They are not offers, and an instant composed against last Tuesday must not survive a day change.
- **Sorted on the instant, never the label.** On fall-back day two candidates are both called "01:30".

**Also fixed:** the heading named a time the form was not booking. A gap starts where the previous buffer ends — 13:35 — and the panel preselects the first real slot at or after it, so `Tuesday 9 June at 13:35` was a lie about what was about to happen. It now reads "Starting from … — pick the time below."

**One thing the tests caught that review would not have:** the reason on a chip was rendered as `<span className="ml-2">— {why}</span>`, which LOOKS spaced and is not — a margin is invisible to an accessible name, so the button was called "09:00— she already has a client then". The space is a real text node now. The same run then caught the assertion for the refusal sentence matching five elements, because the chips legitimately say the same words; it is pinned to the refusal's own sentence, which ends in a full stop.

**Regression tests:** two e2e specs, and **neither contains a hand-built URL**, which is the whole point — the pre-existing override spec reached the feature through `?at=18:00`, a URL this product has never emitted, and that spec passing is what let the gap survive. The first books a time through the ordinary path, returns through the column-header link, finds that same time listed with "— she already has a client", taps it, reads the refusal in the salon's words, ticks the override with a reason, and asserts `blockedStart === blockedEnd === startAt`, one `AppointmentBlock` that is also zero-width, and an `override_booked` event. The second types 18:00 into the panel, overrides past the close, and asserts the stored instant equals the one `resolve()` produces for that wall time in the salon's zone — the assertion that the round trip to the server is what composed it.

**Left behind:** the walk-in half of the panel still offers only what `walkInOptions` returns; a walk-in that nobody is free for still has no override path, because the choice there is *which stylist* and not *which time*, and the two-axis version of this UI is a bigger question than this row. `overriddenFromRange` is asserted only indirectly (the `appointment_override_range_iff_override` CHECK makes it a condition of the INSERT) because Prisma cannot select an `Unsupported("tstzrange")`; a raw query would assert it directly if that ever seems worth the fixture.

## A-043 — what's opened up (operator P-10, WAIT-02)

**Commit:** `80a9ae2`

**Built.** The matcher (`matchFreedSlot`) has been correct since A-023 and had exactly ONE door: a URL assembled on the cancelled appointment's own detail page. Reaching it therefore required already knowing WHICH appointment cancelled — the one thing the desk does not know when the cancellation arrived through a client's manage link on a Saturday for next Thursday. Three hours of the salon's most valuable service sat unsold for six days with the waitlist entry that fits it two screens away.

`listOpenedSlots` (`packages/db/appointments/opened.ts`) derives future time freed by a recent cancellation and still empty, soonest-to-expire first. `/staff/opened` renders it, one tap from the day grid beside Walk-in / Conflicts / Call-down with a count on the tab, each row carrying a `tel:` link to the client who gave the slot back and a link straight into the matcher.

**Where the interesting decisions went:**
- **THREE bounds, and the tests are mostly about them rather than about the contents.** The row named the risk precisely: `appointmentsInRange` next door has no lower time bound anywhere, which is correct THERE — its window is the absence being written — and would be ruinous here, where unbounded means every cancellation the salon has ever taken with a count badge to match. So: still future (`startAt > now`), recent (a 14-day lookback), and still empty. Eight of the thirteen unit tests assert an exclusion, and each seeds the same fixture as the positive case plus exactly one difference, so none of them can pass vacuously.
- **"Still empty" reuses `findBusyAppointments`, one call per candidate, rather than one clever query for the lot.** That function is the only reader that gets D-16's `overriddenFromRange` and D-29's per-block ranges right; a second copy of that predicate written here to save a round trip is precisely the drift CLAUDE.md keeps out, and it would be wrong in the direction that matters — offering the desk a slot somebody knowingly double-booked. The N+1 is bounded by the two bounds above: a fortnight of a salon's future cancellations, not a table scan.
- **`findAbsences` is checked too, so time off means the slot did NOT open up.** Dana being off is the conflicts screen's problem (A-019/A-041), not a thing to sell to the waitlist — and a list that offers her Thursday while another screen says she is away is the two-screens-disagreeing failure that makes staff stop trusting both.
- **There is no `cancelledAt` column and none was added.** `updatedAt` on a row in a terminal status IS the cancellation in every path that writes one. Its ceiling is named in the code: a later note or acknowledgment edit refreshes it and re-surfaces a slot that is genuinely still open — wrong date, right answer, and the opposite error is impossible. A new column plus a backfill plus a writer in every transition path is a large amount of machinery to make a sort key marginally more honest.
- **Ordered by how soon the time EXPIRES, not by when it was cancelled.** A Thursday 2pm dies on Thursday at 2 whether it was freed this morning or a week ago. Ordering by recency would put the freshest news at the top and the thing worth a phone call now at the bottom.
- **A cancelled override is excluded and a deactivated provider's slots are excluded.** The first freed a zero-width range (D-8) — it never held any time to give back, and its `freedMinutes` of 0 matches nothing; the second cannot be booked with at all after A-041.
- **The URL is built in one place now** (`lib/waitlist/freed-link.ts`). Two hand-assembled query strings agreeing on four parameter names is drift nothing fails on: the second one would simply match nobody, quietly, forever. The detail page's link was repointed at it.
- **The tab count is NOT scoped to the day being viewed.** What opened up is a fact about the weeks ahead; scoping it to the grid's day would empty the tab the moment somebody paged back to last Tuesday, which is the same "the desk can only act on today" pattern A-039/A-042 have been closing.

**Regression tests:** thirteen against a real database in `packages/db/appointments/opened.test.ts` — past slot, stale cancellation (and the same fixture reappearing with `lookbackDays: 365`, so it is provably the lookback doing the dropping and not the date), re-booked slot, time off over the slot, `no_show`/`completed` (terminal but still occupying, D-7), cancelled override, deactivated provider, business scoping, both freeing statuses, and the ordering. Every fixture stamps `updatedAt` explicitly by raw UPDATE rather than inheriting `now()`, because a suite whose lookback assertions depend on the day it is run is a suite that goes red on its own one morning. Three e2e in `opened.spec.ts` walk the door the row is actually about: today's grid → the tab with its count → the row with its `tel:` link and true 55-minute footprint (45 body + Cut's 10-minute after-buffer) → the matcher — **never visiting the appointment**, which is exactly what A-023's own spec did and why it could not have caught this.

**Left behind:** the automated offer (OQ-4's soft-hold) stays where it was — this screen still only ever answers a human "who", and sends nothing itself. `matchFreedSlot` matches ONE service, so a two-line visit that cancels is offered to the waitlist as its first line only; that is the pre-existing shape of the matcher, not something this row narrowed. The count is recomputed on every day-grid render, N+1 included; if that ever shows up in a trace, the bounds make a single `NOT EXISTS` query a mechanical rewrite.
