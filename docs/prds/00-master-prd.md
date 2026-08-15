# 00 — Master PRD: Bookable — Appointment Scheduling for a Service Business

**Sample business:** "Shear Genius," a 4-chair salon (works equally for med spa, tutoring; HVAC needs the resource model)
**Builder:** Solo, in Claude Code · third project in the idiom (after storage `B-` and rental `R-`)
**Status:** v1.0 — 2026-08-14. Supersedes `prd-bookable-appointment-app.md` (draft v1), which is retained for history.
**Precedence:** `07-decisions.md` amends this document. Where they conflict, the decision log wins.
**Learning objectives:** availability computation, conflict detection, time-zone-safe datetime handling, state transitions, notification triggers — the feature families absent from the storage/rental builds.

This PRD was produced by putting draft v1 through three reviews (`docs/reviews/`): a service-business operator, a product-owner craft review, and a scheduling-domain correctness specification. Their findings are incorporated below; where a recommendation was *rejected*, the rejection and reason are recorded in `07-decisions.md`, not silently dropped.

---

## 1. Problem statement

Service businesses lose revenue to phone tag, double-bookings, and no-shows. Staff spend hours daily managing a paper or spreadsheet calendar, and customers can't see availability or book outside business hours. The deeper failure mode — the one that kills booking software after it is adopted — is that the *book stops matching reality*: appointments run late, walk-ins arrive, a stylist calls in sick with nine appointments booked, and the moment the screen can't answer "when is she actually getting to me," the paper book comes back out and the software is dead.

So the product has two jobs, and v1 must do both: **(1)** a correct, race-proof availability and booking engine, and **(2)** a staff surface that survives a busy Saturday — staff booking as a first-class path, check-in and running-late as modeled facts, and never a silently moved or cancelled appointment.

## 2. Goals

