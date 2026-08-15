# 04 — Product Owner Review at the Milestone 1 Boundary

**Reviewer:** second, independent PO (B2B SaaS / marketplace scheduling). **Reviewed:** 2026-08-14, at the A-002 → A-003 boundary.
**Scope:** backlog gaps, sequencing, and anything A-003 is about to freeze into the schema. Builds on `02-product-owner-review.md`; does not repeat it.

---

## Verdict

The product definition is in unusually good shape — better than the first PO review left it, and the decision log is doing real work. My findings are not about missing features. They are about **eight things A-003 is about to freeze that three documents currently disagree on or omit**, and one of them (the override / busy-set interaction, P0-2 below) lets a customer create the exact accidental double-booking that Goal 2 promises is impossible.

The single most consequential finding: **`docs/reviews/03-slot-engine-spec.md` §4.2's literal constraint SQL is wrong for this product now**, because it predates D-7's `cancelled_late` split. The spec is marked normative and A-003's session prompt (`docs/START-HERE.md:36`) says to show the owner "the exact SQL of the exclusion constraint." Copying it ships a constraint where every late cancellation blocks its own slot forever.

---

## What is already right and needs no change

- **D-2/D-8 together are the best piece of design in the repo.** Absolute constraint + modeled override is the correct resolution of the operator's "every platform I abandoned died of a flat refusal," and it is rare to see it done without dropping the constraint.
- **D-6 (same-row reschedule)** and its four documented failure modes. Nothing to add.
- **The A-002 `resolve()` round-trip discrimination** (`packages/core/time/zone.ts:59-81`) is genuinely non-obvious work, correctly reasoned, and the PROGRESS entry explains why the naive version cannot work. Keep that standard of write-up.
- **RPT-02's frozen utilization formula**, **NOTIF-01's seam-before-sender**, and **the seed's fixed anchor** are all the right calls and are already specified tightly enough to build.
- The first PO review's accepted recommendations have, with the three exceptions listed in §5, landed properly.

---

## 1. P0 — blocks A-003

### P0-1. The exclusion constraint's partial predicate is specified three different ways, and only one is right

| Source | Predicate |
|---|---|
| `03-slot-engine-spec.md:474` (marked **normative**) | `WHERE (status <> 'cancelled')` |
| `07-decisions.md` D-2 | `WHERE status NOT IN (terminal set)` |
| `CLAUDE.md:27,38` | "partial over active statuses" + "only `cancelled`/`cancelled_late` free it" |

The spec's version leaves `cancelled_late` blocking its slot permanently — the salon late-cancels a Saturday colour and can never rebook it, which is precisely the perishable-supply loss the waitlist exists to recover. D-2's version is worse: D-7's terminal set is `{completed, no_show, cancelled, cancelled_late}`, and excluding `completed`/`no_show` from the constraint directly contradicts CLAUDE.md's "`no_show` and `completed` still occupy their time."

**Why it matters:** this is the repo's own "a status enum is never one edit" trap, already realised — in the documents, before a single row exists.

**Fix:** record **D-15** fixing the predicate as `status NOT IN ('cancelled','cancelled_late')`, derived in code from the one status module, and add a note in `03-slot-engine-spec.md:474` that its literal SQL is superseded.

### P0-2. A staff override makes the slot bookable by a customer — Goal 2 fails

D-8: an override booking writes `blockedStart = blockedEnd`, which is an **empty** `tstzrange` and therefore participates in no `&&`. Correct — the constraint is satisfied. But CLAUDE.md's busy-set predicate is `blockedEnd > windowStart AND blockedStart < windowEnd`, which **returns the override row as a zero-width `BusyInterval`**. A zero-width interval subtracts nothing from the grid, so `computeSlots` offers that time to the public booking flow.

Sequence: staff knowingly double-books Dana at 2pm (correct, audited, D-8) → the website offers Dana 2pm → a customer books it → Dana is triple-booked and the third one was **accidental**. That violates §2 Goal 2 and D-8's own "customer self-serve can never create a conflict."

CLAUDE.md:32 says the override's true range is rendered by "the day view." The engine is the reader nobody listed.

**Fix:** record **D-16**. `overriddenFromRange` is a `tstzrange` column, `NOT NULL` exactly when the row is an override, and the busy-set query returns `COALESCE("overriddenFromRange", tstzrange("blockedStart","blockedEnd",'[)'))`.

### P0-3. `Client` phone must not be unique, and one client may hold overlapping appointments (answers OQ-2)

