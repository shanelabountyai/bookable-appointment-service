# Operator Review — Bookable draft PRD

**Reviewer persona:** senior multi-site service-business operator (salon + med spa owner, ex-ops manager for a 14-van HVAC company). **Reviewed:** `prd-bookable-appointment-app.md` draft v1, 2026-08-14.

---

### Verdict

The shape is right for a scheduling *engine* and wrong for a *book*. P0-1 through P0-4 will teach the builder interval math honestly, and the time-zone convention (store UTC, compute in business TZ, DST test on the matrix) is better handled than most shipped products I've paid for. But every requirement in here describes a world where appointments start when they were booked, a service is one number of minutes, and the person booking is the customer — and none of those three things is true in any service business I have ever run. The single most consequential gap: **there is no concept of an appointment actually starting.** No check-in, no in-progress, no actual start/end, no way to say "Dana is 40 minutes behind, shift her column." That one omission is what puts the paper book back on the desk by week two, because on a Saturday the front desk's entire job is answering "when is she actually getting to me" and this system cannot answer it.

### Recommendations

---

**1. Model actual time, not just booked time — check-in, in-progress, and running-late cascade**

- **Operator problem** — 10:00 colour walks in at 10:12, sits down at 10:20 because the shampoo bowl is busy, and finishes at 11:40 instead of 11:15. The 11:15 cut is in the waiting area asking what's going on. Right now the screen says both appointments are "confirmed" and everything is fine. It is not fine, and the receptionist now has a sticky note that says "Dana +40" — that sticky note is the shadow calendar.
- **What it needs to do**
  - Add `checked_in` and `in_progress` to the lifecycle, with `actual_start_at` and `actual_end_at` on the appointment, distinct from `scheduled_start_at`/`scheduled_end_at`.
  - Day view computes and displays a per-provider **running delta** (e.g. "Dana: +38 min") derived from in-progress actual start vs scheduled, and projects a revised expected-start time for every remaining appointment in that column.
  - Staff action "push column from here" — shifts selected downstream appointments by N minutes, showing which ones would then collide with a break, closing time, or another provider's hold, and refusing silently-lossy shifts.
  - A pushed appointment records the change and can trigger a "we're running about 30 min behind" notification to the affected client (into the stubbed outbox — no real SMS needed).
  - Slot computation for *same-day* availability must consider the running delta, not just the booked grid, or the front desk will keep booking into time that no longer exists.
  - Availability/booking logic stays a pure function; running delta is an input, which is the interesting version of the learning exercise anyway.
- **Money/trust impact** — In my salon a 40-minute cascade on a Saturday costs one to two dropped clients per column when people walk out of the waiting area (my own numbers: ~$95–$180 each), plus the receptionist absorbing four angry conversations she has no data to answer. Trust cost is worse: staff stop believing the screen.
- **Requirement fit** — Expand **P0-5 (lifecycle)** to include check-in/in-progress and actual timestamps; expand **P0-7 (staff day view)** with delta display and push-column. This is P0, not a nicety.
- **Confidence** — High. Nothing would raise it; this is the daily reality of every appointment business I've operated.

---

**2. Services need segmented duration (active / passive / active), not one number**

- **Operator problem** — A full colour is 45 min at the chair, 35 min processing where the client sits and the colourist is free, then 30 min at the bowl and blow-dry. With one 110-minute duration, my best colourist does four clients on a Saturday. With processing modeled, she does six or seven. That gap is the difference between a good colourist staying and leaving. Same shape in the med spa (numbing time) and in HVAC (waiting on a system to cycle).
- **What it needs to do**
  - Service duration becomes an ordered list of segments, each `{minutes, provider_required: true|false, resource_required: true|false}`. A simple cut is one segment; a colour is three.
  - The slot engine consumes provider time only from provider-required segments; the chair/room is held across all segments.
  - The engine can offer a slot to a second client that lands entirely inside another appointment's passive segment, provided a resource is free.
  - Guard rail: a provider-required segment can never overlap another provider-required segment for the same provider — that's the "impossible by accident" line.
  - Acceptance test worth writing: colour booked 10:00 (45 active / 35 passive / 30 active) leaves a genuine 35-min provider window at 10:45; a 30-min blow-dry is offered there and does not push the colour's second active segment.
