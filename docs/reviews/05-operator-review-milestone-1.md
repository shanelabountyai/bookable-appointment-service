# 05 — Operator Review at the Milestone 1 Boundary

**Reviewer:** service-business operator (4-chair salon + 6-room med spa owner; ex-ops manager, 14-van HVAC). **Reviewed:** 2026-08-15, at the close of Milestone 1 (A-001…A-005, A-008). **Lens:** operational, not requirements — see `docs/reviews/04-po-review-milestone-1.md` for the requirements pass; I do not repeat it.

> **Verification note (added by the build session, 2026-08-15).** Every load-bearing claim below was checked against the code and the live database before this file was committed. All confirmed:
> - R-1's engine claim — `ad_hoc_block` really does report `overlaps-time-off` (`slot-engine.ts`, the `else { hitsTimeOff = true }` branch). This is a defect in A-008 as shipped, not a hypothetical.
> - R-2 — `SELECT condeferrable FROM pg_constraint WHERE conname='appointment_no_overlap'` returns `f`.
> - R-3 — `minimumLeadMinutes` appears only in the engine and its types; D-11's `lead >= cutoff` validation exists nowhere.
> - R-4 — `NotificationOutbox` has no `appointmentId` column (only a mention inside a doc comment).
> - R-5 — `00-master-prd.md:36` says single-provider multi-service visits ARE in scope as VISIT-01; `:170` lists multi-service visits under Phase 3. VISIT-01 appears nowhere else in the repo.
> - R-6 — `Appointment` has no `notes` column; only `Client.notes` exists.

---

## Verdict

The foundation is the best-built thing I have reviewed in this idiom: the constraint is real, the engine is honest about DST, and the override design (D-8/D-16) is the first time I have seen "staff can knowingly double-book" implemented without dropping the constraint. But everything poured so far answers one question — *may this slot be sold?* — and nothing answers the question my front desk asks 200 times on a Saturday: *what is actually happening right now?* The schema can record that an appointment ran late (`checkedInAt`/`startedAt`/`endedAt`). It cannot record that **the day is currently running late**, and the engine has no vocabulary to be told.

---

## 1. The single most consequential gap (P0)

### R-1. "Running late" has no representation of its own, and the only lever the foundation gives you is the most expensive write in the system

**The scenario.** 11:05 on a Saturday. Dana started her 10:00 colour at 10:22 and she is 40 behind. The 11:15 cut is in the waiting area. A customer on the website is right now being offered Dana's 11:15, because `Appointment.blockedStart`/`blockedEnd` are written by trigger from `startAt`, the busy-set query reads those columns, and `startAt` still says 11:15. The screen says everything is fine. The receptionist writes "Dana +40" on a sticky note. That sticky note is the shadow calendar, and it appears in week two.

**Why this is a foundation problem and not an A-018 problem.** Three frozen artifacts push the wrong way at once:

- `packages/core/scheduling/types.ts` — `BusyInterval.kind` is frozen as `'booking' | 'time_off' | 'ad_hoc_block'`, and `ExclusionReason` has no term for a late provider. The adapter (A-026) *can* inject a synthetic interval to hold Dana's overrun — nothing structurally prevents it — but the engine maps every non-`booking` kind to `overlaps-time-off`. The staff explain surface will then answer "why can't I book 11:15?" with **"overlaps time off"** for a stylist who has no time off booked. A screen that explains itself wrongly is worse than one that does not explain itself; my staff stop reading it inside a week.
- There is nowhere to **store** the delay, so the adapter has nothing to read. Deriving it from `startedAt` only works when check-in discipline holds, and check-in discipline collapses at exactly the moment the delta matters — when the desk is three deep. A delta any staff member can set in one tap is the thing that survives a Saturday; a derived one is honest only on quiet days.
- The only remaining lever is APPT-04's "push the column", which rewrites `startAt` on every downstream appointment. That rewrite changes the time on the confirmation the client is holding, re-fires the blocked-range trigger row by row, and runs into R-2 below. It is the correct action *sometimes* — it should not be the only one.

