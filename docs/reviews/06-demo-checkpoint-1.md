# Demo checkpoint 1 — the walk

**Walked 2026-08-16, at the Milestone 2 boundary (A-010 closed it).**
**Result: it ran, and it found one real defect.**

The backlog's instruction is to walk it when the milestone closes, not when
convenient, because rental's checkpoint-1 found four defects that all sat in
items already marked ✅ and every one was invisible from inside the item that
introduced it (D-28). That is exactly the shape of what turned up here.

The walk was scripted rather than clicked, so the output below is transcript,
not recollection. The script has been deleted; what it found lives on as
`packages/db/booking/confirmation.test.ts`.

---

## What the checkpoint asked for, and what happened

### 1. Tuesday's slots, with the 12–1 break absent — ✅

Dana, Tuesday 2026-06-09, hours 09:00–17:00 with a 12:00–13:00 break, one
45-minute Cut booked at 10:00:

```
Offered for Cut    : 09:00 11:00 11:15 13:00 13:15 13:30 13:45 14:00 14:15
                     14:30 14:45 15:00 15:15 15:30 15:45 16:00 16:15
Offered for Colour : 13:00 13:15 13:30 13:45 14:00 14:15 14:30 14:45 15:00
Starts landing inside the break window: (none)
```

The break is absent, the 10:00 booking is absent, and so is everything whose
body or buffers would cover either. The 120-minute Colour correctly disappears
from the whole morning — there is no 120-minute gap before the break.

### 2. Books, and the outbox holds one confirmation with a manage link — ❌ **DEFECT**

This is the one. See below.

### 3. A race for an overlapping non-identical slot — ✅

```
winners: 1, losers: 1
  loser: SlotTaken · alternatives offered: 9
```

Two concurrent bookings for *overlapping but different* instants (09:00 and
10:00 for a 120-minute service). Exactly one won; the loser got `SlotTaken`
carrying nine fresh alternatives, not a bare error.

### 4. A direct SQL insert of an overlapping appointment — ✅

```
direct overlapping INSERT rejected with: 23P01
```

Bypassing the application entirely. The database refused it, with
`exclusion_violation` — not `23505`, which is the distinction the whole D-2
design rests on.

### 5. The suite under `TZ=Pacific/Kiritimati` — ✅

Green, and CI runs both zones on every push.

---

## The defect: every outbox row was orphaned

**`NotificationOutbox.appointmentId` was never written. Not once. 228 seeded
rows, all `NULL`.**

The column exists deliberately. It was added at the M1 boundary on the salon
operator's recommendation (R-4) so that the appointment detail panel can answer
*"was she actually told?"* in one indexed lookup, and it has an index for
exactly that. `A-027` in the backlog names it explicitly as its data source.

Three items touch this, and **each of them was correct in isolation**:

- **A-003** added the column, the index and the `onDelete: Restrict` foreign key.
- **A-004** built `enqueueNotification`, whose `EnqueueInput` had no
  `appointmentId` field at all.
- **A-009** enqueued the confirmation inside the booking transaction, passing
  the appointment id **in the JSON payload**.

Every test passed. The payload genuinely contained the id, so anything
inspecting a row saw the id sitting right there — it just was not a foreign
key, was not indexed, and could not be looked up by. The consequence is that
A-027's core feature would have been built against a query returning zero rows,
and the `Restrict` protecting a notified appointment from deletion was inert.

**Why no existing test caught it:** A-009 had *no test of its outbox enqueue at
all*. Its tests are the race tests, and they assert appointment rows. A-004's
tests exercise enqueue thoroughly — but enqueue was never asked to store an
appointment id, so testing it faithfully could not reveal the gap. The missing
assertion lived in neither item. It lived in the seam.

**Fixed** by adding `appointmentId` to `EnqueueInput` and passing it from the
booking path. Mutation-tested: reverting the one-line fix fails 5 of the 6 new
tests.

---

## A second finding, in my own new test

The regression suite originally included *"refuses to delete an appointment
that has been announced"*. It passed. It also passed **with the fix reverted** —
`AppointmentEvent`'s own `onDelete: Restrict` blocks the delete first, and the
event log is append-only by trigger, so the outbox's restrict can never be
observed in isolation.

A true assertion that cannot fail for its stated reason is worse than no test,
because it reads like coverage. It has been removed, with a note in the file
saying why, so it does not get helpfully re-added.

This is worth recording as its own lesson: **the checkpoint's habit — asking
whether a passing test can fail — found a bad test in the very fix written to
address the checkpoint's finding.**

---

## One discrepancy in the checkpoint's own wording — no code change

The backlog narrates *"11:15 first after the 10:00 booking"*. The engine offers
**11:00**, and the engine is right: the seeded Cut is 45 minutes with a
10-minute after-buffer, so the 10:00 booking blocks 10:00–10:55 and 11:00 is
the first grid candidate clear of it. `11:15` is the answer for a 60-minute
service with a 15-minute buffer — the shape used in `races.test.ts`, which is
presumably what the prose was written against.

The prose predates the seed. Left alone rather than "fixed" in either
direction, but recorded here so the next reader does not mistake a stale
example for a regression.

---

## Verdict

Four of the five narrated steps passed on the first walk. The fifth found a
defect of precisely the predicted class — invisible from inside every item that
contributed to it, discoverable only by asking the question the way a later
screen will ask it.

The checkpoint paid for itself, on schedule, for the third build running.