CLIENT-01 says "`Client` keyed on normalized phone." A unique index makes a mother and her teenage daughter **one client**: shared history, merged allergy notes (CLIENT-03 calls that a safety surface), and one rolling no-show counter — so the daughter's two no-shows block the mother from self-serve booking under CLIENT-04. That is a support call in the first month, and unwinding a unique index after records have merged is a data-repair problem, not a migration.

The overlapping-appointment half is simpler than it looks: mum with Dana and daughter with Priya at the same 2pm is *routine salon traffic*, and there is no provider conflict at all. A client-axis exclusion constraint would refuse it.

**Fix:** record **D-17**. Phone is indexed, not unique; lookup returns a list and staff choose-or-create. No client-axis conflict check; the staff booking surface shows a soft "this client already has an appointment then" note. Name/phone/email nullable.

### P0-4. `AppointmentServiceLine` must snapshot the price, or every historical report is retroactively wrong

CLIENT-02 requires client history showing "date, provider, service, price"; RPT-01 drills into filtered lists. Price lives on `Service` and is overridden on `ServiceProvider`. If the line does not snapshot `priceCents` at booking time, the owner raises prices in January and **last year's history and every report change**.

This does not contradict D-13. D-13 rejects an always-null `payment_status` enum; a snapshotted agreed price is a value the booking flow actually writes on every row, and it is unbackfillable — the old price is gone.

**Fix:** record **D-18**. `AppointmentServiceLine` carries `priceCents` and `durationMinutes` snapshotted at write time.

### P0-5. `SlotPolicy`'s three flags and the per-service cutoff have no home in §8

`packages/core/scheduling/types.ts:52-56` already defines `SlotPolicy { bufferMayOverlapBreak, bufferMayExtendPastClose, ambiguousLocalTime }`, and SLOT-04 calls them "policy flags, default true." `00-master-prd.md:153` lists `Business`'s policies as "slot interval, lead time, cutoff, no-show block threshold" — none of the three appear. Separately, D-11 mandates the resolver `service.cutoff ?? business.cutoff`, but SVC-01's field list has no cutoff field.

**Fix:** record **D-19**. Three `SlotPolicy` columns on `Business`; `Service.cancellationCutoffMinutes` nullable.

### P0-6. `Appointment.clientId` must be nullable

BOOK-04 requires booking "with no client record ('walk-in, no name', identity attached later)." One character now; a migration plus a nullability change on a hot foreign key later.

### P0-7. Two of the eight race interleavings are missing from BOOK-03

`03-slot-engine-spec.md:553-562` lists **eight** interleavings. BOOK-03 and A-009 both say "six." Missing:

- **#5 — a cancelled row does not block a rebooking of the same range.** This is the test that proves the partial predicate. It belongs to **A-003's** direct-to-database constraint tests, not A-009, and given P0-1 it must be run for `cancelled` *and* `cancelled_late`.
- **#6 — reschedule vs. new booking targeting the same destination slot.** Also carries the first PO review's defect-16 acceptance criterion, which never landed in text.

### P0-8. `npm test` cannot reach the database

Root `package.json:21` is `"test": "vitest run"` with no `dotenv -e .env.test -e .env.local`. A-003's first requirement is constraint tests that "write directly against the database, bypassing the app" — they will have no `DATABASE_URL`.

**Fix:** `"test": "dotenv -e .env.test -e .env.local -- vitest run"`.

---

## 2. P1 — before Milestone 1 closes

**P1-1. `A-008` is falsely blocked behind two CRUD items — move it to the front of Milestone 2.**
A-008 depends on `A-002, A-006, A-007, A-003`. But `computeSlots(SlotQuery)` is a pure function over plain data. It touches no catalog and no availability implementation — the 37 pre-written tests construct those literals directly. Only `daysWithAvailability(provider, service, month)` and the query-builder need the database. Split it (A-026) and move the pure half to position 7.

**P1-2. Nothing in the backlog creates a `Provider` or a `Business`.**
There is no PROV epic and no settings epic. The seed makes providers; a paying customer hires one. **New item A-025**, positioned before A-006.

**P1-3. Provider deactivation is missing** — first PO review's accepted defect-19 fix, only half-landed. A stylist quitting with three weeks booked has no `Provider.active` field or story. Folds into A-025.

**P1-4. `Client` PII fields should be nullable so a deletion request can be served.**
With `AppointmentEvent` append-only by trigger and FKs `onDelete: Restrict`, there is **no deletion path in this schema at all**. Make anonymize-in-place possible rather than discovering at request time that the only options are "refuse" or "break the audit log."

**P1-5. `WaitlistEntry` is created in M1 for a feature in M4, with no lifecycle fields.**
Add `status ∈ {active, fulfilled, expired, cancelled}` + `createdAt`, or the panel fills with stale rows the front desk learns to ignore.