**What it needs to do**
- Record a new decision (proposed **D-22**, does not supersede anything) settling that a provider's running-late state is first-class, scoped to `(providerId, businessDay)`, distinct from a reschedule, and consumed by the engine.
- Widen `BusyInterval.kind` with `'running-late'` and `ExclusionReason` with `'provider-running-late'` **before A-026 is written**, with a test asserting the reason for a candidate inside the overrun is exactly `['provider-running-late']` — not `not.toContain`.
- Store the delta as a value, not by rewriting `startAt`: one nullable per-provider-per-day minutes value (derived default from the in-progress appointment, manually settable and clearable in one tap, with actor + timestamp).
- Keep "push the column" as a separate, explicit, audited action that *does* rewrite `startAt` — the desk chooses when the book officially moves versus when it is merely behind.
- The self-serve path must consume the delta (a customer can never be sold time that no longer exists); the staff path shows the overrun as a marked, overridable region.

**Money/trust.** My own numbers: a 40-minute cascade on one Saturday column costs one to two walk-outs from the waiting area at $95–$180 each, plus the four conversations the receptionist has no data to answer. The trust cost is the real one — this is the specific omission that puts the paper book back on the desk.

**Backlog fit.** Decision now (before A-025); vocabulary inside **A-008's** contract file as a small amendment or at the head of **A-026**; storage and UI in **A-018**, unchanged in position.

**Confidence.** High. This is the same finding as recommendation 1 in `docs/reviews/01-operator-review.md`; the *lifecycle* half landed (states, `startedAt`/`endedAt`, APPT-03/04) and the *engine input* half did not.

---

## 2. What is already right — do not second-guess it

- **The exclusion constraint plus the modeled override.** Absolute constraint, zero-width range, `overriddenFromRange` for display and for the busy set. This is the correct answer to "every platform I abandoned died of a flat refusal," and it is done without a single weakening.
- **`blockedStart`/`blockedEnd` written by trigger, not by app code.** No script, no psql session, no future migration can write an inconsistent range. Better than what I have paid for.
- **`cancelled` *and* `cancelled_late` free the slot (D-15).** A late-cancelled Saturday colour is resellable. That single predicate is the difference between the waitlist having inventory and having nothing.
- **`Client.phone` indexed, not unique (D-17)**, and name/phone/email nullable. A household shares a number; a walk-in has no name. Both true on my floor.
- **Buffers and price snapshotted onto the appointment.** January's price rise will not rewrite last year's client history.
- **The engine takes `now` as a parameter and the whole suite runs under two timezones.** Nothing to add.

---

## 3. Operational risks in what is frozen

### R-2 (P1). The exclusion constraint is `NOT DEFERRABLE`, and every Saturday rescue is a multi-row rearrangement
Two clients trade times — "put Mrs. Hall at 2, move Jenny to 3", which is a routine desk move and becomes a one-second drag once A-016 ships — and there is no order of single-row updates that avoids a transient overlap; the transaction dies with `23P01`, which A-009 maps to **"that slot is taken"** while the desk is trying to *move* it. Same shape for any non-uniform column push.
- Add a migration making it `DEFERRABLE INITIALLY IMMEDIATE`. Single-row booking behaviour and all eight race interleavings are unchanged (still checked at statement end); only a deliberate `SET CONSTRAINTS ... DEFERRED` transaction defers.
- A-018/A-019's multi-row moves run in one transaction with the constraint deferred; the violation then arrives at COMMIT.
- `isSlotTakenError()` matches on the message string — assert it still fires on a *commit-time* violation, because that path has never been exercised.
- Until then, A-018 must issue ordered single-row updates (descending by `startAt` when pushing later, ascending when pulling earlier) and say so in a comment.
**Backlog fit:** new migration before A-009. **Confidence:** high on the mechanism; medium on frequency of true swaps — raise it by watching the first week of grid use.

### R-3 (P1). A per-service cancellation cutoff can exceed the business lead time, re-opening exactly the trap D-11 closed
D-19 gave `Service.cancellationCutoffMinutes` a home; D-11's startup validation compares only the business pair, and nothing in the repo implements it yet. Set colour's cutoff to 24h with a 2h lead — both entirely reasonable settings — and a client who books Saturday's colour at 8am for 10am is **structurally unable to cancel it**. She calls, the desk cancels for her, and her record now carries a late cancel she could not have avoided, which counts toward the CLIENT-04 self-serve block.
- Validate `minimumLeadMinutes >= max(business.cutoff, every active service.cutoff)` — enforced on the settings form *and* on service save, not at startup only.
- Test the trap directly: a service whose cutoff exceeds lead is refused at write time.
**Backlog fit:** inside **A-025**, and re-checked in **A-006**. **Confidence:** high.