- **Money/trust impact** — My own estimate from my floor: two extra colour clients per colourist per Saturday at ~$180 is $300–360 of incremental revenue per stylist per Saturday that a single-duration engine structurally cannot capture.
- **Requirement fit** — Rewrite **P0-1 (service catalog)** and **P0-3 (slot engine)**. This is also the single best thing in the PRD from a *learning* standpoint — it turns slot computation from one-dimensional interval subtraction into a two-resource constraint problem, which is where the real bugs live.
- **Confidence** — High that it's required; medium on whether the builder should do overlap-booking in v1 vs. just modeling the segments and exposing the gap to staff. Booking into the gap manually first is a defensible v1.

---

**3. Chairs and rooms are a real constraint — model resources**

- **Operator problem** — I have 4 chairs and 5 stylists on a Saturday. I have 6 med spa rooms and one laser. Provider availability alone will happily book five people into four chairs, and the moment recommendation #2 lands, "book into the processing gap" is unsound without knowing whether a chair exists to put them in.
- **What it needs to do**
  - Resource types with a capacity pool (chairs: 4; laser: 1; shampoo bowl: 2).
  - Services declare which resource type(s) each segment requires.
  - Slot availability = provider free **AND** a unit of every required resource free for that interval.
  - Resource conflict produces the same atomic rejection as provider conflict (**P0-4**), and the day view can be grouped by resource, not only by provider.
  - Keep it a pool count, not named-seat assignment, for v1 — capacity is the constraint that bites; seat identity mostly isn't.
- **Money/trust impact** — Without this, the first time the software offers a slot with no chair, staff learn the software lies and start checking the room before accepting a booking. That is a shadow calendar with extra steps.
- **Requirement fit** — New item, P0, sitting between **P0-2** and **P0-3**, because the slot engine's signature depends on it. Retrofitting a second constraint dimension into a finished engine is the expensive version.
- **Confidence** — High for salon/med spa. Lower for the HVAC framing in the PRD's header (there the constraint is vans and parts), but the model generalizes.

---

**4. Staff-side booking is the primary path, not a fallback**

- **Operator problem** — Seven of ten bookings in my salon still come through the phone or the front desk at checkout. The user stories here are five customer-first stories and a read-only day view. If the fastest way for my receptionist to book a client is to open the customer-facing flow and type a fake email address, she will instead write it in a book — and I will fire the software, which I have done before.
- **What it needs to do**
  - "New appointment" from the day view: pick provider/service/time in a couple of clicks, client looked up by **phone number first**, email optional.
  - Staff can book a walk-in "starting now" against the next free provider without picking a slot from a grid.
  - Staff can override: book outside posted hours, book into a buffer, or knowingly double-book a provider — each requiring a reason and writing an audit record. **P0-4's "conflicting bookings impossible" must mean impossible by accident, always possible on purpose with a trail.** A system that flatly refuses is the #1 reason staff go around it.
  - Staff can create an appointment with no client record at all ("walk-in, no name") and attach identity later.
  - Client search must tolerate partial phone, partial name, and duplicates.
- **Money/trust impact** — This is binary. If the staff path is worse than paper, adoption is zero and every other feature in the PRD is dead code.
- **Requirement fit** — New P0 requirement (**P0-8: staff booking and override**), and add matching user stories. Currently the only staff stories are 3, 5, and 9.
- **Confidence** — High.

---

**5. Duration and price vary by provider, not just by service**

- **Operator problem** — My master stylist does a cut in 35 minutes; my newest does the same cut in 60 and charges $30 less. If the book allots 45 to both, one runs over every single time and the other has dead air all day. Within two weeks the junior's column has a manual "don't book me tighter than an hour" rule living in the receptionist's head.
- **What it needs to do**
  - Provider×service join carries optional `duration_override` (or per-segment overrides), `price_override`, and `is_qualified`.
  - Slot engine uses the provider-specific duration when computing; "any available provider" search must compute per provider, not with a single service duration.
  - Admin sees which providers are unqualified for a service and those providers never appear in that service's booking flow.
  - Deactivating a provider's qualification does not break existing bookings.
- **Money/trust impact** — My own estimate: a junior consistently running 15 min over costs about one lost appointment slot per day, and it's the most common reason a stylist quietly starts blocking her own time.
- **Requirement fit** — Inside **P0-1** (it already says "assigned providers" — that assignment needs attributes) and **P0-3**.
- **Confidence** — High.

---

**6. `confirmed` is a dead state — build the confirm/decline loop**

