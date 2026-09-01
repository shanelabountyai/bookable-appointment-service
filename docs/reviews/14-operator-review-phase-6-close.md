# Operator review — Phase 6 close

**Run 2026-09-01, after A-065 (demo checkpoint 5) closed Phase 6 and emptied the
backlog for the seventh time.**

**The reviewer's own verdict:** *"This is the strongest of the five reviews I
have written on this build. The book is now genuinely runnable."* What follows
is not a list of missing features. It is one shape, found repeatedly:

> **Phase 6 added three new ways for the state of the day to change, and did
> not tell the readers that model the day.**

That is checkpoint 5's lesson one layer up. Checkpoint 5 concluded *a constraint
is never one edit either* and named three readers of the room. Recommendations 1
and 2 below are the same failure about **state changes** rather than about a
constraint: A-018 moves `startAt` and does not tell the running-late delta;
A-055 frees time and does not tell the list whose whole job is selling freed
time.

Every claim below was verified by grep or by reading the named file, by the
reviewer and then independently a second time before it was written here. The
three load-bearing ones were re-checked: `grep runningLate packages/db/day/push-column.ts`
returns nothing; `opened.ts:85` filters `SLOT_FREEING_STATUSES`, which
`status.ts:38` defines as `['cancelled', 'cancelled_late']`; `day-view.ts:295`
selects `notes` and `view-model.ts:307` maps only `clientNotes`.

---

## 1. Pushing the column leaves the running-late delta standing — S

Dana is 40 behind at 11:00. The desk sets +40, correctly — the website stops
selling her 11:15. At 12:30 she is clearly not catching up, so they push the
column +40 and every appointment moves. **The delta is still 40.**

Mrs Hall's 15:10 chip now reads "→ likely 15:50". The ring-round list tells the
desk to phone six clients about a delay already applied to their booked times.
The "told her about 40 min" marks from before the push still read as handled.
And the engine keeps subtracting a 40-minute `running-late` interval from a
column that is now honest, so it refuses to sell a gap that genuinely exists.

**Verified.** No hits for `runningLate` in `push-column.ts`. `clearRunningLate`
is called from exactly two places — `setRunningLate` when minutes ≤ 0, and the
Clear button in `apps/web/lib/day/actions.ts`. `view-model.ts:329` projects
`shift(appointment.startAt, column.runningLateMinutes)` for every `booked` chip,
and `push-column.ts:541` has already moved `startAt`. `day-view.ts:317` feeds
the same unreduced `minutes` into `lateCallList`.

**Why it is first.** *"This is the failure that puts the paper book back on the
counter. Staff read a projected time, tell a client on the phone, and the screen
is wrong by 40 minutes in the one hour of the week when nobody has slack to
check."* And the second-order cost is worse than the first: after that, the
delta stops being set at all, and the website goes back to selling 11:15.

**Needs a decision, not just a fix.** D-41 records what running-late may do and
never says what a push does to it. The partial-push arm in particular
(D-26 leaves some behind) must be settled and written down: reduce by the amount
actually applied, or refuse to reduce and say so. *Silently reducing on a
half-move is worse than not reducing.* Reviewer's confidence: **high** on the
defect, **medium** on the partial arm — they did not trace `pushColumn`'s return
when it moves five of eight.

## 2. Time freed by anything other than a cancellation never reaches "What's opened up" — S–M

Mrs Hall is booked cut + full head, two hours with Dana on Saturday. She sits
down and asks for the roots only. A-055 does exactly what it should — the visit
shortens, no cancellation, no notice, her link still works — and **90 minutes of
a Saturday afternoon becomes invisible.** The waitlist entry two screens away
that fits it is never matched. Same for a reschedule off Saturday, same for a
cross-provider reassign.

**Verified, and the intent is on record.** `opened.ts:84` filters
`SLOT_FREEING_STATUSES`, so a shortened or moved appointment — still `booked` —
cannot appear. Meanwhile `visit-actions.ts:65` calls
`revalidatePath('/staff/opened')` after a service change: revalidating a page
that structurally cannot show it. **A-055's backlog row claims *"Shortening
frees the tail into `/staff/opened` for free, because it derives"*. That claim
is false.**

Stay derived. The event log already records `services_changed`, `rescheduled`
and `provider_changed` with both sides — a better recency bound than the
`updatedAt` heuristic standing in for it. Each row must say what freed it in the
desk's words ("Mrs Hall dropped her colour", "moved to Thursday"), because the
follow-up call is different in each case.