1. A customer can find and book an open slot in **at most 5 screens and 3 required text inputs**, with no page reloads, without staff involvement. (Measured by an e2e spec asserting the step count — not a stopwatch.)
2. **Zero accidental double-bookings**: the *database* refuses conflicting bookings (exclusion constraint), so conflict-free is a property of the system, not of the code paths that happen to check. Staff may knowingly override with a reason, and the override is recorded (D-8).
3. Staff can run a full day — see all providers, book, check in, push a late column, resolve a sick-day — from one screen.
4. The reminder/confirmation loop is built and provably correct against a seeded dataset: exactly one reminder per eligible appointment, never for cancelled ones, correct across DST boundaries. (Draft v1's "measurable no-show delta between seeded cohorts" is deleted — a seeded delta measures the seed script. See review 01, "Do not build.")
5. **(Builder goal)** Exercise scheduling logic, datetime edge cases, and status state machines, with the slot engine as the core learning artifact — built TDD against the edge-case matrix in `docs/reviews/03-slot-engine-spec.md`.

## 3. Non-Goals

Carried from draft v1, deliberately, with two additions:

- **Payments/deposits** — separate feature family; the rental build already exercises Stripe Billing. The no-show lever here is the client-history block (CLIENT-04), not deposits. No `payment_status` column is added "for later" (D-13).
- **Multi-location** — `businessId` is on every core table (cheap, real tenancy boundary); no location UI or logic.
- **Native mobile app** — responsive web.
- **Real SMS/email delivery** — every send goes through the notification outbox with a logging adapter (the D-15 seam from the rental build); real providers are a later one-line swap.
- **Customer accounts/login** — customers act via tokenized links only. The `Client` record is a server-side entity keyed on phone, which requires no login (CLIENT-01).
- **NEW: multi-provider service chains** ("colour with Dana, blow-dry with the assistant") — deferred to Phase 3. Single-provider multi-service visits ARE in scope as **VISIT-01** (settled in **D-23**; §10's Phase-3 line refers to the multi-*provider* case only).
- **NEW: named-seat resource assignment** — resources are capacity pools when they arrive (Phase 3); v1 carries the schema affordance only (D-12).

## 4. Personas

- **Customer** — books, confirms, reschedules, cancels via tokenized link. Never logs in.
- **Front desk / staff** — the primary user. Books on behalf of customers (most bookings), checks clients in, marks no-shows, pushes late columns, resolves availability changes. Authenticated (minimal single-credential session, D-9).
- **Provider (stylist)** — owns working hours, breaks, time off; runs their own column.
- **Owner/Admin** — configures services, providers, business hours, policies; reads reports. In v1 owner and staff share one credential; role separation is Phase 3.

## 5. Epics and stories

Story IDs are the authoritative acceptance criteria; backlog rows in `06-backlog.md` point here.

### SVC — Service catalog

- **SVC-01** Services have name, base duration (minutes), `bufferBeforeMinutes` (default 0), `bufferAfterMinutes`, price, active flag, assigned providers, `cancellationCutoffMinutes?` (D-11 resolver: `service.cutoff ?? business.cutoff`), `displayOrder`.
- **SVC-02** The provider×service assignment carries `durationOverrideMinutes?`, `priceOverrideCents?`. Slot computation uses the provider-specific duration; "any provider" search computes per provider. An unassigned provider never appears in that service's booking flow. For an **"any provider"** booking the appointment is assigned to the qualified provider with the **fewest booked minutes on that business date**, ties broken by `Provider.displayOrder` — deterministic, so an acceptance test can assert it, and load-balancing rather than always-the-first (which either tanks or overloads the senior stylist's book).
- **SVC-03** Deactivating a service (or unassigning a provider) with future non-terminal appointments: refused unless the actor confirms; on confirm, existing appointments remain valid and renderable with full status controls, cannot be rebooked into, and the affected list is shown to the actor at the moment of deactivation.

### AVAIL — Availability model

- **AVAIL-01** Weekly recurring working windows per provider, each `{open, close, endsNextDay, breaks[]}`. Breaks belong to the window, not the day. `close <= open` with `endsNextDay=false` is refused at write time.
- **AVAIL-02** Date-specific override = a parent `DateOverride { day, isClosed }` with child windows. An override **replaces** the weekly pattern for that date entirely (never merges); `isClosed=true` with no windows is representable and distinct from "no override." Two overrides on one date is a validation error.
- **AVAIL-03** Time off and ad-hoc blocks are instant-interval records that **subtract** from whatever pattern is in effect. Precedence chain, fixed: override-or-weekly → minus breaks → minus time off/blocks → minus buffered bookings → minus `[−∞, now + leadTime)`.
- **AVAIL-04** Business hours are a business-level weekly pattern + overrides (holidays). Effective availability = business hours ∩ provider hours − the chain above. A business-level holiday closes every provider's day, and an AC asserts it.
- **AVAIL-05 (impact workflow)** Any availability change that strands existing non-terminal appointments — time off, hours edit, block, deactivation — runs an impact preview first: the conflicting appointments with client names and phones, per-appointment actions (keep-flagged / reassign to a qualified provider / offer new time / cancel with notification). **Nothing is ever silently cancelled, moved, or hidden.** Conflicting-but-kept appointments render with a conflict marker until resolved.

### SLOT — Slot computation engine

The full correctness specification, function signature, and ~90-case edge matrix live in `docs/reviews/03-slot-engine-spec.md`, which is normative. Headlines:

- **SLOT-01** `computeSlots(query) → SlotResult` is a **pure function**: no I/O, no `Date.now()`, `now` is a parameter. Identical output under any process TZ (CI runs the suite under `TZ=Pacific/Kiritimati`).
- **SLOT-02** Rules are wall-clock (`CalendarDay`, `WallTime`); occurrences are instants. The two axes are branded types that cannot mix; exactly one module converts, and its `resolve()` returns `unique | gap | ambiguous` — never a bare instant (D-3).
- **SLOT-03** Grid anchored to window-open; slots are candidate *starts*, mutually overlapping (a 50-min service on a 15-min grid from a booking-free 9–5 window yields 29 starts, and one booking removes every start whose blocked range intersects it).
- **SLOT-04** Buffers: each appointment blocks `[start − bufferBefore, end + bufferAfter)`. The gap between two appointments honours *each one's own* buffer. Buffer may overlap a break and may extend past close (policy flags, default true); the service body may never do either.
- **SLOT-05** No slot in the past and none inside `minimumLeadMinutes`, which must be ≥ the cancellation cutoff (validated at startup) so a customer can never create a booking they are instantly unable to cancel.
- **SLOT-06** DST: spring-forward day offers no nonexistent labels and no duplicated instants; fall-back day offers the doubled hour as two distinct slots with `labelIsAmbiguous` and the offset shown. Slot identity in every URL, token, and payload is **the instant, never `{date, time}`**.
- **SLOT-07** A `daysWithAvailability(provider, service, month)` aggregate backs the date picker, derived from the same pure function.
- **SLOT-08** The engine's definition of done is the edge-case matrix: DST both directions, cross-transition bookings, midnight-crossing windows, leap day, buffer interactions, grid/duration non-dividing cases, degenerate input (throw vs empty per the spec's rule: malformed throws, semantically-empty returns `[]`).

