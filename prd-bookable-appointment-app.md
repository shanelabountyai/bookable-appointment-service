# PRD: Bookable — Appointment Scheduling for a Service Business

**Sample business:** "Shear Genius," a 4-chair salon (works equally for HVAC, med spa, tutoring)
**Builder:** Solo, in Claude Code
**Status:** Draft v1
**Learning objectives:** availability computation, conflict detection, time-zone-safe datetime handling, state transitions, notification triggers

---

## Problem Statement

Service businesses lose revenue to phone tag, double-bookings, and no-shows. Staff spend hours daily managing a paper or spreadsheet calendar, and customers can't see availability or book outside business hours. Without a system, ~20–30% of bookable time goes unused or gets double-booked (industry-cited range for manual scheduling; treat as hypothesis for this sample).

## Goals

1. A customer can find and book an open slot in under 90 seconds without staff involvement.
2. Zero double-bookings: the system makes conflicting bookings impossible, not just discouraged.
3. Staff can view and manage a full day's schedule from one screen.
4. Automated reminders reduce simulated no-show rate (measurable via a seeded test dataset).
5. **(Builder goal)** Exercise scheduling logic, datetime edge cases, and status state machines — the feature families absent from the rental/storage projects.

## Non-Goals

- **Payments/deposits** — separate feature family; covered by Project #2 (subscriptions). Adding it here dilutes the scheduling focus.
- **Multi-location support** — adds tenancy complexity without new scheduling concepts.
- **Native mobile app** — responsive web is sufficient; mobile packaging teaches nothing about scheduling.
- **SMS delivery integration (Twilio etc.)** — stub notifications to a log/console; real delivery is config, not logic.
- **Customer accounts/login** — book via email + confirmation link. Auth is a separate learning project.

## Personas

- **Customer** — books, reschedules, cancels.
- **Staff member (provider)** — owns a calendar, sets working hours, marks appointments complete/no-show.
- **Owner/Admin** — configures services, staff, business hours; sees reports.

## User Stories (priority order)

1. As a customer, I want to see real-time open slots for a chosen service and provider so that I can book without calling.
2. As a customer, I want to book a slot and get an instant confirmation so that I know it's locked in.
3. As a staff member, I want my working hours, breaks, and time off reflected in my availability so that customers can't book me when I'm out.
4. As a customer, I want to reschedule or cancel via a link in my confirmation so that I don't need staff help.
5. As a staff member, I want a day view of my appointments with statuses so that I can run my day from one screen.
6. As an owner, I want to define services with durations and buffer times so that back-to-back bookings don't collide in practice.
7. As an owner, I want a report of bookings, cancellations, and no-shows by provider so that I can spot patterns.
8. As a customer, I want a reminder 24h before my appointment so that I don't forget. *(edge: reminder must not fire for cancelled appointments)*
9. As a staff member, I want to block off ad-hoc time (dentist, emergency) so that new bookings avoid it — and I want to see any existing bookings that now conflict. *(edge case: blocking time over an existing booking)*

## Requirements

### Must-Have (P0)

**P0-1: Service catalog**
Services have name, duration (minutes), buffer-after (minutes), and assigned providers.
- [ ] Admin can create/edit/deactivate services
- [ ] Deactivating a service hides it from booking but preserves history

**P0-2: Provider availability model**
Weekly recurring working hours per provider + date-specific overrides (time off, modified hours).
- [ ] Given a provider works Tue 9–5 with a 12–1 break, when a customer views Tuesday, then no slots render 12–1
- [ ] Date-specific override beats the weekly pattern

**P0-3: Slot computation engine** *(the core learning artifact)*
Available slots = working hours − breaks − time off − existing bookings − buffers, discretized to a configurable interval (default 15 min).
- [ ] Given a 60-min service with 15-min buffer and a booking 10:00–11:00, when slots are computed, then 11:00 is unavailable and 11:15 is the first offered slot
- [ ] A service longer than the remaining window before a break/closing does not render a slot
- [ ] Slots in the past never render
- [ ] All computation is done in the business's time zone; stored timestamps are UTC

**P0-4: Atomic booking with conflict rejection**
- [ ] Given two customers submit the same slot near-simultaneously, then exactly one succeeds and the other gets a clear "slot taken" error with refreshed alternatives (test with a scripted race)
- [ ] Booking writes are transactional — no partial state

**P0-5: Appointment lifecycle**
States: `booked → confirmed → completed | no_show | cancelled`; `booked → cancelled` allowed until a configurable cutoff (default 2h before start).
- [ ] Invalid transitions are rejected (e.g., completed → cancelled)
- [ ] Cancellation inside the cutoff window is blocked for customers but allowed for staff

**P0-6: Self-serve reschedule/cancel**
Tokenized link in confirmation (no login).
- [ ] Reschedule reuses the slot engine and atomically swaps old/new
- [ ] Used or expired tokens fail safely with a clear message

**P0-7: Staff day view**
- [ ] Chronological list per provider with status controls (complete / no-show)
- [ ] Reflects new bookings without manual refresh (polling is acceptable)

### Nice-to-Have (P1)

- **P1-1: Reminder scheduler** — 24h-before reminders written to an outbox table/log; skips cancelled appointments. *(Good headless/cron learning add-on.)*
- **P1-2: Owner dashboard** — bookings, cancellation rate, no-show rate by provider, utilization % (booked minutes ÷ available minutes).
- **P1-3: Waitlist** — customer joins waitlist for a full day; cancellation triggers notification to first in line.

### Future Considerations (P2)

- Deposits/prepayment (design the booking record with a `payment_status` field now, unused)
- Multi-location (keep `business_id` on all core tables even with one business)
- Recurring appointments (every 4 weeks) — informs why slot computation should be a pure function

## Success Metrics (evaluated against a seeded demo dataset)

**Leading**
- Booking flow completion: ≥90% of scripted test bookings succeed first try
- Double-booking rate: 0 across the race-condition test suite
- Slot computation correctness: 100% pass on an edge-case test matrix (DST transition day, month boundary, provider with split shifts)

**Lagging (simulated)**
- Utilization visible and accurate within 1% of hand-calculated values
- No-show rate delta measurable between reminder-on and reminder-off seeded cohorts

Measurement method: automated test suite + a seed script generating 4 providers, 8 services, and 200 appointments across 30 days.

## Open Questions

- **(Builder)** SQLite or Postgres? SQLite is enough; Postgres adds realism for transactional conflict tests. *(non-blocking — start SQLite)*
- **(Builder)** Render slots server-side or compute client-side from availability data? Server-side keeps one source of truth. *(blocking — decide before P0-3)*
- **(Product)** Should buffer time belong to the service or the provider? V1: service. *(resolved — revisit in P2)*

## Timeline / Phasing

- **Phase 1:** P0-1 through P0-4 (catalog + availability + slot engine + atomic booking) — this is the heart; everything else is UI around it
- **Phase 2:** P0-5 through P0-7 (lifecycle, self-serve links, day view)
- **Phase 3:** P1 items as follow-ups; write the DST edge-case tests before calling Phase 1 done

## Build Notes for Claude Code

- Write the slot engine as a pure function with its own test file first (TDD) — it's the highest-defect-risk component
- Seed script is a P0 deliverable, not an afterthought: demos and metrics depend on it
- Keep a CLAUDE.md documenting the time-zone convention (store UTC, compute in business TZ) — future sessions will violate it otherwise