**P1-6. Store the business calendar day and wall time alongside `startAt`.**
RPT-02 is "per provider per business date" and the day view groups by business date. Two cheap `CHAR(10)`/`CHAR(5)` columns (the D-3-approved shape) make the grouping trivial. It also gives Phase 3's tzdata-drift job (spec X-5) something to reconcile against. Written by the same code that writes `blockedStart`/`blockedEnd`, guarded by the nightly invariant query.

**P1-7. The reminder dedupe key must include the target instant.**
Key on `reminder-24h:{appointmentId}:{startAtEpochMs}`, or an appointment rescheduled into an already-processed window is never reminded.

**P1-8. "Any provider" has no assignment rule.**
**Recommend:** fewest booked minutes that business date among qualified providers, ties broken by `Provider.displayOrder` — deterministic, therefore testable. `displayOrder` is a column, so it belongs in A-003.

**P1-9. Time off created concurrently with a booking is invisible to AVAIL-05.**
Fix in A-007/A-019, no schema cost: the time-off insert re-selects overlapping non-terminal appointments **inside its own transaction**.

**P1-10. Missing surface: the appointment detail panel.** APPT-07, CLIENT-03, BOOK-05 and TOKEN/NOTIF all require a screen no backlog item builds. **New item A-027.**

---

## 3. P2 — before v1 ships

**P2-1. `bookingHorizonDays` (OQ-6) — recommend 90, not 60, and self-serve only.** CLIENT-02 names "6 weeks for colour"; a client rebooking at checkout three days late on an 8-week cycle needs day 59+. At 60 the highest-conversion moment in the business fails.

**P2-2. WCAG is an acceptance criterion on BOOK-01 only.** Add keyboard operability + axe to A-016's AC — the front desk types faster than it mouses.

**P2-3. `Client` consent timestamp.** One nullable `smsConsentAt: timestamptz` written by the booking form; it cannot be backfilled.

**P2-4. BOOK-06 has no behaviour for a recipient-less booking.** Recommend: enqueue is skipped, an `AppointmentEvent` records why, never an error.

**P2-5. D-10's "one formatter for customer-facing times" has no implementation home.** One `formatForCustomer(instant, zone, {ambiguous})` in the time module when A-010 needs it.

---

## 4. P3

- `docs/START-HERE.md:12-14` omits the `RELEASE_NOTES.md` step that `CLAUDE.md:13` makes part of the after-item ritual.
- `db:reset:test` has no seed step. Add with A-011.

---

## 5. First PO review recommendations that did NOT land

| Ref | Recommendation | Status |
|---|---|---|
| Defect 19 | "Add provider deactivation as its own criterion" | **Not landed.** → P1-3 |
| Defect 16 | AC: reschedule loses the race → original unchanged and still `booked` | **Half landed.** Mechanism in D-6; AC in no story. → P0-7 |
| OQ-16 | WCAG 2.1 AA on **A-011 and A-016** | **Half landed.** BOOK-01 only. → P2-2 |

---

## 6. New backlog rows

### Insert into Milestone 2, as row 7 (before A-006)

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
|---|---|---|---|---|---|---|
| 7 | A-025 | Business & provider setup: owner settings (timezone, slot interval, lead time, cutoff, no-show threshold, booking horizon, the three `SlotPolicy` flags), provider CRUD with `active` + `displayOrder`, provider deactivation running the AVAIL-05 impact preview | §8; D-9, D-11, D-19; SVC-03 (provider half) | M | A-003, A-005 | MVP |

### Replace A-008's row with two

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
|---|---|---|---|---|---|---|
| 8 | A-008 | **Slot engine (pure)** — `computeSlots(SlotQuery) → SlotResult`. Make the pre-written red suite green, then the full spec §3 matrix + §2 invariants as property tests. **No database, no adapter.** | SLOT-01..06, 08 | L | A-002, A-003 | MVP |
| 11 | A-026 | Availability → `SlotQuery` adapter: busy-set query (instant-overlap predicate, `COALESCE(overriddenFromRange, …)` per D-16), window resolution from A-007's precedence chain, `daysWithAvailability`, horizon cap | SLOT-07; D-16, D-20 | M | A-006, A-007, A-008 | MVP |

*Why:* the highest-value item, with 37 tests already written and zero database dependency, currently sits behind two CRUD surfaces that will be built against an unvalidated `SlotQuery`. Building it right after A-003 also means one session holds both the constraint's status predicate and the busy-set's status predicate in mind.