### BOOK — Booking

- **BOOK-01** Customer flow: service → provider (or any) → date → slot → name + phone (email optional) → confirm. ≤5 screens, ≤3 required text inputs, no reloads. WCAG 2.1 AA is an acceptance criterion on this flow, including keyboard-only slot selection and a live region announcing recomputed slots.
- **BOOK-02** The write path re-runs the engine inside the transaction and the **database** enforces no-overlap: `EXCLUDE USING gist (providerId WITH =, tstzrange(blockedStart, blockedEnd) WITH &&)` partial over active statuses — `WHERE status NOT IN ('cancelled','cancelled_late')` per **D-15**, derived from the single status module — hand-written migration (D-2). Application code writes and maps `23P01` → domain `SlotTaken` → HTTP 409 with refreshed alternatives. A test provokes a real 23P01 and asserts the mapping; another inserts directly against the database, bypassing the app, and is refused.
- **BOOK-03** Race criteria (deterministic, barrier-based — spec §4.5): (a) identical slot → one 2xx, one 409; (b) overlapping non-identical slots → one succeeds; (c) buffer-only overlap → one succeeds; (d) loser's rollback releases the slot; (e) same slot, different providers → both succeed; (f) same idempotency key twice → same appointment, no duplicate; **(g) a `cancelled` row and a `cancelled_late` row each fail to block a rebooking of the identical range — this is the test that proves the D-15 partial predicate, asserted first in A-003 directly against the database and re-asserted here at the API; (h) reschedule vs. new booking targeting the same destination slot → exactly one wins, and the losing reschedule leaves its appointment unchanged and still `booked`.**
- **BOOK-04** Staff booking is first-class from the day view: client lookup by partial phone/name, walk-in "starting now" against next free provider, bookable with no client record ("walk-in, no name", identity attached later).
- **BOOK-05** Staff override: book outside hours, into a buffer, or as a knowing double-book — each requires a reason, writes an audit event, and renders with an override marker. Customer self-serve NEVER overrides. (The exclusion constraint still holds; overrides are modeled per D-8, not by dropping the constraint.)
- **BOOK-06** Every booking enqueues a confirmation through the notification outbox carrying the tokenized manage link.

### APPT — Appointment lifecycle

