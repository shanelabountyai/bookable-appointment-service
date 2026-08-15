# 06 — Prioritized Product Backlog

**Product:** Bookable — appointment scheduling for a service business
**Status:** v1.0 — 2026-08-14
**Sources:** `00-master-prd.md` (story IDs are the authoritative acceptance criteria), `07-decisions.md` (overrides PRD text), `docs/reviews/03-slot-engine-spec.md` (normative for A-003/A-009/A-010)

Single, strictly-ordered build backlog: every item is buildable when reached, foundation first, shortest path to the two golden paths — **(1) a customer books a real slot against a race-proof engine and gets a confirmation with a working manage link** (end of Milestone 2) and **(2) the front desk runs a full Saturday from one screen: books a walk-in, checks a client in, pushes a late column, and rescues a sick stylist's day without one silent cancellation** (end of Milestone 3).

**Numbering.** `A-` numbers are global, continuous, permanent — never renumbered, never reused (`B-` = storage, `R-` = rental). Rows added later carry a letter (`16a`). Sizes: **S** ≈ short session, **M** ≈ one focused session, **L** ≈ 2–3 sessions. ✅ = built and committed. One item per session, top to bottom; the loop is in `docs/START-HERE.md`.

---

## Milestone 1: Foundation

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
|---|---|---|---|---|---|---|
| 1 | ✅ A-000 | PRD set, decision log, reviews, this backlog, CLAUDE.md, failing slot-engine spec suite — delivered as the project starter | — | — | — | MVP |
| 2 | ✅ A-001 | Monorepo & app scaffold: Next.js (App Router) + TS, Tailwind/shadcn, Prisma + **Postgres** (docker-compose; port **3300** as config default), Vitest/Playwright + axe, CI (migrations-from-scratch + drift check + suite under `TZ=Pacific/Kiritimati` AND `TZ=UTC`), the gate command, `.env` handling | D-1, D-3 | M | A-000 | MVP |
| 3 | ✅ A-002 | **`packages/core/time`**: `CalendarDay`/`WallTime`/`Instant` branded types, the single conversion module with three-armed `resolve()`, injectable clock, lint bans on axis-crossing syntax. TDD against spec §§1–3 (facts, DST resolution cases). The starter's `types.ts` is the contract | D-3; SLOT-02 | M | A-001 | MVP |
| 4 | ✅ A-003 | Core data model & migrations: every §8 entity, **the exclusion constraint in hand-written SQL**, stored `blockedStart`/`blockedEnd`, half-open ranges, append-only `AppointmentEvent` trigger, D-12 schema affordances (`ServiceSegment`, `ResourceType`, `AppointmentServiceLine`), `businessId` everywhere, no `payment_status`. **Before writing the schema, show the owner the entity list + constraint SQL and wait for confirmation.** **Per D-15..D-21:** constraint predicate `status NOT IN ('cancelled','cancelled_late')` derived from the status module; `overriddenFromRange tstzrange` (NOT NULL exactly for overrides); `Client.phone` indexed **not unique**, name/phone/email nullable; `Appointment.clientId` nullable; `AppointmentServiceLine.priceCents`/`durationMinutes` snapshotted; the three `SlotPolicy` flags + `bookingHorizonDays` on `Business`; `Service.cancellationCutoffMinutes` nullable; `Provider.active`/`displayOrder`; `Appointment.idempotencyKey` unique; `Appointment.startDay CHAR(10)`/`startWallTime CHAR(5)`; `WaitlistEntry.status`; CHECK that all four instants land on whole minutes. Constraint tests write directly against the database, bypassing the app, and include **both** a `cancelled` and a `cancelled_late` row failing to block a rebooking of the identical range | §6, §8; D-2, D-12, D-13, **D-15..D-21** | L | A-002 | MVP |
| 5 | ✅ A-004 | Notification outbox + `ChannelAdapter` with logging adapter; idempotent enqueue on dedupe key; kill switch + sandbox redirect. Built before its first sender | NOTIF-01; D-14 | M | A-003 | MVP |
| 6 | ✅ A-005 | Staff session (single credential) + `actor` stamped on every mutation; staff routes refuse unauthenticated requests | D-9 | S | A-001 | MVP |