### R-4 (P1). `NotificationOutbox` has no `appointmentId`
APPT-07 promises the outbox is queryable per appointment — "was she actually told?" is the question that ends the argument at my desk when a client is standing there with a confirmation. Today the only link is a string convention inside `dedupeKey`, and the reminder key deliberately embeds `startAtEpochMs` (P1-7), so a rescheduled appointment's messages no longer share a prefix. A-027 would be doing `LIKE` queries against a key format.
- Nullable `appointmentId` FK + index, written by `enqueueNotification`; not every message has one (future marketing/system messages), hence nullable.
- Cheap now (zero rows), a backfill-by-string-parsing later.
**Backlog fit:** migration before **A-009** (its confirmation enqueue is the first writer). **Confidence:** high.

### R-5 (P1). "Cut and colour" is declared in scope, has no story and no backlog row — and the constraint refuses the staff workaround
`00-master-prd.md:36` says single-provider multi-service visits **are** in scope as VISIT-01; `:170` puts multi-service visits in Phase 3. VISIT-01 exists nowhere else in the repo. That is half my Saturday book sitting on a contradiction. Worse: the workaround staff will reach for — two adjacent appointments — is *refused by the database*, because cut's `bufferAfter` and colour's `bufferBefore` make the blocked ranges overlap. The only path that works is a knowing override with a reason, on every combination booking, all day. Staff will learn to click override reflexively, and the override marker (D-8's whole point) becomes noise nobody reads.
- Resolve the contradiction explicitly — either write VISIT-01 into §5 with a backlog row after A-009, or move it to Phase 3 in §3 as well.
- If in scope, the rules are cheap and the engine needs no change: durations compose into one body, buffers **do not stack** between lines of one visit (first line's `bufferBefore`, last line's `bufferAfter`), one appointment, one `AppointmentServiceLine` per service. `AppointmentServiceLine` is already plural-shaped.
**Backlog fit:** new item after **A-009**, before A-010. **Confidence:** high that the contradiction must be settled; medium-high that it belongs in v1.

### R-6 (P1). `Appointment` has no notes field
CLIENT-03 specifies two note fields; the schema has `Client.notes` only. The per-visit note — "bring the reference photo", "called ahead, running 10 late", "patch test done 12/4" — has nowhere to go, so it goes in the client note, where it is pinned forever and eventually buries the allergy line that is a genuine safety surface in the med spa.
**Backlog fit:** one nullable column, folded into the R-4 migration. **Confidence:** high.

### R-7 (P2). Nine conflicts, and no way to mark six of them handled
AVAIL-05's "keep-flagged" is a *state* — "we called her, she's coming anyway" — and it is derivable from nothing. Conflicts themselves should stay derived (appointment ∩ time off), but the acknowledgment cannot be. Friday night Dana calls in sick; the desk works the list across two shifts, and on Saturday morning the second person sees nine unresolved conflicts again and re-rings three clients who were already sorted.
- One nullable `conflictAckAt` + `conflictAckReason` on `Appointment`, cleared whenever the overlapping absence changes. Do **not** store a `conflictFlag` boolean — a maintained flag goes stale and lies.
**Backlog fit:** **A-019**, column added with R-4's migration. **Confidence:** high.

### R-8 (P2). Availability changes have no actor and no audit
`TimeOff`, `AdHocBlock`, `WeeklyWindow` and `DateOverride` carry no actor and no history; hours edits are destructive UPDATEs. `AppointmentEvent` covers appointments beautifully and stops at the appointment boundary. "Who blocked Dana's 2–4 and why?" (`reason` is nullable) and "the book said she works till 5, why did the system stop offering 4:30?" both have no answer. This is my original recommendation 13 applied to the half of the schedule it did not reach.
- `createdByActor`/`actorRef` on the four tables at minimum; ideally an `AppointmentEvent`-shaped row on the availability change too, since AVAIL-05 already knows which appointments it stranded.
**Backlog fit:** **A-007**. **Confidence:** high on the need, medium on the shape.

### R-9 (P2). An override row is protected from the customer path by app logic alone
D-16 closes the design hole correctly, but an override's blocked range is zero-width, so the *database* no longer defends that time — the in-transaction engine re-check does, and this project's own rule is that check-then-write is never the correctness mechanism. Staff override Dana at 2pm while a customer's 2pm booking is in flight and both commit.
- Add the ninth deterministic interleaving to A-009: staff override vs. concurrent self-serve booking of the same range. Whatever the outcome, it should be *decided and tested*, not discovered.
**Backlog fit:** **A-009**. **Confidence:** medium — narrow window at 4-chair scale, but it is the exact class of bug the constraint exists to make impossible.

### R-10 (P3). Client merge has no tombstone
CLIENT-01 promises staff merge duplicates with history following. Re-pointing appointments works, but the losing record vanishes, and the old phone number then finds nothing.
**Backlog fit:** **A-015**, one nullable `mergedIntoClientId`. **Confidence:** medium.

---

## 4. Sequencing

### S-1 (P1). Split the seed and move the first half forward
A-011 sits last in Milestone 2, so **A-025, A-006, A-007 and A-026 are all built against a database populated by hand**. A-026 is the highest-risk database code in the project after the constraint — busy-set predicate, the D-16 `COALESCE`, `daysWithAvailability` — and it will be developed against three typed-in rows, never against the 85%-booked provider, the split shift with mid-window time off, or the DST fixture days.
- Split: a **setup seed** (business, 4 providers, 8 services with unequal buffers, weekly windows, one date override) built with **A-025**; the **density seed** (appointments) stays with A-009's write path.
- Then swap A-011 ahead of A-010, so the customer UI is built against a realistic book — a fully-booked day, a day with one slot left, the doubled fall-back hour — instead of an empty calendar where every screen looks fine.
- Carry D-20's caveat into the setup seed: roster must never exceed chair count, or the demo implies a constraint the system does not enforce.
**Confidence:** high.

### S-2 (P1). A-025's provider deactivation cannot run an impact preview at position 7
The row requires "provider deactivation running the AVAIL-05 impact preview", but no appointment can exist until A-009, twelve items later, and the impact workflow itself is A-019. As written it either ships untested against an empty set or blocks.
- A-025 builds `Provider.active` and the deactivation call site; the preview lands in **A-019** with one test covering both entry points (deactivation and time off) against the seeded book.
**Confidence:** high.

### S-3 (P1). Build A-009's write path staff-shaped from day one, even though only the customer calls it
A-009 is followed immediately by A-010, so its signature will be shaped by the customer flow — required name and phone, horizon-capped, no override. Staff booking is item 21. Every one of those assumptions is wrong for the desk: nullable client (walk-in, no name), uncapped horizon (D-21 is self-serve only), `isOverride` + reason, and actor. Seven of ten bookings in my shop are staff-made; if the write path has to be reopened at A-017, the manage token, the outbox enqueue and the race tests all get reopened with it.
- A-009 takes the staff-shaped input set and an `actor`, with self-serve as the *restricted* caller — not the other way round.
**Confidence:** high.

### S-4 (P2). Nothing creates a `Business` except the staff seed
`packages/db/auth/seed-staff.ts` quietly creates one if none exists. That is fine for dev, but A-025 is "owner settings" for a business that no product surface creates. One line in A-025 either way — just be deliberate.

---

## 5. From review 01: what did not land, and still matters

| Ref | Recommendation | Status |
|---|---|---|
| 1 | Actual time / running-late cascade | **Half landed.** States, `startedAt`/`endedAt`, APPT-03/04 all landed. The engine input and the delta's storage did not → **R-1**. |
| 4 | Staff booking is the primary path | **Landed in requirements** (BOOK-04/05, D-8), **at risk in sequencing** → **S-3**. |
| 8 | Client record with history and notes | **Half landed.** Client, phone-keyed, pinned notes, history all present; the per-appointment note has no column → **R-6**. |
| 10 | One visit, multiple services | **Contradicted, not decided** → **R-5**. |
| 13 | Every change has a history | **Landed for appointments, absent for availability** → **R-8**; and the outbox half ("was she actually told?") has no link → **R-4**. |
| 2, 3 | Segments and resources | **Deliberately deferred** (D-12, D-20) with the schema affordances built. Correct call, correctly sequenced — I am not re-opening it. |

---

## Do not build

- **A denormalized no-show counter on `Client`.** Derive it. A cached count drifts the first time an appointment is corrected under APPT-06, and a wrongly-flagged good client is a lost client.
- **A maintained `conflictFlag` boolean.** Derive the conflict; store only the human acknowledgment (R-7). A flag that must be kept in sync with time-off edits will be wrong on the day it matters.
- **The second reminder touch (OQ-5) before the call-down list exists.** The unconfirmed-tomorrow view (A-021) catches more Saturdays than another automated message ever will; decide the cadence after you have watched the call-down work.
- **Any resource axis in v1.** D-20 is right and I said so in review 01. Four chairs, four stylists — the pool never binds, and a second axis on a live exclusion constraint before the one-resource engine has run a real Saturday is the wrong order of work.