### Insert into Milestone 3, after A-016

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
|---|---|---|---|---|---|---|
| 18 | A-027 | Appointment detail panel: plain-language event log, pinned client notes, override marker + reason, per-appointment outbox ("was she actually told?"), status controls, conflict marker | APPT-07; CLIENT-03; BOOK-05; D-8 | M | A-012, A-015, A-016 | MVP |

---

## 7. Adjustments to existing rows and acceptance criteria

See §6 of the review conversation for the full before/after text. Summary of edits:

- **A-003 row** — append the D-15..D-20 schema requirements and the both-cancelled-states constraint test.
- **BOOK-03** — add interleavings (g) cancelled/cancelled_late do not block a rebooking, and (h) reschedule vs new booking.
- **A-009 row** — "six deterministic race tests" → "**eight**".
- **CLIENT-01** — phone indexed **not unique**; name/phone/email nullable.
- **SVC-01** — add `cancellationCutoffMinutes?`, `displayOrder`.
- **SVC-02** — add the "any provider" assignment rule.
- **§8 entity list** — add `overriddenFromRange`, `idempotencyKey`, `startDay`/`startWallTime`, `WaitlistEntry.status`, `SlotPolicy` flags, `bookingHorizonDays`.
- **`03-slot-engine-spec.md:474`** — inline note that the literal SQL is superseded by D-15.
- **A-016 row** — WCAG 2.1 AA incl. full keyboard operability + axe.

---

## 8. Open questions that must become decisions before A-003

| Proposed | Question | **Recommended** | Alternative, and its one-line consequence |
|---|---|---|---|
| **D-15** | The constraint's partial predicate (P0-1) | **`status NOT IN ('cancelled','cancelled_late')`, derived in code from the single status module** | `<> 'cancelled'`: every late cancellation blocks its own slot forever and the waitlist has nothing to fill. |
| **D-16** | Does the engine consume `overriddenFromRange`? (P0-2) | **Yes — busy-set returns `COALESCE(overriddenFromRange, tstzrange(blockedStart,blockedEnd,'[)'))`** | No: after any staff override the public flow offers that time, and a customer creates the accidental double-book Goal 2 forbids. |
| **D-17** | OQ-2 — shared phones and overlapping client appointments | **Phone indexed not unique; overlaps allowed; no client-axis constraint; soft warning on staff surface** | Unique phone + client-axis check: a household is one client with merged allergy notes and a shared no-show block. |
| **D-18** | Price/duration snapshot on `AppointmentServiceLine` (P0-4) | **Snapshot both at write time** | Reference live: a January price rise silently rewrites last year's history and every report. |
| **D-19** | Where `SlotPolicy` and the per-service cutoff live (P0-5) | **Three flags on `Business`; `Service.cancellationCutoffMinutes` nullable** | Hardcode in the engine: SLOT-04's "tests on both arms" is untestable and the fix is a migration. |
| **D-20** | OQ-1 — is the chair a v1 constraint axis? | **No. Provider-only for v1; D-12's affordance stays unconsumed. Seed roster must never exceed chair count** | Yes: a second axis on a live exclusion constraint before the one-resource engine is green. |
| **D-21** | OQ-6 — booking horizon | **90 days, `Business.bookingHorizonDays`, self-serve only; staff uncapped** | 60 days: the 8-week colour client cannot pre-book at checkout. |

OQ-3, OQ-4 and OQ-5 do not gate A-003 and are correctly parked.

---

## 9. Already built (A-001 / A-002) that will cause product pain

**9-1. `wallTime()` does not normalize, so one wall time has two non-equal representations.**
`packages/core/time/types.ts:54-64` accepts `HH:MM` *and* `HH:MM:SS` and returns the input unchanged, while `toLabel` emits minute precision. So `wallTime('09:00:00') !== wallTime('09:00')` — both valid, both the same time, and any `===`, `Set`, `Map` key or dedupe on a `WallTime` is subtly wrong. Once A-003 stores `WeeklyWindow.open` there are two forms in the database. **Fix now:** normalize to `HH:MM` in the constructor and store `CHAR(5)`.

**9-2. `Instant` is millisecond-precision and nothing pins slot instants to whole minutes.**
Half-open `[start, end)` back-to-back booking depends on `A.blockedEnd === B.blockedStart` *exactly*; one stray millisecond turns "back-to-back" into a false conflict or a 1ms hole, with every test green. **Fix in A-003:** a CHECK that all four instants are whole minutes, plus a `minuteInstant` guard at the API boundary.

**9-3. `npm test` loads no env** — see P0-8.

Nothing else in A-001/A-002 is a product liability. The lint bans, the four-timezone verification, and the removal of the last `Date.parse` are all better than the backlog asked for.