- **Operator problem** — The lifecycle says `booked → confirmed` but nothing in the requirements ever performs that transition. So every appointment sits in `booked` forever and the state is decoration. Meanwhile the actual operational value is exactly this: Friday afternoon I want a list of everyone on Saturday who has *not* confirmed, so we can call them. That call-down list is the second half of the no-show fix that reminders alone don't deliver.
- **What it needs to do**
  - The reminder (P1-1) carries confirm and cancel actions on the tokenized link; confirm sets `confirmed_at` and transitions state.
  - Staff can mark confirmed manually ("spoke to her, she's coming") — most confirmations happen by voice.
  - Day view and a "tomorrow" view filter to unconfirmed appointments, sorted by value or by client no-show history.
  - Unconfirmed status must be visible on the appointment itself, not buried in a report.
  - No-reply after the reminder does not auto-cancel. Ever. Quietly cancelling a client who is on her way is the incident that gets a receptionist screamed at.
- **Money/trust impact** — In my book the call-down catches two to four Saturday no-shows a week (my own numbers; $95–$180 each). It's the highest-yield 20 minutes the front desk spends.
- **Requirement fit** — Fix **P0-5**, and promote the confirm action out of P1-1 into P0-6 (the tokenized link already exists there).
- **Confidence** — High. This is also a straightforward correctness bug in the PRD as written.

---

**7. No-show and late-cancel must be tracked per client and acted on at booking time**

- **Operator problem** — Goal #4 of this PRD is reducing no-shows, and the data model can neither measure nor act on them. A no-show is marked, and then nothing. The client who has burned three Saturday colour slots this year books a fourth one online at 9am Saturday and nobody at the desk knows. Deposits are a Non-Goal — fine — but then the *only* remaining levers are memory and friction, and this design gives the front desk neither.
- **What it needs to do**
  - Distinguish `cancelled` from `cancelled_late` (inside the cutoff) at the state level. Lumping them makes the cancellation-rate report in P1-2 a number I cannot act on — normal cancels are healthy, late cancels are theft of inventory.
  - Rolling counts on the client record: no-shows and late cancels in the trailing 12 months, with the appointment references.
  - A flag surfaced everywhere the client appears — booking flow, day view chip, reminder list.
  - Configurable policy: after N no-shows, self-serve booking for that client is blocked and routed to "call the salon" (staff can always still book them). This is the closest honest substitute for a deposit, and it costs nothing to build.
  - Staff marking no-show must be reversible with a reason — receptionists mis-tap, and a wrongly flagged good client is a lost client.
- **Money/trust impact** — Two no-shows a week on a Saturday colour column is roughly $360/week, ~$18k/year in my shop (my own estimate). The repeat offenders are a small, identifiable group, which is exactly why per-client history is the lever.
- **Requirement fit** — Extend **P0-5** (state machine) and the client record; feeds **P1-2**. The `cancelled_late` distinction is P0 — without it the PRD's own success metrics are dishonest.
- **Confidence** — High.

---

**8. Client record with history and notes — this is what makes rebooking fast**

- **Operator problem** — "Book via email + confirmation link" implies clients are identified by an email address. My front desk books by phone; half my clients give a wrong or shared email; two "j.smith@gmail" typos become two client records and the history is gone. And when Maria calls to rebook, the receptionist's entire job is: who did she see, what did she get, what was the formula, does she like Thursday mornings. Without that, a 40-second rebook becomes a four-minute one, times 60 calls a Saturday.
- **What it needs to do**
  - Client entity keyed on phone (normalized), email optional, with merge-duplicates for staff. No login required — this is a server-side record, fully compatible with the customer-accounts Non-Goal.
  - Client detail shows appointment history: date, provider, service, price, status — including no-shows.
  - "Rebook last visit" one-click: prefills same provider + same service, jumps the slot search to the client's preferred day-part and the natural interval (6 weeks for colour).
  - Two note fields: **client notes** (long-lived — formula, allergies, sensitivities, "hates small talk") pinned visibly on every appointment, and **appointment notes** (this visit only).
  - Preferred provider recorded and defaulted; "last seen" date visible.
  - In a med spa context the allergy/contraindication note is a safety requirement, not a convenience.
- **Money/trust impact** — Rebooking at checkout is the highest-conversion moment in the business. My own estimate: pre-booking the next visit before the client leaves the chair converts far better than any reminder campaign, and it's purely a speed-of-lookup problem.
- **Requirement fit** — New P0 (**P0-9: client record**). The PRD currently has no client entity at all, which is a modeling hole, not just a feature gap.
- **Confidence** — High.