**Cost, in the reviewer's own numbers:** *"A Saturday afternoon colour slot is
worth roughly $150–180 at my prices and is worth zero by Sunday… two to four of
these a week, so on the order of $300–500 a week of supply nobody can see."*

## 3. An appointment's client cannot be attached or corrected after booking — S–M

Two cases, both weekly:

- A walk-in at 11:40 is typed in as nothing but a time (BOOK-04, correctly — you
  do not take a phone number while she is standing there). At the till she
  rebooks for six weeks. **Her visit is orphaned forever**: on no client record,
  counting toward no reliability, no reminder — and if she returns with her
  daughter, A-063's `holderKey` treats them as two strangers.
- The desk picks the wrong Sarah Jones of two (D-17 guarantees there will be
  two), discovered at check-in. The only correction is cancel-and-rebook — and
  **since A-060 that cancel derives `cancelled_late`**, stamping a late
  cancellation on an innocent client's twelve-month count for the desk's own
  typo. Exactly the harm A-055 and A-060 exist to prevent, through the one door
  nobody closed.

**Verified.** The only writer of `Appointment.clientId` after creation is the
client merge at `clients.ts:212`. No attach path, no server action. The schema
promises one — `schema.prisma:653`: *"NULLABLE — BOOK-04 requires booking with
no client record ('walk-in, no name', identity attached later)."*

