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