- **APPT-01** States: `booked → confirmed → checked_in → in_progress → completed`, with `no_show`, `cancelled`, `cancelled_late` as alternative terminals and `rescheduled` handled as an event, not a state (D-6). The **full transition table in §7 is normative** — every cell tested by one parameterised test over all pairs.
- **APPT-02** `confirmed` is real: set by the customer via the manage link (from the reminder or confirmation) or by staff ("spoke to her"). No reply never auto-cancels. Unconfirmed-tomorrow is a first-class staff view (the call-down list).
- **APPT-03** Check-in and in-progress capture `actualStartAt`/`actualEndAt` distinct from scheduled times. The day view derives a per-provider running delta ("Dana +38") and projects revised expected starts down the column.
- **APPT-04** "Push column from here": shift selected downstream appointments by N minutes with a collision preview (breaks, close, other holds); refuses silently-lossy shifts; records the change; can enqueue a "running ~30 min behind" outbox notification per affected client.
- **APPT-05** Customer cancellation inside the cutoff is refused for the token actor (offered as `cancelled_late` acknowledgement per policy), allowed for staff. Customer *reschedule* inside the cutoff is refused identically — a reschedule is a cancellation with extra steps.
- **APPT-06** Terminal corrections: staff only, `no_show ↔ completed`, within 7 days of appointment end, reason required, event recorded. Everything else terminal is terminal.
- **APPT-07** Every appointment carries an append-only event log (created, status change, reschedule with both sides, provider change, override, notification enqueued) with actor `staff | customer_token | system`, before/after, timestamp — rendered in plain language on the appointment detail. The outbox is queryable per appointment ("was she actually told?").

### TOKEN — Customer manage link

- **TOKEN-01** One token per appointment: scoped to that appointment only, grants confirm/reschedule/cancel and nothing else, **multi-use until expiry** at `appointment.end + 24h`, revocable by reissue (D-5 — the rental D-16 lesson, applied the same way for the same reason).
- **TOKEN-02** Reschedule re-points the existing token; it is never burned by use. A revoked, expired, or foreign token fails with a clear, non-enumerating message. The route is rate-limited (it returns PII).
- **TOKEN-03** No internal identifier — status enum, entity name, backlog ID — renders on any token-reachable route, and a test asserts it (D-10).

### CLIENT — Client record

- **CLIENT-01** `Client` is **looked up** by normalized phone — indexed, **not unique** (D-17): households share one number, and a unique index silently makes a mother and daughter one client with merged allergy notes and one shared no-show counter. Lookup returns a list; staff choose or create. Name, phone and email are all nullable, so BOOK-04's "walk-in, no name" is a real row and a deletion request is served by anonymizing in place — `AppointmentEvent` is append-only with `onDelete: Restrict` FKs, so there is otherwise no deletion path at all. One client may hold overlapping appointments (mum with Dana, daughter with Priya, both at 2pm) — no client-axis conflict check; the staff surface shows a soft "this client already has an appointment then" note. Email optional; no login. Staff merge duplicates (history follows the merge).
- **CLIENT-02** History on the client: date, provider, service, price, status — including no-shows and late cancels. "Rebook last visit" prefills provider + service and jumps the slot search to the natural interval.
- **CLIENT-03** Two note fields: long-lived client notes (formula, allergies — pinned on every appointment render) and per-appointment notes. Allergy note is a safety surface, not a convenience.
- **CLIENT-04** Rolling 12-month no-show and late-cancel counts with appointment references, surfaced everywhere the client appears. Policy: after N no-shows (config, default 3), self-serve booking is blocked with "call us" — staff can always book them. Marking no-show is reversible with a reason (APPT-06).

### VISIT — Multi-service visits (D-23)

- **VISIT-01** One appointment may carry several services with the **same provider**, in order ("cut then colour"). The body duration is the sum of the lines' durations; buffers **do not stack between lines** — only the first line's `bufferBeforeMinutes` and the last line's `bufferAfterMinutes` apply to the visit's blocked range. One `Appointment`, one ordered `AppointmentServiceLine` per service, each snapshotting its own `priceCents`/`durationMinutes` (D-18). The slot engine needs no change: a composed visit is simply a longer service. Booking two adjacent appointments is NOT the supported path and never was — their blocked ranges overlap once one service's `bufferAfter` meets the next one's `bufferBefore`, so the database refuses it, and routing staff through a knowing override on every combination booking would make D-8's override marker meaningless. Multi-**provider** chains stay Phase 3.