Must be an ordinary `UPDATE` on the row, so `appointment_write_resource_hold`
re-derives `holderKey` (checkpoint 5's finding), with a test that attaching a
client to a walk-in overlapping her own other appointment collapses them onto
one chair — the mirror of A-063's own test. Allowed from `completed` and
`no_show` too: *"she was a no-show, and it turns out she is Mrs Kerr"* is a real
correction and the whole reason to want the record.

## 4. A no-show's time is dead supply and no screen offers it back — M, **and an owner decision first**

10:00 colour, ninety minutes. At 10:20 the desk marks no-show. That ninety
minutes stays blocked. A walk-in at 10:25 can only be booked into it through a
BOOK-05 override with a typed reason — **putting a false override marker on a
slot that is genuinely empty, and training the desk to dismiss the marker D-8
rests on.**

**This does not re-open D-7 and must not.** `no_show` occupying its time is
right for the record, utilization and reliability. What is missing is a separate
*action*, not a change to the enum — the CLAUDE.md invariant stands.

**Two candidate shapes, and this needs a D-number before anyone starts** (new
**OQ-6**): (a) a released-range marker on the row, the mirror of D-8's
zero-width override plus `overriddenFromRange`, which the constraint, the busy
set and D-16's COALESCE already know how to read; or (b) an explicit
`releasedAt` cut. *"Picking it mid-item is how the last three constraint edits
went wrong."* Never automatic — releasing at N minutes past resells a slot for a
client stuck in traffic eight minutes away.

## 5. The per-visit note is written on one screen and read on no other — S

*"Patch test done 12/4." "6.3 + 20 vol, 35 min." "Bring the reference photo."*
The desk types these into the appointment's note field and the stylist at the
backwash never sees them: the printed sheet and the day chip carry only the
**client's** pinned note. A-062's blank scribble column is the salon writing the
formula on paper and binning it at 6pm. The patch-test line is a safety surface
being kept where nobody looks.

**Verified — the data is loaded and discarded.** `day-view.ts:295` returns
`notes` alongside `clientNotes`; `view-model.ts:307` maps only `clientNotes` and
drops `notes` on the floor. The only reader is `/staff/appointments/[id]`.

The two notes must never be merged: `Appointment.notes` exists precisely
because per-visit notes bury the allergy line. And it must be enterable from the
day grid — *"if it takes three taps to write '6.3 + 20vol' it goes on the
scribble column instead, which is the failure this closes."*

## 6. "Anyone at two" loses the race and offers an override instead of the next free stylist — S

The client had no preference. The row said 14:00, Dana, 3 free. The desk takes a
call, comes back, submits — Dana has just gone to the public flow. The panel
says "That time is not free" and offers **an override that would knowingly
double-book Dana**, while Priya and Tess are both free at two.

**Verified.** `staff-actions.ts:262-281` returns `canOverride: true` for
`SlotTaken` on every path; nothing distinguishes the anyone path and nothing
re-asks `anyProviderTimes`. Checkpoint 5 did not walk this seam.

Do not silently re-assign — A-056's rule is that what you see is what you book.
The fall-through must name a person on a button the desk presses.

## 7. Ringing round a freed slot has no memory of who was already offered it — S–M

Thursday's three-hour colour cancels. Two waitlist matches, a tel: link, good.
The desk rings Mrs Patel, who says "let me check with work". Then a walk-in
arrives and the phone goes; at 4pm the other person at the desk opens the same
list and rings Mrs Patel again — or promises the slot to the second name while
the first is still deciding. **A-061 fixed exactly this for the call-down. The
list with money on it never got it.**

**This is a record, not a hold** — which is what makes it buildable while A-053
is correctly blocked. The slot stays sellable to anybody throughout. It is a
note about a phone call a human made, like `RunningLateTold` and
`CallDownAttempt`, and it must send nothing and appear nowhere near
`deliveryWord()`. Reuse A-061's shape rather than inventing a third.

Reviewer's confidence: **medium-high** — high that the tracking is absent,
medium that it earns its size before a real channel exists, *"because at four
chairs the call-round is often one person's afternoon and she remembers."*

## 8. Nothing lists the clients who have stopped coming — M

Tuesday is at 45% and the owner has no list to ring. Three hundred clients,
eighty on a six-week cycle who have not been in for fourteen. Today the only way
to find them is to read the client list one record at a time.

**Verified.** `packages/db/reports/` holds `dashboard.ts` and `overruled.ts` and
nothing else; `clientHistory` is per client and there is no cross-client recency
query.

*"A call-round of thirty lapsed clients books six to eight, which is $600–900 in
a week that would otherwise have been quiet. That is my number from my salon,
not an industry figure."* Reviewer's confidence: **medium** — high that it is
valuable in a real salon, medium that it belongs in Phase 7 of a learning build,
*"it is a report, not a correctness problem, and the seven above are all about
the book being wrong."*

---

## What the operator said NOT to build

As before, this list is as useful as the one above.

- **Do not make `no_show` free the slot.** Recommendation 4 is a release
  *action*, not an enum change. A no-show that stops occupying its time shows a
  gap where the salon genuinely lost ninety minutes, and corrupts utilization.
- **Do not fix the room strip's overlapping blocks.** After A-063 one client's
  two holds render as two stacked bars in `room-strip.tsx`. It reads as a
  double-booked chair for about two seconds. *"A lane-splitting renderer is the
  first step toward the floor plan the last review told you not to build."* One
  label ("shared — Nadia Okafor") if it ever irritates anyone.
- **Do not rebuild `/staff` as a dashboard.** It is a thirteen-link index tapped
  once a morning; the desk lives in the day grid, which already carries the
  running-late controls, the opened-up link, the call-down and the print sheet.
- **Do not add a Print button** to the day sheet (A-062's reasoning stands), and
  **do not add free-gap rows** to it — the scribble column is where a walk-in
  gets written, and "45 min free" twice a page costs rows a stylist has to scan
  under pressure.
- **Do not auto-derive the running-late delta from `startedAt`.** D-22 refused
  this and was right. Recommendation 1 is about a push settling a delta somebody
  claimed, not about the system guessing.
- **Everything on the Phase 6 do-not-build list stands unchanged** — no second
  reminder touch, no call-down re-ranking, no week or month grid, no chair
  visualisation, no third role, no series rule editor, no multi-provider chains.

**A-053 stays blocked, and the Resend/Twilio accounts remain the owner's most
valuable non-engineering action. Six of the eight items above were deliberately
scoped so they do not need it.**

## The process note, which becomes a rule

The reviewer's closing observation is the most durable thing in this document:

> Checkpoint 5 concluded "a constraint is never one edit either" and named three
> readers of the room. Recommendations 1 and 2 are the same shape one layer up:
> **a *state change* is never one edit.** A-018 changes `startAt` and does not
> tell the delta; A-055 frees time and does not tell the list that sells freed
> time.

Added to CLAUDE.md beside the status-enum and constraint rules, worded to cover
both: *anything that changes when an appointment happens, how long it takes, or
whether it occupies its time, has readers that keep their own copy — and adding
a fourth way to change it means finding them all.*