---

**9. Cancellations create perishable supply — waitlist must be P0-adjacent and matched properly**

- **Operator problem** — A 2pm Saturday colour cancels at 9am. That slot is worth $180 for five hours and then it's worth zero. P1-3 as written ("customer joins waitlist for a full day; notify first in line") doesn't work: the first person in line may want a 90-minute service that doesn't fit a 60-minute hole, may want a different stylist, and won't check her phone for two hours while the slot rots.
- **What it needs to do**
  - Waitlist entry = service + acceptable providers + acceptable date range + acceptable day-parts (e.g. "any Saturday morning, Dana or Priya").
  - On cancellation, match the *freed interval* against entries — the service (with per-provider duration and segments) must actually fit, and required resources must be free.
  - Offer with a hold: the slot is soft-held for the offered client for a configurable window (30 min), then rolls to the next match. Offer to the next 2–3 in parallel with an explicit "first to accept" is also acceptable and often better — pick one and state it.
  - Staff see a "who wants this?" panel on any freed slot so the receptionist can just call the top match — the phone still beats notifications.
  - A soft-held slot must be invisible to general self-serve booking but bookable by staff with an override.
- **Money/trust impact** — Backfilling even a third of Saturday cancellations is, by my count, $150–400 a Saturday recovered. Given that deposits are off the table, this is the primary compensating control for cancellation loss and should be weighted accordingly.
- **Requirement fit** — Promote **P1-3** and rewrite it. If phasing forces a cut, ship the staff-facing "who wants this slot" panel (cheap) and defer automated offers.
- **Confidence** — High on the matching requirements; medium on parallel-vs-sequential offers — I'd want to watch how fast my own clients actually respond.

---

**10. One visit, multiple services**

- **Operator problem** — "Cut and colour" is one appointment to the client and to the chair, and roughly half my Saturday book. This PRD's appointment holds exactly one service. Staff will fake it by booking two adjacent appointments, which then cancel independently, reschedule independently, stack two buffers, and produce a double-counted client in every report.
- **What it needs to do**
  - Appointment holds an ordered list of service lines; total duration is the composed segment sequence, not a sum.
  - Buffers do not stack between lines of the same visit — one buffer at the end of the visit.
  - Lines may be with different providers (colour with Dana, blow-dry with the assistant) — the engine must find a time where both chains fit, which is the genuinely hard and genuinely valuable case.
  - Cancelling the visit cancels all lines; removing one line recomputes the end time and frees the tail.
  - Reporting counts one visit and attributes revenue/time per provider.
- **Money/trust impact** — Mostly a data-integrity and staff-friction issue rather than direct revenue, but it corrupts utilization and no-show reporting, which is what the owner dashboard is for.
- **Requirement fit** — Extend **P0-1**/**P0-3**/**P0-5**. The multi-provider case can be P1; single-provider multi-service should be P0.
- **Confidence** — Medium-high. Single-provider multi-service is non-negotiable; the cross-provider chain is defensible to defer.

---

**11. The schedule changes under booked appointments — build the impact workflow**

- **Operator problem** — It's Friday night and Dana texts that she's sick. She has nine appointments on Saturday. Or I change her standing hours to end at 4 and there are already three bookings at 4:30. User story 9 names this edge case and then no P0 requirement covers it. This is the single highest-stress event in the business and it is exactly where a booking platform either earns its keep or gets abandoned.
- **What it needs to do**
  - Any availability change (time off, hours edit, ad-hoc block, provider deactivation) runs an **impact preview first**: here are the N existing appointments that now conflict, with client names and phone numbers.
  - Staff choose per appointment: keep as-is (accept the conflict, flagged), reassign to another qualified provider, offer a new time, or cancel with notification.
  - Never silently cancel, move, or hide an existing appointment. This is the "the system quietly moved a confirmed appointment" failure and it burns client trust permanently.
  - Conflicting-but-kept appointments render with a visible conflict marker on the day view until resolved.
  - Bulk action: "reassign Dana's Saturday to Priya where qualified" with a per-appointment result list.
- **Money/trust impact** — Nine appointments times an average ticket is most of a stylist's Saturday. The difference between a nine-appointment rescue and nine angry clients is entirely whether the software gives the front desk the list and the phone numbers in one screen.
- **Requirement fit** — Promote user story 9 into a P0 requirement (**P0-10: availability change impact**). It's already acknowledged as an edge case; it's actually a core workflow.
- **Confidence** — High.