### NOTIF — Notifications

- **NOTIF-01** One outbox, one seam: every send is an outbox row (recipient, template, payload, dedupe key, status) written through a `ChannelAdapter`; v1 ships the logging adapter only. **No module hand-rolls its own sending** — the rental R-030 rule, enforced from item one because the confirmation email exists before the reminder job does.
- **NOTIF-02** Reminder job: for appointments in `{booked, confirmed}` starting in the window `[now+24h, now+24h+tick)`, exactly one reminder row, idempotent under re-run, none for cancelled/rescheduled-away appointments, correct across DST (fires at `start − 24h` **as an instant**; the local wall label may differ by an hour and a test pins that this is intended).
- **NOTIF-03** The reminder carries confirm/cancel actions via the token (APPT-02).

### WAIT — Waitlist (Phase 2)

- **WAIT-01** Entry = service + acceptable providers + date range + day-parts. Matching is against the *freed interval*: the service (at the provider's duration) must actually fit.
- **WAIT-02** v1 of the feature is the staff-facing "who wants this slot?" panel on any freed slot. Automated offer-with-soft-hold (30-min hold, roll to next) is the follow-on; the hold is invisible to self-serve and staff-overridable.

### RPT — Reporting

- **RPT-01** Owner dashboard: bookings, cancellations split normal/late, no-shows by provider, utilization. Every tile drills into the underlying filtered list.
- **RPT-02** Utilization formula, frozen: `Σ minutes of appointments in {completed, no_show} ÷ Σ (working minutes − breaks − time off)` per provider per business date; buffer minutes count in neither term; grid dead-zones count as unbookable, not idle; zero denominator renders "n/a", never 0%. The AC asserts an exact seeded constant (e.g. 62.5%), not "within 1% of hand-calculated."
- **RPT-03** Reschedules are excluded from the cancellation rate (they are events on surviving appointments, D-6).

## 6. What the database enforces

- **No-overlap is a constraint, not a convention**: the partial gist exclusion constraint on `(providerId, blockedRange)` over active statuses. Every code path — app, script, psql — is refused. Staff overrides are modeled (D-8), not exempted.
- **Half-open intervals `[start, end)` everywhere** — engine, range type, tests. Back-to-back appointments sharing an endpoint are legal.
- **`AppointmentEvent` is append-only** (trigger refuses UPDATE/DELETE, the rental pattern), and FKs into it are `onDelete: Restrict`.
- **`blockedStart`/`blockedEnd` are stored columns** written alongside `startAt`/`endAt`; verify whether a generated column is possible (`timestamptz + interval` immutability — spec §4.2) before hand-writing the trigger.
- Migrations containing the constraint and triggers are hand-written SQL; `prisma migrate` only, never `db push`; CI applies all migrations to a throwaway Postgres and runs the drift check (the rental CI pattern).

## 7. Appointment transition table (normative)

Rows = from, columns = to. ✓ = allowed (actor / precondition), · = refused. Actors: **S** staff, **C** customer token, **Y** system.

| from \ to | confirmed | checked_in | in_progress | completed | no_show | cancelled | cancelled_late |
|---|---|---|---|---|---|---|---|
| **booked** | ✓ S,C | ✓ S | ✓ S | · | ✓ S (only after `startAt`) | ✓ S any time; C outside cutoff | ✓ S; C inside cutoff per policy |
| **confirmed** | · | ✓ S | ✓ S | · | ✓ S (after `startAt`) | ✓ S; C outside cutoff | ✓ S; C inside cutoff |
| **checked_in** | · | · | ✓ S | ✓ S | · (they're here) | ✓ S | · |
| **in_progress** | · | · | · | ✓ S | · | ✓ S (walk-out, reason) | · |
| **completed** | · | · | · | — | ✓ S ≤7d, reason (APPT-06) | · | · |
| **no_show** | · | · | · | ✓ S ≤7d, reason | — | · | · |
| **cancelled** | · | · | · | · | · | — | · |
| **cancelled_late** | · | · | · | · | · | · | — |

Reschedule is not a column: it is an event on a surviving appointment (D-6), permitted from `booked`/`confirmed` only, gated by the same cutoff for the token actor.

## 8. §13-style canonical entities

`Business` (timezone, hours pattern, policies: slot interval, lead time, cutoff, no-show block threshold, `bookingHorizonDays` (D-21), and the three `SlotPolicy` flags `bufferMayOverlapBreak`/`bufferMayExtendPastClose`/`ambiguousLocalTime` (D-19)) · `Provider` (with `active`, `displayOrder`) · `Service` · `ServiceProvider` (qualification + overrides) · `ServiceSegment` (schema affordance only in v1 — one ACTIVE segment per service; D-12) · `ResourceType` / `Resource` (affordance only; D-12) · `WeeklyWindow` (+ `WindowBreak`) · `DateOverride` (+ child windows) · `TimeOff` / `AdHocBlock` (instant intervals) · `Client` · `Appointment` (+ `AppointmentServiceLine`, ordered, each snapshotting `priceCents`/`durationMinutes` at write time (D-18); v1 flows create one line, VISIT work makes it plural) — carrying `overriddenFromRange` (D-16), a unique `idempotencyKey`, nullable `clientId` (BOOK-04's walk-in), and `startDay CHAR(10)`/`startWallTime CHAR(5)` denormalized for business-date grouping in RPT-02 and the day view · `AppointmentEvent` (append-only) · `ManageToken` · `NotificationOutbox` · `WaitlistEntry` (with `status ∈ {active, fulfilled, expired, cancelled}` + `createdAt`, so stale entries leave the panel) · `StaffUser` (single credential v1).

Money is integer cents. UTC instants in the DB; `CalendarDay` stored as `CHAR(10)` strings, never `@db.Date` (D-3 — the rental R-042 lesson made structural).

## 9. Success metrics (all evaluated against the seeded dataset + gate)

- **Gate, not metric:** lint, typecheck, unit, e2e all green — including the full slot-engine matrix and the six race tests. 100%, part of the gate command.
- Double-booking: the nightly SQL invariant query (spec §4.5) returns 0 rows after the concurrency fuzz run.
- Slot correctness: the edge matrix passes byte-identically under `TZ=UTC` and `TZ=Pacific/Kiritimati`.
- Booking-flow headroom: ≥90% of 200 scripted (service, provider, day) attempts against the seed find ≥1 offerable slot — a property of the seed's density spec, asserted so the demo calendar is neither empty nor full.
- Reminders: exactly-once per eligible appointment; zero for cancelled; idempotent re-run; DST-window test.
- Utilization: seeded provider P, week W = the frozen constant from RPT-02.

**Seed spec (a P0 deliverable, built with the booking write path):** fixed anchor date spanning a spring-forward (fixture A) and fall-back (fixture B); 4 providers — one ~85% booked, one ~40%, one fully booked 3 consecutive days, one split-shift with mid-window time off; 8 services with differing buffers (never equal, so buffer bugs can't hide); ≥1 client with a no-show history; deterministic under a fixed random seed.

## 10. Phasing

See `06-backlog.md` for the ordered, dependency-checked backlog with milestones and demo checkpoints. Headline: Milestone 1 = foundation (docs, time module, schema+constraint, outbox seam, staff session); Milestone 2 = the booking loop end to end (Golden Path 1); Milestone 3 = running the day (lifecycle, tokens, day grid, staff booking, impact workflow — Golden Path 2); Milestone 4 = the revenue leak (confirm loop, reminders, waitlist panel, dashboard). Phase 3 (post-v1): segmented durations + resources (the schema affordances land in M1), multi-**provider** chains, real delivery adapters, roles. Single-provider multi-service visits are **v1**, as VISIT-01 (D-23).
