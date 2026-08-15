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