---

**12. Day view must be a multi-provider timeline you can act on, not a list**

- **Operator problem** — On a Saturday I need to see four columns side by side with a now-line, so I can answer "who's free at 2" in one glance and drop the walk-in in. P0-7 specifies "chronological list per provider with status controls." A list per provider cannot show me the shape of the day, and status-only controls mean any actual change forces the receptionist somewhere else while a client stands at the desk.
- **What it needs to do**
  - Column-per-provider day grid with time gutter, a current-time line, and visual distinction for booked / confirmed / in-progress / late / no-show / blocked / passive-processing segments.
  - Direct manipulation from the grid: move an appointment to another time or another provider (revalidated against the engine and rejected with a reason if invalid), extend/shorten duration, add a service, add a note, check in.
  - Empty gaps are clickable to book; gaps show their length so "I've got a 30 at 2:15" is readable at a glance.
  - Client chips show phone, no-show flag, unconfirmed flag, and pinned client note.
  - Keep the polling/no-manual-refresh requirement — that part is right, and it matters most when two people at the desk are booking at once.
- **Money/trust impact** — This is where 90% of staff time in the product is spent. Speed here decides whether the paper book comes back out.
- **Requirement fit** — Rewrite **P0-7**. Also note that Goal #3 ("manage a full day's schedule from one screen") is not achievable with the current wording.
- **Confidence** — High.

---

**13. Every appointment carries a change history**

- **Operator problem** — A client is at my desk with a confirmation email saying 3pm and the screen says 3:30. Nobody can tell me who moved it or when. That argument ends with a free service and a lost client, and it also ends with staff distrusting the system in a way they never recover from.
- **What it needs to do**
  - Immutable event log per appointment: created / rescheduled / status change / provider change / override-booked / notification sent, each with actor (staff user, customer token, or system) and timestamp with before/after values.
  - Visible in the appointment detail, in plain language, to any staff member.
  - Reschedule (**P0-6**) writes both sides of the swap as one event, not two unrelated records.
  - Overrides from recommendation #4 land here with their reason string.
  - The stubbed notification outbox is queryable per appointment: "was she actually told?" is the question that settles the argument at the desk.
- **Money/trust impact** — Low direct revenue, high trust. One unexplainable "the system moved it" incident does more damage to staff adoption than a month of small bugs.
- **Requirement fit** — New item, P0-lite — cheap to build alongside **P0-5**/**P0-6** and nearly impossible to backfill later. Good learning value: it's the natural companion to a state machine.
- **Confidence** — High.

---

### Do not build

- **The reminder-on vs reminder-off seeded no-show cohort metric.** You seed the no-shows, so you will measure your own seed parameters and report it as a finding. It's a fabricated result dressed as evidence. Replace it with something real: assert that reminders fire exactly once per eligible appointment, never for cancelled ones, and correctly at DST boundaries — that's a genuine test of the scheduler.
- **Utilization "accurate within 1% of hand-calculated values."** The precision is meaningless until you've decided whether buffers, passive processing time, and blocked time count in the numerator or denominator — and once segmented durations exist, "available minutes" has two defensible definitions (provider minutes vs chair minutes). Define the denominators first; directional accuracy is plenty. Chasing 1% against an undefined formula is pure busywork.
- **The unused `payment_status` field.** Speculative columns rot and mislead the next session. If you want lifecycle headroom now, spend it on states you actually need — `cancelled_late`, `checked_in`, `in_progress`. (`business_id` on core tables is different and worth keeping — it's free and it's a real tenancy boundary.)
- **Any hard block on staff creating a conflicting booking.** P0-4's "makes conflicting bookings impossible, not just discouraged" is correct for the customer-facing path and wrong for staff. Enforce it absolutely on self-serve; make it a warn-and-record on the staff path. Every platform I have abandoned died of this exact rule.

### What's already good

Time-zone handling (store UTC, compute in business TZ, DST-transition day in the test matrix), atomic booking with a scripted race test, the slot engine as a pure function with tests first, and the seed script as a P0 deliverable — that's the correct spine and better discipline than most commercial products in this category. Date-specific overrides beating the weekly pattern is the right precedence rule. Keep all of it; the recommendations above are about what the engine is fed and who is allowed to touch it, not about replacing it.
