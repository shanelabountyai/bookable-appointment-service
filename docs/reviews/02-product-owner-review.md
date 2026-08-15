I've read the PRD and all four house-style references. Here's the review.

---

# Review: `prd-bookable-appointment-app.md`

## Verdict

Buildable in outline, not buildable as written: roughly a third of the P0 acceptance criteria can be satisfied by an implementation that is wrong, which means they are not acceptance criteria. The single defect most likely to cost a rebuild is **P0-4 (lines 69–72)** — it asserts atomicity and "impossible, not just discouraged" (Goal 2, line 17) without naming what enforces it, and that answer determines the appointment table's shape (a `tstzrange` + partial exclusion constraint is a different schema from `start_at`/`end_at`), which is an input to the slot engine that the PRD sequences *before* it. Second-worst: the PRD has no data-model section, no decision log, and no ordered backlog, so every one of these questions gets answered silently mid-session by whoever is typing.

---

## Structural gaps against the house idiom

The sibling repo runs on five artifacts. This PRD is one document doing the job of five, and it is the wrong one of the five to have written first.

**1. `docs/prds/07-decisions.md` — a decision log with precedence.** Missing entirely. The rental log opens with "*This document amends the PRDs. Where a PRD conflicts with a decision below, this document wins*" and every row has two columns: the decision, and **what it means for the build**, with the reasoning preserved (D-16's four paragraphs on why a vendor link is multi-use are why nobody re-opens it). This PRD's Open Questions (lines 112–116) are the anti-pattern: line 116 says buffer belongs to the service, marked "*resolved — revisit in P2*", inside the document the decision log is supposed to override. Nothing gives it precedence, nothing records why, and nothing says what it means for the schema. It will be re-opened in month two.

**2. `docs/prds/06-backlog.md` — a strictly ordered backlog.** Missing. "Phase 1: P0-1 through P0-4" (line 120) is a grouping, not a build order: no global IDs, no sizes (S/M/L), no **Depends on** column, no ✅/🟡/⏸️ markers, no milestones, and — critically — no guarantee that every item is buildable when reached. The rental backlog states that guarantee explicitly and then earns it with a dependency column on every row; that is what lets a session start cold. Seven P0 requirements is not seven sessions, and P0-3 alone is an L.

**3. A canonical entity list.** The rental CLAUDE.md line 11 points at master PRD §13 and names twenty entities, and START-HERE.md line 30 makes the *entire* Session 1 "show me the entity list and **wait for me to confirm it**" before a schema is written. This PRD names two database artifacts, both in Future Considerations: `payment_status` (line 95) and `business_id` (line 96). For a product whose entire learning goal is availability computation and conflict detection, there is no Business, Provider, Service, WorkingHours, AvailabilityException, Appointment, Customer, Token, or Outbox anywhere in the requirements. Every one of those gets invented ad hoc.

**4. An "Invariants the database enforces" section.** The rental CLAUDE.md dedicates a section to append-only triggers and the three consequences that each cost a debugging session. This PRD makes a *stronger* database claim than the sibling — Goal 2, "*makes conflicting bookings impossible, not just discouraged*" (line 17) — and never says what the database does. If the answer is "application code checks first," Goal 2 is false as written and the race test in P0-4 is theatre.

**5. Demo checkpoints as acceptance gates.** The rental backlog has two, written as a single narrated path ("*tenant reports a leak → … → the cost appears on that property*"), plus the convention that matters more than the checkpoint: "*First walked 2026-08-10, and it did not run. Four defects, all in items already marked ✅.*" Every one of those was invisible from inside the item that introduced it. This PRD has no checkpoint at any phase boundary, and this product has the same failure shape — a status enum change that misses a read site (rental CLAUDE.md line 72) is exactly what P0-5's lifecycle will produce.

**6. A repo `CLAUDE.md`, written at scaffold time.** Line 128 says to keep one documenting the timezone convention "*future sessions will violate it otherwise*" — correct, and then it defers the artifact. The sibling CLAUDE.md is where the `@db.Date`/`BusinessDate` trap lives (lines 69–70), which is the single trap this project is most likely to hit. It belongs in item 1, not "eventually."

**7. `PROGRESS.md` and `START-HERE.md`.** No running record of *what it built / what it decided / what it left behind*, and no session loop. The "what it decided" column is the one that prevents a later session silently reversing the buffer or the token lifetime.

**8. A "Needs owner decision" gating table.** The rental log's table has **Gates** and **Why it can't be deferred** columns, and the rule "*an item whose gating question above is unanswered should not be started*." This PRD's three open questions have no gates column, and two of the three are mislabelled (below).

**9. Accessibility as an acceptance criterion.** The rental CLAUDE.md line 21: "*WCAG 2.1 AA is an acceptance criterion on tenant- and vendor-facing work, not a later cleanup.*" This PRD never mentions it, though the stack includes axe. A date/time slot picker is one of the hardest a11y surfaces in existence — keyboard grid navigation, a live region announcing recomputed slots, focus management after "slot taken." Retrofitting it is the expensive order.

**10. A lexicon decision (D-10 equivalent).** The tokenized reschedule page (P0-6) is a public, unauthenticated route. The sibling forbids any internal identifier — backlog ID, entity name, status enum — from rendering on such a route, *and asserts it with a test*. Nothing here says `no_show` must never appear on a customer's screen.

---

## Requirement defects

### 1. P0-4: nothing states what enforces atomicity
> Line 71: "Booking writes are transactional — no partial state"

**Defect** — ambiguous (schema-determining).
**Why it bites** — "Transactional" and "conflict-free" are different guarantees; a transaction prevents partial writes, not two transactions each reading an empty slot. There are four plausible mechanisms and they produce four different schemas: a unique index on `(provider_id, start_at)`; a `tstzrange` column with `EXCLUDE USING gist` (+ `btree_gist`); `SELECT … FOR UPDATE` on a provider-day lock row; or `SERIALIZABLE` with retry. Pick the exclusion constraint later and you migrate the table, hand-write the SQL (generated diffs don't survive it — rental CLAUDE.md line 61), and rewrite the engine's inputs. This is the rebuild.
**Fix** — Decide it as D-1-equivalent before schema. Suggested: *"`Appointment` carries a generated `during tstzrange` column. Overlap is refused by `EXCLUDE USING gist (provider_id WITH =, during WITH &&) WHERE (status IN ('booked','confirmed'))` in a hand-written migration. Application code never checks for overlap before writing; it writes and catches `23P01`. A test asserts the constraint refuses an overlapping insert issued directly against the database, bypassing the app."* Then state, in the same decision, whether buffer time is *inside* `during` (constraint enforces buffers, but every display query must subtract it) or *outside* (buffers are application-only) — and whether time-off/ad-hoc blocks are rows in the same table (so the constraint covers block-vs-booking) or a separate table (so it cannot).

### 2. P0-4: the race acceptance criterion is satisfiable by a wrong implementation
> Line 70: "Given two customers submit **the same slot** near-simultaneously, then exactly one succeeds"

**Defect** — untestable-as-specified / insufficient.
**Why it bites** — Identical start times is the easy case; a unique index on `(provider_id, start_at)` passes this AC and still permits 10:00–11:00 to coexist with 10:30–11:30. The AC therefore certifies the defect it exists to catch. "Near-simultaneously" and "a scripted race" are also nondeterministic — without a barrier the two requests serialize and the test passes vacuously forever.
**Fix** — Three criteria, not one: *(a)* two concurrent requests for the identical slot → exactly one 2xx, one 409; *(b)* two concurrent requests for **overlapping but non-identical** slots (10:00–11:00 and 10:30–11:30) → exactly one succeeds; *(c)* two concurrent requests separated only by the buffer gap (10:00–11:00 and 11:05–12:05 with a 15-min buffer) → exactly one succeeds. All three run against a real barrier (both transactions open, both reach the write, then release), and each asserts the loser's error carries a machine-readable code, not prose.

### 3. P0-3: the slot grid has no anchor
> Line 63: "discretized to a configurable interval (default 15 min)"

**Defect** — ambiguous (defines the core function's output).
**Why it bites** — Anchored to midnight business-local? To the start of the working block? To the end of the preceding appointment? The AC on line 64 (booking 10:00–11:00, buffer 15, first slot 11:15) is consistent with **both** "grid from midnight" and "previous end + buffer," so it disambiguates nothing. Change a booking to 10:00–10:50 and the two rules give 11:15 and 11:05 — different products, and every fixture in the test matrix has to be rewritten when it flips.
**Fix** — *"Slot starts are the sequence `openingInstant + n × interval` where `openingInstant` is the start of the provider's working block for that business date, computed in business TZ. A gap that begins off-grid does not produce an off-grid slot."* Add the AC: a booking 10:00–10:50 with a 15-min buffer yields 11:00 as the first offered slot, not 11:05.

### 4. P0-3: whose buffer, and no buffer-before case
> Line 64: "Given a 60-min service with 15-min buffer and a booking 10:00–11:00…"

**Defect** — two requirements in one / missing case.
**Why it bites** — The existing 10:00–11:00 booking is presumably a *different* service with its own buffer. Which buffer governs the gap — the earlier appointment's `buffer-after`, the new one's, or `max()`? P0-1 (line 53) defines only `buffer-after`, so the symmetric case is unspecified and will be wrong: booking a 60-min service at 09:00 immediately before a 10:00 appointment leaves zero buffer, and nothing forbids it. That is the "back-to-back bookings don't collide in practice" outcome story 6 (line 43) exists to prevent, failing silently.
**Fix** — Split into three criteria. *(a)* The gap between appointment A (ending at `t`) and appointment B is at least `A.service.bufferAfter`. *(b)* A candidate slot ending at `t` is offered only if `t + candidate.service.bufferAfter ≤ nextAppointment.start`. *(c)* Buffer must fit inside the working block: a 60-min service with a 15-min buffer in a block closing at 17:00 offers 15:45 as its last start, not 16:00 — **or** state explicitly that buffer may overrun closing, which is defensible and must be chosen deliberately.

### 5. P0-3: "closing" is referenced but never modelled
> Line 65: "A service longer than the remaining window before a **break/closing** does not render a slot"

**Defect** — hidden dependency / contradicts P0-2.
**Why it bites** — P0-2 (line 58) models *provider* working hours and overrides. There is no business-hours entity anywhere in the requirements, yet the Owner persona (line 34) "configures services, staff, **business hours**" and P0-3 invokes "closing." Two readings: closing == the end of the provider's block (then business hours don't exist and the persona is wrong), or business hours clamp provider hours (then a whole entity, its own overrides for holidays, and a second intersection step are missing from P0-2). A salon closing at 17:00 with a stylist rostered to 17:30 resolves differently under each.
**Fix** — Decide, then write it: *"Business hours are a Business-level weekly pattern with date-specific overrides (holidays). Effective availability = business hours ∩ provider working hours − breaks − time off − bookings − buffers. A holiday override at the business level removes all providers' slots that day, and an AC asserts it."* Or delete "closing" from line 65 and cut business hours from the Owner persona.

### 6. P0-3: "slots in the past" has no clock and no lead time
> Line 66: "Slots in the past never render"

**Defect** — untestable / missing precondition.
**Why it bites** — Past relative to what — server `Date.now()`, business-TZ now, or an injectable clock? Without an injected clock this criterion is untestable by construction: any fixture asserting "11:15 is the first offered slot" starts failing at 11:16. And it conflates "past" with "too soon": nothing prevents booking a slot starting in 90 seconds, which is a real product decision (a salon needs 30–60 min notice) and interacts with the 2h cancellation cutoff on line 74.
**Fix** — *"The engine takes `now: Instant` as an explicit parameter; no module reads the system clock. A slot is offered only if `slot.start ≥ now + minimumLeadTime`, where `minimumLeadTime` is business configuration (default 0). Every engine test supplies a frozen `now`."*

### 7. P0-3: the timezone convention does not distinguish calendar days from instants
> Line 67: "All computation is done in the business's time zone; stored timestamps are UTC"

**Defect** — ambiguous; this is the exact defect the sibling repo already paid for.
**Why it bites** — The convention is right and incomplete in the same way rental's R-042 was: "*`utcToBusinessDate(value)` is the reader for a date-only column; `businessDate(instant, zone)` is the reader for a real timestamp… every move-in west of UTC silently gained a day, with all ten core unit tests passing because the defect was entirely in how the date was read out of the database*" (rental CLAUDE.md line 69). This product has *more* date-only values than that one: the day-of-week in a weekly pattern, the date on an availability override, the day a staff day-view renders, the day the seed script anchors, the day a report groups by. None are instants. Four further silences: *(a)* what happens when a wall-clock time doesn't exist (09:30 on spring-forward) or exists twice (01:30 on fall-back); *(b)* whether a 60-minute appointment starting at 01:30 on fall-back day ends at 02:30 wall clock or 3600s later (they differ); *(c)* what timezone the customer sees — theirs or the business's — and what the confirmation email says; *(d)* whether "24h before" (line 45) means the instant minus 24h or the same wall-clock time the previous day, which differ by an hour across a DST boundary.
**Fix** — A decision-log row plus a `packages/core/time` module built before the engine: *"`BusinessDate` is a `YYYY-MM-DD` string; instants are `Date`. No zone conversion ever touches a `BusinessDate`, and no `BusinessDate` is ever constructed from an instant without an explicit zone. Wall-clock times are resolved against the business TZ with an explicit non-existent-time policy (shift forward to the transition instant) and ambiguous-time policy (take the first/earlier offset). Appointment duration is a fixed number of seconds, not a wall-clock delta. All slot times are displayed in business TZ with the abbreviation always visible; the customer's local zone is never inferred. Reminders fire at `start − 24h` as an instant."*

### 8. P0-2: "override beats the weekly pattern" is three different rules
> Line 60: "Date-specific override beats the weekly pattern"

**Defect** — ambiguous.
**Why it bites** — "Beats" could mean *replaces the whole day* (a 14:00–16:00 override on a 9–5 day yields only 14:00–16:00), *adds to it* (9–5 plus 14:00–16:00), or *subtracts* (time off). The requirement lumps "time off" and "modified hours" (line 58) into one concept while they are opposite operations. And nothing says what happens with two overlapping overrides on the same date, or an override that only partially covers the working block.
**Fix** — Model exceptions as typed rows: `AvailabilityException { type: TIME_OFF | MODIFIED_HOURS | AD_HOC_BLOCK, date, startTime?, endTime? }`, with stated precedence: *"MODIFIED_HOURS replaces the weekly pattern for that date entirely. TIME_OFF and AD_HOC_BLOCK subtract from whatever pattern is in effect. Multiple exceptions apply in that order; two MODIFIED_HOURS rows on one date is a validation error."* Three ACs, one per type.

### 9. Story 9's edge case is owned by no requirement
> Line 46: "As a staff member, I want to block off ad-hoc time… and I want to **see any existing bookings that now conflict**. *(edge case: blocking time over an existing booking)*"

**Defect** — missing requirement.
**Why it bites** — This is the single most interesting conflict-detection case in the product — it is the stated learning objective — and it appears only as a user story. No P0 or P1 requirement covers it, so it has no acceptance criteria and will not be built. It also forces the P0-4 decision from a different direction: if the exclusion constraint covers blocks, then blocking over an existing booking is *refused by the database* and "show me the conflicts" is impossible; if it doesn't, blocks and bookings can overlap and the day view must reconcile them.
**Fix** — Promote to **P0-8: Ad-hoc block with conflict surfacing.** *"Staff can create an `AD_HOC_BLOCK` exception for a provider. If existing non-terminal appointments intersect the block, the block is created and the intersecting appointments are listed for the staff member with per-appointment actions (leave, cancel, reschedule). The block never silently cancels an appointment. AC: given a booking 10:00–11:00 and a block 10:30–12:00, the block is created, exactly one conflicting appointment is surfaced, and the appointment's status is unchanged until staff acts."*

### 10. P0-5: `confirmed` has no trigger and no meaning
> Line 74: "States: `booked → confirmed → completed | no_show | cancelled`"

**Defect** — ambiguous / hidden dependency.
**Why it bites** — Nothing says what moves an appointment from `booked` to `confirmed`. If it's the customer clicking a link (implied by non-goal line 28, "book via email + confirmation link"), then an unconfirmed appointment holds a slot indefinitely and there is no expiry state. If it's automatic, `confirmed` is decorative and every transition guard, every reminder-eligibility query, and every exclusion-constraint predicate has to list both values forever. Note the sibling's trap: "*Adding a value to a status enum is never one edit… `VERIFIED` existed in the enum and in the write that set it, and in neither of the two lists that read it*" (rental CLAUDE.md line 72). A *useless* value is the same cost.
**Fix** — Either delete `confirmed` (booking is immediate; the confirmation email is a notification, not a state), or specify: actor, trigger, what happens if it never occurs, and how long the slot is held. State it in the decision log, because every status-reading query depends on it.

### 11. P0-5: reschedule is not in the state machine
> Line 74 (states) vs line 80 ("Reschedule reuses the slot engine and **atomically swaps** old/new")

**Defect** — contradicts another requirement.
**Why it bites** — "Swaps old/new" implies two rows; the state machine has no `rescheduled` state and no way to represent the retired one. Cancel-and-recreate makes every reschedule count as a cancellation in the story-7 report (line 44) and inflates the cancellation-rate metric in P1-2. Mutate-in-place destroys the history the report needs, orphans the 24h reminder computed off the old start, and leaves the tokenized link pointing at a time that no longer exists.
**Fix** — Decide and enumerate: *"Reschedule is a transition. The original row moves to `rescheduled` (terminal, carries `rescheduledToId`); a new row is created in `booked`. The reporting definition of cancellation rate excludes `rescheduled`. Any pending reminder for the original is voided and one is scheduled for the new instant. The customer's token is re-pointed at the new appointment, not reissued."* Add `rescheduled` to the enum in the same edit as every list that reads status.

### 12. P0-5: transitions are enumerated by example, and terminal states have no correction path
> Line 75: "Invalid transitions are rejected (**e.g.**, completed → cancelled)"

**Defect** — untestable ("e.g." is not a specification).
**Why it bites** — With 6 states there are 30 ordered pairs; the PRD names one. The consequential ones are all unaddressed: `no_show → completed` (staff mis-tapped, the customer was in the waiting room — a real and frequent correction), `completed → no_show`, `cancelled → booked` (customer calls back), `booked → no_show` before the appointment has even started (should be refused — a time precondition, not just a state precondition), and `booked → completed` skipping `confirmed`. With no correction path, the only fix for a mis-tap is a SQL edit, and the no-show metric on line 108 becomes unfalsifiable.
**Fix** — A full transition table in the PRD (6×6 grid, allowed/refused, with the actor role and any time precondition on each allowed cell), and one decision: *"Terminal-state corrections are permitted for staff only, from `no_show` to `completed` and back, within 7 days of the appointment end, and write an `AppointmentStatusEvent` row recording actor, from, to and reason. Every other terminal transition is refused."* Test the table exhaustively — one parameterised test over all 30 pairs, not one example.

### 13. P0-5: "allowed for staff" depends on an actor concept that no requirement creates
> Line 76: "Cancellation inside the cutoff window is blocked for customers but allowed for staff"

**Defect** — missing precondition.
**Why it bites** — Customer accounts are a non-goal (line 28) and there is no staff auth requirement anywhere in P0-1 through P0-7. P0-7's day view has no authentication criterion. So "staff" is not a thing the system can recognise, and this AC cannot be written, let alone passed. The same silence means the staff day view and the status controls are, as specified, publicly reachable — anyone can mark another customer a no-show.
**Fix** — Add **P0-0: Staff session.** Minimal is fine and should be stated as minimal: *"Staff authenticate with a single shared owner credential (learning scope; multi-user staff auth is a Non-Goal). Every mutation records `actor: 'staff' | 'customer_token' | 'system'`. Staff routes refuse an unauthenticated request. The cancellation cutoff is enforced against `actor`, and an AC asserts a token-actor cancel inside the window is refused with a 403 while a staff-actor cancel succeeds."* Note this also makes the audit story in P0-5's transition events possible.

### 14. P0-5: "configurable cutoff" — configurable at what level, and does reschedule dodge it?
> Line 74: "`booked → cancelled` allowed until a configurable cutoff (default 2h before start)"

**Defect** — ambiguous / contradicts P0-6.
**Why it bites** — Business-level, service-level, or provider-level? This is the same class of question the PRD already had the sense to answer for buffer (line 116) and did not answer here; discovering it belongs on the service after the config is a business column is a migration plus a resolver. Worse: P0-6 lets a customer *reschedule* with no stated cutoff, so a customer blocked from cancelling 30 minutes out can reschedule to next Tuesday instead — which is a cancellation with extra steps and empties the chair identically.
**Fix** — *"`cancellationCutoffMinutes` is Business configuration, overridable per Service (resolver: `service.cutoff ?? business.cutoff`). The same cutoff gates customer-initiated reschedule. AC: a token-actor reschedule attempted inside the cutoff is refused with the same error as a cancel."*

### 15. P0-6: "used" tokens contradict the workflow the tokens exist for
> Line 81: "**Used** or expired tokens fail safely with a clear message"

**Defect** — contradicts another requirement; already-learned lesson.
**Why it bites** — This is D-16 verbatim, from the other direction. The rental log: "*a vendor link **is** the credential — there is no account and no session behind it — so burning it on first click means the plumber who opened the text at 7am to accept the job cannot reopen it at 4pm to upload the invoice.*" Here: reschedule-then-later-cancel, or reschedule twice, is the ordinary customer workflow, and a single-use token fails on the second step of it every time. "Expired" is also undefined — no TTL is given, and a fixed TTL is wrong for an appointment booked six weeks out.
**Fix** — *"The token is scoped to one appointment, grants reschedule and cancel and nothing else, is **multi-use until it expires**, and expires at `appointment.end + 24h`. Reissuing revokes all prior tokens for that appointment. A reschedule re-points the existing token rather than issuing a new one. AC: the same token successfully reschedules, then successfully cancels; a revoked token is refused; a token for appointment A cannot read appointment B."* Add the rate-limit criterion — the route is public and returns customer PII.

### 16. P0-6: "atomically swaps old/new" has no failure semantics
> Line 80: "Reschedule reuses the slot engine and atomically swaps old/new"

**Defect** — two requirements in one; missing precondition.
**Why it bites** — Two claims (reuse the engine; swap atomically) with one checkbox, and the interesting case is unstated: if the new slot is taken between the customer seeing it and submitting, does the customer still hold the old appointment? The naive implementation releases the old slot first, then discovers the new one is gone, and the customer now has no appointment at all — and the old slot may have been taken in the interim. That is a support call this product's whole premise is meant to eliminate.
**Fix** — Split. *(a)* "Reschedule offers slots from the same engine call the booking flow uses, excluding the appointment being rescheduled from the conflict set (so its own slot is offered back)." *(b)* "The swap runs in one transaction: the new appointment is inserted first and the old released only on success. AC: given the new slot is taken by a concurrent booking mid-reschedule, the reschedule fails and the original appointment is unchanged and still `booked`."

### 17. P0-7: "without manual refresh" is not a criterion
> Line 85: "Reflects new bookings without manual refresh (polling is acceptable)"

**Defect** — untestable.
**Why it bites** — No staleness bound, no interval, no observable. Any implementation passes; none can fail. It also cannot be automated in Playwright as written.
**Fix** — *"A booking created in another session appears in an open day view within 30 seconds without user action. AC (e2e): open the day view, create a booking via the API, assert the new row appears within 30s. The poll interval is configuration; the test asserts the bound, not the interval."*

### 18. Goal 3 contradicts P0-7's acceptance criterion
> Line 18: "Staff can view and manage a full day's schedule from **one screen**" vs line 84: "Chronological list **per provider**"

**Defect** — contradicts another requirement.
**Why it bites** — For the stated sample business — a 4-chair salon — the owner's "one screen" is all four columns side by side; the stylist's is one. A chronological list per provider is a different component with different data-fetch shape and different a11y behaviour from a multi-column day grid. Building the list and then discovering the goal wanted the grid is a rewrite of the highest-effort UI in the product.
**Fix** — State both, separately: *"P0-7a: a single-provider chronological day list with status controls. P0-7b: an all-providers day view for the day, columns per provider, same status controls."* Or amend Goal 3 to "*a staff member can run their own day from one screen*" and move the multi-provider view to P1 explicitly.

### 19. P0-1: deactivation is silent on appointments in flight
> Line 55: "Deactivating a service hides it from booking but preserves history"

**Defect** — missing case.
**Why it bites** — "History" is past appointments. What about the eleven **future** booked appointments for that service? Hide-from-booking is easy; the real question — do they stand, and can they be rescheduled into a service that is no longer bookable — is unanswered, and the naive filter will make them un-renderable in the day view. There is also no provider-deactivation requirement at all, which is the more common event (a stylist quits with three weeks of bookings) and the harder one.
**Fix** — *"Deactivating a service or provider is refused if future non-terminal appointments exist, unless the actor confirms; on confirm, existing future appointments remain valid and renderable, cannot be rescheduled, and are listed to the actor at the moment of deactivation. AC: deactivate a service with a future booking → the booking still renders in the day view with full status controls, and the service no longer appears in the booking flow."* Add provider deactivation as its own criterion.

### 20. Metric: "≥90% of scripted test bookings succeed first try"
> Line 102

**Defect** — untestable as a gate.
**Why it bites** — A scripted suite is deterministic. Ninety percent means "ten percent of my own tests fail and I ship," which no gate can be built on. If the intent is different — that against a realistically full calendar, 90% of *attempts* find a bookable slot — that is a property of the seed script's density, not of the code, and it belongs in the seed spec.
**Fix** — Two separate statements. Gate: *"100% of booking-flow e2e specs pass; this is part of the gate command, not a metric."* Seed property: *"Against the seeded 30-day dataset, ≥90% of 200 scripted attempts for a random (service, provider, day) find at least one offerable slot — asserting the seed leaves realistic headroom rather than a full or empty calendar."*

### 21. Metric: the edge-case matrix is named by example, and the named examples are the wrong ones
> Line 104: "100% pass on an edge-case test matrix (DST transition day, month boundary, provider with split shifts)"

**Defect** — untestable (open-ended list) / misdirected.
**Why it bites** — "Month boundary" is not a hazard: nothing in slot computation keys on months. Meanwhile "DST transition day" is two utterly different bugs collapsed into one phrase, and the genuinely dangerous cases are absent. A matrix defined by three examples gets built as three tests.
**Fix** — Enumerate it in the PRD as the definition of done for P0-3: spring-forward day (a working block containing the missing hour; a booking whose wall-clock end crosses the transition); fall-back day (the duplicated hour — 25-hour day, ambiguous 01:30, and the utilization denominator for that day); a service duration that is not a multiple of the slot interval (50 min on a 15-min grid); a buffer that pushes the last slot past closing; a working block crossing midnight; back-to-back services with different buffers; an override that shortens hours over an existing booking; an all-day time-off; a provider with zero working hours on the requested day; a date in the past; a date beyond the booking horizon; a split shift with a gap shorter than the service duration.

### 22. Metric: utilization "within 1%" has no denominator
> Line 107: "Utilization visible and accurate within 1% of hand-calculated values" (with line 90: "booked minutes ÷ available minutes")

**Defect** — ambiguous / untestable.
**Why it bites** — Does "available" include break time? Buffer minutes (which are neither booked nor available)? Time off? A day with zero working hours divides by zero. Do cancelled and no-show appointments count as booked minutes? A no-show consumed the chair; a cancellation four days out did not. "Hand-calculated" is not a fixture — it is a number in someone's head that nobody can reproduce in six months.
**Fix** — Write the formula into the PRD, then freeze it: *"utilization = Σ(minutes of appointments in {completed, no_show}) ÷ Σ(minutes of provider working hours − breaks − time off), per provider per business date; buffer minutes count in neither numerator nor denominator; a day with a zero denominator is reported as 'n/a', never 0%. AC: for seeded provider P in week W, utilization equals exactly 62.5%, asserted against a constant in the test."*

### 23. Metric: the no-show cohort comparison measures the seed script
> Line 108: "No-show rate delta measurable between reminder-on and reminder-off seeded cohorts"

**Defect** — aspirational prose; untestable in principle.
**Why it bites** — No-shows in a seeded dataset are whatever the seed script decided they are. Any "delta" is the constant you typed. This cannot fail, cannot inform, and will absorb a session building a comparison harness that measures nothing.
**Fix** — Delete it and replace with what is actually measurable about reminders: *"For a seeded window, the reminder job produces exactly one outbox row per appointment in {booked, confirmed} whose start falls 24h ahead, and zero rows for appointments that are cancelled, rescheduled away from that window, or already reminded. Re-running the job produces no duplicate rows (idempotency)."* Amend Goal 4 (line 19) to match — as written it promises a measurement the project cannot make.

### 24. Metric: the seed script has no anchor and the wrong density
> Line 110: "a seed script generating 4 providers, 8 services, and 200 appointments across 30 days"

**Defect** — missing precondition.
**Why it bites** — Thirty days from *when*? If the seed anchors to `now`, the DST-transition-day test exists in March and silently vanishes in July — the highest-value test in the suite disappears without a single failure. And 200 appointments ÷ 4 providers ÷ 30 days ≈ 1.7 per provider per day is a near-empty calendar: it exercises neither conflict rejection, nor "no slots left," nor a meaningful utilization number, nor the waitlist.
**Fix** — *"The seed anchors to a fixed date constant, chosen so the 30-day window contains one spring-forward and (in a second fixture) one fall-back transition. Density is specified per provider: one provider ~85% booked, one ~40%, one fully booked for three consecutive days (waitlist and no-slots paths), one with a split shift and a mid-window time-off. Seed output is deterministic under a fixed random seed."* Also move it into the build order — the Build Note on line 127 calls it a P0 deliverable while the phasing (lines 120–122) never lists it.

### 25. Open Question: SQLite is marked non-blocking and it is the most blocking of the three
> Line 114: "SQLite or Postgres? … *(non-blocking — start SQLite)*"

**Defect** — contradicts another requirement; mislabelled gate.
**Why it bites** — The stack is fixed to match the siblings (Postgres + Prisma), so this question is already answered elsewhere and the PRD reopens it. More concretely: SQLite has no `EXCLUDE` constraint, no `btree_gist`, no range types, and a single-writer model that makes P0-4's race test pass for reasons that have nothing to do with your code. Starting on SQLite means the one requirement that is the point of the project (line 62 calls the engine "the core learning artifact"; P0-4 is its enforcement) cannot be built or tested, and switching later invalidates every migration written to that point. It gates item #1.
**Fix** — Delete the question; record `D-1: Postgres + Prisma, matching the sibling repos` with the reason stated as *"the exclusion-constraint and serializable-isolation behaviour P0-4 depends on does not exist in SQLite; a conflict test that passes because the database has one writer teaches the wrong lesson."*

### 26. Open Question: the blocking one is answered, and its actually-open part is not asked
> Line 115: "Render slots server-side or compute client-side… *(blocking — decide before P0-3)*"

**Defect** — ambiguous; the wrong question.
**Why it bites** — It answers itself in the same sentence ("server-side keeps one source of truth"), so it is not open. What *is* open and genuinely blocks P0-3 is the contract: what does the endpoint return (start instants? intervals? grouped by business date?), what horizon does one call cover, does the month-view date picker need a separate cheaper "which days have any availability" query (it does — that is a different aggregate with a different cost profile), and how stale may a rendered slot be before the "slot taken" path is expected to catch it. Discovering the date picker needs a second query after the engine is written is a rework of the engine's signature.
**Fix** — Replace with: *"D-x: the slot API is server-computed and returns `{ businessDate, slots: Instant[] }[]` for a requested date range capped at N days; a separate `daysWithAvailability(providerId, serviceId, month)` aggregate backs the date picker and is derived from the same pure function. Rendered slots are advisory — the write path is the only authority, and the UI must handle a 409 by recomputing in place."*

### 27. Goal 4 is implemented only by a Nice-to-Have
> Line 19 (Goal) vs line 89 (P1-1 Reminder scheduler)

**Defect** — contradicts another requirement.
**Why it bites** — A goal that an optional requirement satisfies is not a goal. Same shape for user story 7 (line 44, "priority order" position 7) which is served only by P1-2, and story 8 (line 45) served only by P1-1. Either the story ordering or the P0/P1 tiering is wrong, and whichever is wrong will be discovered when a session picks up a P1 item and finds a P0 goal depending on it.
**Fix** — Move the reminder *outbox and job* to P0 (it is the "notification triggers" learning objective on line 6, and it is cheap once the outbox seam exists), leaving the delivery adapter stubbed per the non-goal on line 27; or demote Goal 4 to a stated Phase-3 goal. Reconcile the story order with the requirement tiers either way.

### 28. Goal 1's 90 seconds has no instrument and no owning requirement
> Line 16: "A customer can find and book an open slot in under 90 seconds"

**Defect** — untestable; missing requirement.
**Why it bites** — There is no P0 requirement for the customer-facing booking flow at all. P0-3 is an engine, P0-4 is a write path; nothing specifies the screens between them. So the headline goal has no implementation and no measurement, and the booking UI gets built as a byproduct of whatever session reaches P0-4.
**Fix** — Add **P0-3b: customer booking flow** with a step budget rather than a stopwatch: *"Service → provider → date → slot → name/email → confirm, in no more than 5 screens and 3 required text inputs; measured by an e2e spec that asserts the step count and that no step requires a page reload. WCAG 2.1 AA on this flow is an acceptance criterion, including keyboard-only slot selection and an ARIA live region announcing recomputed slots."*

### 29. P2: a column no code writes
> Line 95: "design the booking record with a `payment_status` field now, unused"

**Defect** — premature.
**Why it bites** — An always-null enum column is a field every future session must reason about and no test covers; when payments arrive it will be the wrong shape anyway (a payment is a row with an amount, a provider reference and a timestamp, not a status on the appointment). Contrast the sibling's D-13 reasoning, which is the *right* version of this instinct — it added the shape (`LeasePayer` + `PayerAllocation`) precisely because retrofitting a split payer "costs every financial query and a data migration." A nullable status enum costs nothing to add later.
**Fix** — Drop `payment_status`. Keep `business_id` (line 96) — that one genuinely is expensive to retrofit and matches the sibling's low-regret reasoning; say so, with the reason, in the decision log rather than in Future Considerations.

---

## Sequencing critique

The three phases (lines 120–122) are a grouping of seven requirements, not a build order. Four specific problems:

**Nothing in Phase 1 is buildable when reached, because Phase 1 has no foundation item.** P0-1 needs a Service, a Provider, a Business (which carries the timezone), and a Service↔Provider join. No requirement creates any of them. The sibling puts the data model at item #2 of 13 in Milestone 1 and makes it the "highest-leverage session in the project" (START-HERE.md line 28) with a mandatory pause for owner confirmation before the schema is written. This PRD has no equivalent, so the schema gets improvised inside the P0-1 session by whoever needs a table.

**P0-3 is sequenced before P0-4, and the dependency runs the other way.** The engine's inputs are "existing bookings … − buffers" (line 63), so it consumes the appointment representation — and whether buffer lives inside the stored interval, and whether blocks share the table, is decided by P0-4's enforcement mechanism. Writing the engine first means writing it against an assumed shape and rewriting it when the constraint lands.

**Phase 3 contains a Phase 1 gate.** Line 122: "*Phase 3: P1 items as follow-ups; **write the DST edge-case tests before calling Phase 1 done**.*" A Phase 3 line that is a precondition on Phase 1 is a contradiction on its face, and it contradicts the Build Note on line 126 that says to write the engine TDD. The DST matrix *is* P0-3's definition of done.

**Phase 2 secretly depends on a Phase 3 item.** P0-6's tokenized link (line 79) arrives in a confirmation email — and the confirmation email is sent by P0-4, in Phase 1. The notification outbox is P1-1, in Phase 3. So the first two phases hand-roll sending at each call site and the outbox arrives to find three of them. The sibling's rule (rental CLAUDE.md line 19): "*Every module sends notifications through the notification engine — no module hand-rolls its own sending.*" D-15 is the pattern to copy: build the seam with a logging adapter (which is what the non-goal on line 27 already asks for), then the real driver is one assignment.

Two smaller ones: the status enum is a Phase 2 item (P0-5) that Phase 1's conflict predicate must already read; and P1-2's "available minutes" is a definition that belongs in P0-2, not discovered at dashboard time.

### Corrected ordering

Named as backlog rows, with dependencies. Sizes in the sibling's S/M/L.

| # | ID | Item | Size | Depends on |
|---|---|---|---|---|
| 1 | A-001 | Monorepo scaffold: `apps/web` + `packages/core` + `packages/db`, Next.js/TS, Tailwind+shadcn, Prisma+**Postgres**, Vitest/Playwright/axe, CI, the gate command, and `CLAUDE.md` carrying the TZ convention from day one | M | — |
| 2 | A-002 | `docs/prds/07-decisions.md` + canonical entity list + `06-backlog.md` + "Needs owner decision" table. **Docs only, before any schema.** | S | A-001 |
| 3 | A-003 | `packages/core/time`: `BusinessDate` vs `Instant` types, business-TZ wall-clock↔instant conversion with explicit non-existent/ambiguous-time policies, injectable clock. TDD, its own test file, DST matrix from defect 21. | M | A-001 |
| 4 | A-004 | Core data model & migrations: Business(timezone), Provider, Service, ServiceProvider, WorkingHours, AvailabilityException(typed), Customer, Appointment (**generated `tstzrange` + partial exclusion constraint, hand-written SQL**), AppointmentStatusEvent, NotificationOutbox, AccessToken. Constraint tests that write **directly to the database**, bypassing the app. | L | A-002, A-003 |
| 5 | A-005 | Notification seam: outbox table + `ChannelAdapter` with a logging adapter, idempotent enqueue. **Built before its first sender**, per D-15's shape. | M | A-004 |
| 6 | A-006 | Staff session (minimal, single credential) + `actor` on every mutation. Unblocks A-010's staff/customer split and A-012's controls. | S | A-001 |
| 7 | A-007 | Service catalog CRUD, incl. deactivation-with-future-appointments (defect 19) | S | A-004 |
| 8 | A-008 | Provider availability: weekly pattern + typed exceptions + business hours intersection (defects 5, 8) | M | A-004, A-003 |
| 9 | A-009 | **Slot engine** as a pure function, `(availability, appointments, service, now) → Instant[]`, plus `daysWithAvailability`. TDD, full DST/edge matrix as its definition of done. | L | A-003, A-007, A-008, and the appointment shape from A-004 |
| 10 | A-010 | Booking write path: transaction, catch `23P01`, 409 with recomputed alternatives, confirmation via A-005. Concurrency harness with a real barrier; three race criteria (defect 2). | M | A-009, A-005 |
| 11 | A-011 | Customer booking flow UI (defect 28), WCAG 2.1 AA as acceptance criterion | M | A-010 |
| 12 | A-012 | Seed script: fixed anchor spanning both DST transitions, per-provider density spec, deterministic (defect 24) | S | A-010 |
| — | | **Demo checkpoint 1.** A seeded customer picks a service and a stylist, sees Tuesday's slots with the 12–1 break absent and 11:15 offered after the 10:00 booking, books, and gets a confirmation in the outbox. A scripted race for an *overlapping* slot yields exactly one winner. A direct `INSERT` bypassing the app is refused by the database. | | |
| 13 | A-013 | Appointment state machine: full 6×6 transition table, `AppointmentStatusEvent` rows, staff-only terminal corrections, cutoff resolver (defects 10–14) | M | A-010, A-005, A-006 |
| 14 | A-014 | Tokenized customer link: scoped, multi-use until `end + 24h`, revocable, rate-limited, no internal identifiers rendered (defect 15) | M | A-013, A-005 |
| 15 | A-015 | Reschedule as an explicit transition with the insert-then-release swap (defects 11, 16) | M | A-014, A-010 |
| 16 | A-016 | Staff day view: per-provider list + all-providers day view, status controls (defects 17, 18) | L | A-013, A-006, A-008 |
| 17 | A-017 | Ad-hoc block with conflict surfacing — story 9, promoted (defect 9) | M | A-016, A-008 |
| — | | **Demo checkpoint 2.** Customer reschedules from the emailed link, then cancels with the same link; staff blocks 10:30–12:00 over an existing booking and is shown the one conflict; staff marks a no-show and then corrects it to completed, and both transitions appear in the event log. | | |
| 18 | A-018 | Reminder job: 24h outbox rows, idempotent, skips cancelled/rescheduled (defect 23) | M | A-005, A-013, A-012 |
| 19 | A-019 | Owner dashboard: utilization to the frozen formula (defect 22) | M | A-012, A-008 |
| 20 | A-020 | Waitlist | M | A-018, A-013 |

The two structural moves are: **A-004 before A-009** (the storage shape is an input to the engine, not a consequence), and **A-005 before A-010** (the seam exists before the first thing that sends).

---

## Open questions that should be owner decisions

Written in the sibling's format — each row states what it gates and why it cannot be deferred.

| # | Question | Gates | Why it can't be deferred |
|---|---|---|---|
| OQ-1 | **What enforces "no double-booking" — application code, a transaction, or a database constraint?** And if a constraint: is buffer inside the stored interval, which statuses participate, and do time-off/ad-hoc blocks live in the same table? | A-004, A-009, A-010 | It is the schema. Goal 2 (line 17) claims "impossible, not just discouraged," which is only true of the database. Retrofitting a range column and a partial exclusion constraint is a migration plus every read query plus the engine's inputs. |
| OQ-2 | **Postgres or SQLite?** | A-001 — item #1 | Answered by the fixed stack, but the PRD reopens it. SQLite cannot express the constraint OQ-1 likely picks and cannot exercise the race at all; switching after item 4 invalidates every migration. |
| OQ-3 | **Where does the timezone live — Business only, or per-provider?** And do business hours exist as an entity that clamps provider hours? | A-004, A-008, A-009, A-018 | Line 67 says "the business's time zone" and line 65 says "closing," while P0-2 models only provider hours. The clamp is a second intersection step in the engine and a second exception table. Adding it later touches every slot test. |
| OQ-4 | **The `BusinessDate` / `Instant` type discipline, and the non-existent / ambiguous wall-clock policies.** | A-003 and everything downstream | This is R-042's bug in the sibling repo, where ten passing unit tests hid a day-off-by-one in how a date was read out of the database. It is cheaper as a type than as a debugging session. |
| OQ-5 | **Slot grid anchoring, and the full buffer semantics** (after-only or both sides; whose buffer between two appointments; does buffer count in utilization). | A-009, A-004, A-019 | The engine's output changes for every fixture; flipping it after the test matrix exists means rewriting the matrix, which is the artifact the metric on line 104 depends on. |
| OQ-6 | **Is `confirmed` a real state, and what actor causes it? Is there a hold-and-expire for unconfirmed bookings?** | A-004, A-013, A-018, and the exclusion-constraint predicate | A status value is never one edit (rental CLAUDE.md line 72). Every conflict query, reminder-eligibility query and transition guard reads the enum, and a decorative value costs the same as a real one. |
| OQ-7 | **Is reschedule a new row or a mutation of the existing one?** | A-013, A-015, A-018, A-019 | Decides whether history survives, whether a reschedule inflates the cancellation-rate metric, whether the pending reminder is voided, and whether the token re-points or reissues. All four are wrong in one direction if guessed. |
| OQ-8 | **Are terminal states correctable, by whom, within what window, with what audit?** | A-013, A-019 | `no_show → completed` is a daily real-world event. With no path, the only fix is a SQL edit and the no-show metric on line 108 is unfalsifiable. |
| OQ-9 | **Is there staff authentication in v1, or are staff routes deliberately unauthenticated?** | A-006, A-013 (line 76), A-016 | P0-5 line 76 requires distinguishing staff from customer and no requirement creates an actor. Without this, that criterion cannot be written and the day view's status controls are publicly reachable. |
| OQ-10 | **Token lifetime and multiplicity.** | A-014, A-010's confirmation email | D-16 is this decision, already made once in this idiom and made the other way here. Single-use fails on the second step of the ordinary workflow, and there is no TTL stated at all. |
| OQ-11 | **Is the provider the only conflict axis, or is there a room/chair resource?** | A-004 (the constraint's key), A-009 | The sample business is "a 4-chair salon." If chairs are a real constraint the exclusion constraint keys on `(resource_id, during)` and the engine intersects a second calendar. Adding an axis to a live constraint is a migration; ruling it out costs one sentence. |
| OQ-12 | **Minimum booking lead time and maximum booking horizon.** | A-009, A-011's date picker, A-012's seed window | "Slots in the past never render" (line 66) is not the same rule as "not in the next 5 minutes," and the horizon caps the API's range parameter and the seed's shape. |
| OQ-13 | **Is a customer identified by email, and may one customer hold overlapping appointments?** | A-004, A-010 | Decides whether `Customer` is a real table or denormalised contact fields, and whether the write path needs a second conflict check on the customer axis. A double-booked customer is a real support call and the constraint is on the wrong entity to catch it. |
| OQ-14 | **The seed anchor: fixed date or relative to `now`?** And the per-provider density targets. | A-012, both metric sets | A relative anchor makes the DST tests exist in March and vanish in July, without a single failing test to tell you. |
| OQ-15 | **The exact utilization formula** (numerator statuses; whether the denominator subtracts breaks, time off and buffer; the zero-denominator rendering). | A-019, the metric on line 107 | "Within 1% of hand-calculated" is not reproducible six months later. The formula is one line now and an argument later. |
| OQ-16 | **Is WCAG 2.1 AA an acceptance criterion on the customer booking flow?** | A-011, A-016 | The sibling makes it one and says explicitly it is "not a later cleanup." A slot grid is among the hardest a11y surfaces there is, and axe is already in the stack. |