## Milestone 2: The booking loop (Golden Path 1)

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
|---|---|---|---|---|---|---|
| 7 | A-025 | **Business & provider setup**: owner settings (timezone, slot interval, lead time, cutoff, no-show threshold, `bookingHorizonDays`, the three `SlotPolicy` flags), provider CRUD with `active` + `displayOrder`, provider deactivation running the AVAIL-05 impact preview. *Nothing in the backlog created a `Provider` or a `Business` before this row — the seed made them, a paying customer cannot* | §8; D-9, D-11, D-19, D-21; SVC-03 (provider half) | M | A-003, A-005 | MVP |
| 8 | ✅ A-008 | **Slot engine (PURE)** — the core learning artifact. `computeSlots(SlotQuery) → SlotResult` per the starter's `types.ts`. Make the pre-written red suite (`slot-engine.test.ts`) green, then extend to the full spec §3 matrix + §2 invariants incl. fast-check property tests. **No database, no adapter, no `daysWithAvailability`** — the query takes plain data, so this needs nothing from A-006/A-007. Definition of done = the matrix under `TZ=UTC` AND `TZ=Pacific/Kiritimati`, not the PRD sentence | SLOT-01..06, 08 | L | A-002, A-003 | MVP |
| 9 | A-006 | Service catalog: CRUD, per-provider qualification with duration/price overrides, deactivation-with-future-appointments flow | SVC-01..03 | M | A-003, A-005 | MVP |
| 10 | A-007 | Availability model: weekly windows (+breaks as children, `endsNextDay`), `DateOverride` parent with `isClosed`, time off / ad-hoc blocks as instant intervals, business hours ∩ provider hours, the fixed precedence chain | AVAIL-01..04 | L | A-003, A-002 | MVP |
| 11 | A-026 | **Availability → `SlotQuery` adapter**: the busy-set query (instant-overlap predicate, `COALESCE("overriddenFromRange", tstzrange(...))` per D-16 — never `WHERE date(startAt) = day`), window resolution from A-007's precedence chain, `daysWithAvailability(provider, service, month)`, `bookingHorizonDays` cap on self-serve only | SLOT-07; D-16, D-20, D-21 | M | A-006, A-007, A-008 | MVP |
| 12 | A-009 | Booking write path: transaction re-runs engine, `23P01 → SlotTaken → 409` with refreshed alternatives, idempotency key, confirmation via outbox with manage-link placeholder; **all eight deterministic race tests** (spec §4.5's eight interleavings) + the nightly SQL-invariant fuzz | BOOK-02, 03, 06; D-2 | M | A-008, A-026, A-004 | MVP |
| 13 | A-010 | Customer booking flow UI: ≤5 screens / ≤3 required inputs, phone-first identity, instant-keyed slot POST, WCAG 2.1 AA incl. keyboard slot grid + live region (axe in the spec) | BOOK-01; D-4, D-10 | M | A-009 | MVP |
| 14 | A-011 | Seed script per §9 spec: fixed anchor spanning both DST transitions, per-provider density targets, unequal buffers everywhere, deterministic | §9 | S | A-009 | MVP |

> **Demo checkpoint 1.** Against the seed: a customer picks a colour with Dana, sees Tuesday's slots with the 12–1 break absent and 11:15 first after the 10:00 booking, books, and the outbox holds one confirmation with a manage link. The scripted race for an *overlapping non-identical* slot yields exactly one winner and a 409 with alternatives. A direct SQL insert of an overlapping appointment is refused by the database. The suite passes under `TZ=Pacific/Kiritimati`. **Walk it when the milestone closes, not when convenient** — rental D-28: all four of its checkpoint-1 defects were invisible from inside the items that introduced them.

## Milestone 3: Running the day (Golden Path 2)

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
|---|---|---|---|---|---|---|
| 15 | A-012 | Appointment state machine: 8 states, the §7 table as one parameterised test over all pairs, terminal corrections (staff, ≤7d, reason), busy-set membership per D-7, append-only event log wired to every transition | APPT-01, 05, 06, 07; D-7 | M | A-009, A-005 | MVP |
| 16 | A-013 | Manage token: scoped, multi-use to `end + 24h`, revoke-on-reissue, rate-limited, lexicon test (no internal identifiers) | TOKEN-01..03; D-5, D-10 | M | A-012, A-004 | MVP |
| 17 | A-014 | Reschedule: same-row update in one transaction, engine re-run inside, both-sides event, cutoff applies to token actor, token re-points | APPT-05; D-6, D-11 | M | A-013 | MVP |
| 18 | A-015 | Client record: phone-keyed, merge-with-history, client notes (pinned) + appointment notes, history view, "rebook last visit" | CLIENT-01..03 | M | A-012 | MVP |
| 19 | A-016 | Staff day grid: column per provider, time gutter, now-line, status colours, clickable gaps with lengths, client chips (phone, flags, pinned note), 30s-bound staleness (e2e-tested), single-provider list view for a stylist's own day; **WCAG 2.1 AA including full keyboard operability of the grid + axe in the spec** (the front desk types faster than it mouses) | BOOK-04 (view half); Goal 3 | L | A-012, A-015, A-007 | MVP |
| 20 | A-027 | **Appointment detail panel**: the plain-language event log (APPT-07), pinned client notes on every render (CLIENT-03), override marker + reason (BOOK-05), per-appointment outbox history ("was she actually told?"), status controls, conflict marker. *Four stories require this screen and no row built it* | APPT-07; CLIENT-03; BOOK-05; D-8 | M | A-012, A-015, A-016 | MVP |
| 21 | A-017 | Staff booking & override: from-the-grid booking, partial phone/name search, walk-in-now, no-client booking, override paths (outside hours / into buffer / knowing double-book) each with reason + audit + zero-width-range mechanics | BOOK-04, 05; D-8 | M | A-016 | MVP |
| 22 | A-018 | Check-in & running late: `checked_in`/`in_progress` with actual timestamps, per-column running delta, projected starts, "push column from here" with collision preview + outbox notice; same-day slot computation consumes the delta | APPT-03, 04 | M | A-016, A-012 | MVP |
| 23 | A-019 | Availability-change impact workflow: preview conflicts on any hours edit / time off / block / deactivation, per-appointment actions, bulk "reassign Saturday to Priya where qualified," conflict markers, nothing silent | AVAIL-05 | M | A-016, A-007 | MVP |

> **Demo checkpoint 2.** Saturday, seeded: front desk books a walk-in from the grid in the 2:15 gap; checks in the 10:00 who arrived at 10:12; Dana runs +38 and the column shows projected starts; "push from 2pm" previews the 4:30 collision with close and staff resolves it; Dana calls in sick → time off entered → nine conflicts listed with phones → three reassigned to Priya, six kept-flagged; a customer opens the manage link, reschedules, then cancels with the same link; a `no_show` mis-tap is corrected to `completed` with a reason; every one of those actions is in the event log in plain language.

## Milestone 4: The revenue leak

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
|---|---|---|---|---|---|---|
| 24 | A-020 | No-show & late-cancel machinery: `cancelled_late` split enforced at the cutoff, rolling 12-month client counts with references, flags on every client surface, self-serve block after N with staff bypass | CLIENT-04; OQ-3 | M | A-015, A-012 | MVP |
| 25 | A-021 | Confirm loop: confirm via manage link and staff manual-confirm, `confirmed_at`, unconfirmed-tomorrow call-down view; no auto-cancel ever | APPT-02 | S | A-013, A-016 | MVP |
| 26 | A-022 | Reminder job: 24h-window instant arithmetic, exactly-once, idempotent, skips terminal/rescheduled-away, DST-window test, confirm/cancel actions on the link | NOTIF-02, 03 | M | A-004, A-013, A-011 | MVP |
| 27 | A-023 | Waitlist, staff half: entries (service/providers/range/day-parts), fit-aware matching against a freed interval, "who wants this slot?" panel on any freed slot. Automated offers gated on OQ-4 | WAIT-01, 02 | M | A-020 | MVP |
| 28 | A-024 | Owner dashboard: bookings, cancels split normal/late, no-shows by provider, utilization to the frozen RPT-02 formula (exact seeded constant asserted), every tile drills to a filtered list | RPT-01..03 | M | A-011, A-020 | MVP |

> **Demo checkpoint 3.** The reminder run against the seed produces exactly one outbox row per eligible appointment and zero for the cancelled ones; re-running it adds nothing. A 2pm cancellation lights the waitlist panel with the two entries that actually fit. The dashboard's utilization for provider P week W equals the frozen constant, and the late-cancel tile drills to the two seeded offenders.

## Phase 3 (post-v1, in rough order)

Segmented durations (processing gaps as bookable provider time) → resource pools (chairs/rooms) consumed by the engine → multi-service visits in the booking flows (schema is already plural) → multi-provider chains → real Resend/Twilio adapters behind the existing seam → multi-user staff auth + roles → recurring appointments ("every 4 weeks") → tzdata-drift reconciliation job (spec X-5). The first three exist as D-12 schema affordances precisely so none of them is a migration.
