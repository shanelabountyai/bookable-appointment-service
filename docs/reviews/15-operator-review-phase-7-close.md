# Operator review — Phase 7 close

**Run 2026-09-01, after A-073 closed Phase 7 and emptied the backlog for the
eighth time.**

Phase 7 did what the last review asked, and it did it well: the delta and the
push finally know about each other, four kinds of freed time reach one list, a
walk-in can be given a name at the till, a no-show's dead hour can be sold, the
formula on the ticket is readable at the backwash, "anyone at two" no longer
offers to double-book Dana, and both call lists remember who has been rung. Six
of the eight rows were scoped so they do not need a real SMS channel, and none
of them needed one.

The shape found is the same one, one door further along:

> **A-069 added a fourth way for an appointment's occupancy to change — a
> *cut* — and told the two range triggers, but not the third thing that models
> occupancy (the chair's body), not the write path that moves a column, and not
> the path back.**

That is *both* CLAUDE.md rules firing at once: a state change is never one edit,
and a constraint is never one edit. A-069's own file says the opposite in prose
— `packages/db/appointments/release-time.ts:23-29`: *"the exclusion constraint,
the busy set, **the chair holds** and the engine all read the ranges the trigger
writes, so every one of them follows without knowing this file exists."* Half of
that is true. The chair hold's **envelope** follows; the chair hold's **body**
does not, and the body is the constraint A-063 added three items ago.

**Two of the four findings were proved by running code, not by reading it.** The
reviewer wrote two throwaway tests against the local database, ran them, and
deleted them; the transcripts are quoted verbatim below. Everything else was
grep-verified twice and is cited by file:line.

**Verdict: the book is runnable and the numbers on top of it are not yet
trustworthy.** The single most consequential gap is that **nothing in the
product closes a day**, and the biggest live lie on a screen is a released
no-show's chair.

---

## 1. Nothing closes the day, and there is no path from `booked` to `completed` — M, **and an owner decision first (OQ-18)**

Six o'clock Saturday. Twenty-nine appointments went through. Check-in got tapped
most of the time, because the client was standing there. "Complete" got tapped
maybe two-thirds of the time, because at the till you are taking money,
rebooking her for six weeks and answering the phone. Eleven appointments are
still sitting on `booked` or `checked_in`, forever, and **nothing anywhere ever
mentions them again.**

What those eleven rows do to the product:

- **Utilization is understated every week.** `reports/dashboard.ts:89` counts
  minutes for `status: { in: ['completed','no_show'] }` only. The owner staffs
  Tuesdays on a number that is missing a third of the work that actually
  happened.
- **A-073's brand-new lapsed list rings the wrong people on its first use.**
  `reports/lapsed.ts:86` takes each client's most recent `completed` visit;
  `lapsed.ts:102-107` only rules her out if she has something in the book
  **ahead of now**. So a regular who was in three weeks ago on an unclosed
  ticket reads as lapsed, and the owner opens her Tuesday call-round with *"we
  haven't seen you in a while"* to somebody who was in three weeks ago. A client
  whose visits have **never** been closed does not appear in `lastVisits` at all
  and is invisible to the report in the other direction. A-073's own row says
  it: *"a wrong definition wastes the owner's afternoon and the list is then
  never opened again."*
- **The leak the product exists to plug leaks.** `clients/reliability.ts:68`
  counts `MISSED_STATUSES` by status. A no-show nobody tapped is not a no-show,
  so CLIENT-04's block never fires and A-024's tile is short.
- **Her history and her spend are wrong** on the one screen used to rebook her
  fast.

**And it cannot be fixed at the desk today, which is the part that makes this
structural rather than a discipline problem.** `packages/core/scheduling/transitions.ts`
has **no `booked → completed` edge** — `booked` goes to `confirmed`,
`checked_in`, `in_progress`, `no_show`, `cancelled`, `cancelled_late`, and that
is all. So closing out Saturday on Monday means tapping `checked_in` **then**
`completed` on every one of the eleven, twenty-two taps, and writing a check-in
timestamp of 09:40 Monday onto a client who sat down at 14:15 Saturday —
corrupting APPT-03's whole point to satisfy a table. There is also no list of
what is open: `grep -rni "overdue|unfinished|still booked"` across `apps/web`
and `packages/db` returns nothing but comments about staleness in other
features.

What it needs:

- One surface, on the desk's path, that lists appointments whose time has passed
  and whose status is not terminal — the day grid's toolbar, with a count on it,
  exactly as "Opened up (N)" is.
- One tap per row for the two answers that actually apply: *she came* / *she
  didn't*.
- A `booked → completed` and `confirmed → completed` staff edge, with
  `startedAt`/`endedAt` left **null** rather than faked. A missing timestamp is
  honest; a Monday-morning timestamp is a lie in the audit trail.
- Every one of them writing an ordinary `AppointmentEvent`, so "who closed this
  and when" has the answer CLAUDE.md demands.
- Bulk-close for a whole day, partial and self-describing per D-26, since this
  is the same "the undo costs six times the create" arithmetic D-39 settled.

**Needs a decision before anybody starts (OQ-18): what does an un-closed past
appointment MEAN to a report?** (a) nothing changes — reports keep counting
`completed` only, and this row is purely a screen that makes the desk close
them; (b) the reports derive it — a past `booked` is treated as attended for
utilization and last-visit, never written; (c) a job auto-completes N hours
after `endAt`. **The reviewer argues hard against (c) and puts it on the
do-not-build list**: a timer that turns a genuine no-show into a completed visit
destroys the one counter the product exists to keep, and it does it silently.
But this is the owner's call, and picking it mid-item is how A-069's
predecessors went wrong.

**Money/trust, the reviewer's own numbers from their salon:** the lapsed round is
the one costed at $600–900 in a quiet week, and it is worth nothing if the first
ten names on it were in last month — after one afternoon like that the owner
never opens the report again. Utilization understated by a fifth is the
difference between keeping Tuesday's junior on and cutting her hours.

**Confidence: high on the hole, medium on the frequency.** That `booked →
completed` does not exist, that no surface lists open past appointments, and
that three readers depend on `completed` are all verified. *How often a real
desk leaves a ticket open is the reviewer's own operating experience — a fifth
to a third of a busy Saturday — and it is not something the code can prove.*

## 2. A released no-show still holds its chair, and the room says the chair is free — S, and it is a live refusal in the desk's face

10:00 colour, ninety minutes, marked no-show at 10:20, time released — A-069
working exactly as designed. The day grid paints a bookable "45 min free" chip
over the tail, because gaps derive from the busy set and the busy set now agrees
the time is free. A walk-in comes in at 10:30. The desk taps the chip and gets:

> **`NoResourceFree: Every Chair is taken for that time.`**

On a chair with nobody in it. This is A-063's stated harm, word for word, and
checkpoint 5's third finding, arriving through the door A-069 opened.

**Verified by running it, not by reading it.** The trigger migration
`20260901220000_release_no_show/migration.sql` rewrites
`appointment_write_blocked_range` and `appointment_write_blocks`. It does not
touch `appointment_write_resource_hold`, which still writes
`bodyStart`/`bodyEnd` from `NEW."startAt"`/`NEW."endAt"`
(`20260831180000_shared_chair/migration.sql`, §4) — and A-063's
`appointment_resource_body_no_overlap` is **unconditional on the holder**.
`booking/resources.ts:105-107` asks the same question the constraint does.
`scheduling/resource-load.ts:145-149` asks a *different* one:
`findRoomFullIntervals` filters on `blockedStart`/`blockedEnd` only, so the
availability sweep sees the cut and the chooser does not. A one-chair fixture,
colour released at 10:20, walk-in **with a completely free second stylist** at
10:30:

```
HOLD envelope 14:50Z → 15:20Z      (cut, correct)
HOLD body     15:00Z → 16:30Z      (uncut — 10:00 to 11:30 local)
ROOM FULL SPANS  09:50 → 10:20     (the engine believes the chair is free)
WALK-IN OUTCOME: NoResourceFree: Every Chair is taken for that time.
```

That is offered-then-refused, the class this repo has now caught three times, on
the exact surface D-44 predicted would sell the released time.

What it needs:

- `appointment_write_resource_hold` truncates `bodyEnd` to `releasedAt` under
  the same status guard the blocked-range trigger uses. She was not in the chair
  after 10:20, so the body is the *more* obviously wrong of the two ranges to
  have left standing.
- A test that seats the walk-in in a **one-chair** room, which is the only
  fixture that can fail: `release-time.test.ts` creates no `ResourceType`, no
  `Resource` and no `requiredResourceTypeId` at all, so the entire item shipped
  with the room untested.
- The mirror assertion the other way: the time she *did* hold (10:00–10:20) must
  still refuse a body, so the fix cannot overshoot.
- While in there, grep for anything else that models the room from
  `bodyStart`/`bodyEnd` — `chairAlreadyHeldBy` (`resources.ts:157`) and
  `push-column.ts:378-397` both read them, and both should be checked against
  the cut rather than assumed.

**Money/trust:** one refused walk-in is $45–65 at these prices, but the cost
that matters is the second-order one. The refusal names a chair the desk cannot
see anything wrong with — A-046's exact complaint — so the desk learns to reach
for the BOOK-05 override on empty time, which is precisely the training A-069
was built to prevent.

**Confidence: high on both the gap and the shape — the reviewer ran it.**

## 3. A push over a released no-show is a 500, and there is no way back from a release — S–M, small decision attached (OQ-19)

Two failures, one column, both because `releasedAt` is a value that the paths
which move an appointment have never heard of.

**(a) The push crashes.** Dana is behind; at 10:35 the desk pushes her column
from 10:00. `push-column.ts:113` selects everything in `ACTIVE_STATUSES`
starting at or after `fromAt` — `no_show` is in that list — so the released
10:00 colour is in the move set. Its `startAt` goes to 10:30 while `releasedAt`
stays 10:20, and the CHECK `appointment_released_within_visit` fires. Verified
by running it:

```
PREVIEW: {"canPush":true}
PUSH OUTCOME: PrismaClientUnknownRequestError …
  code: "23514", "new row for relation \"Appointment\" violates check
  constraint \"appointment_released_within_visit\""
```

`push-column.ts:665-672` maps `isSlotTakenError` and rethrows everything else.
So the preview promises the desk a clean push and the push throws a raw database
error into the running-late workflow — **the identical defect A-034 was written
to close**, on the identical function, sixteen items later. Nothing moved: the
whole transaction rolled back, so on the busiest column of the week the desk is
left doing by hand what the feature exists to do.

**(b) There is no way back.** A-069's left-behind says *"nothing un-releases:
'she has just walked in' after a release is a rebooking, not an undo."* On paper
that is fine. In the salon it is not, because of what happens next. She walks in
at 10:35, the desk books her into her own released tail, and **the `no_show →
completed` correction is now permanently refused by the exclusion constraint** —
she keeps a no-show on her twelve-month count for an appointment she attended,
fifteen minutes late. And when the desk taps the correction to find that out,
`apps/web/lib/appointments/actions.ts:58-67` maps `AppointmentMovedFirst` and
`TransitionRefused` and then `throw error`, and `packages/db/appointments/transition.ts`
maps nothing at all — so a `23P01` reaches the desk as a crash rather than as a
sentence. A-069's tests assert the refusal *is not* a `TransitionRefused`;
nobody asked what the desk sees.

What it needs:

- The push either **excludes terminal statuses from the move set** (a client who
  did not come cannot run late; moving a `completed` row's `startAt` is
  rewriting history too) or carries `releasedAt` with the shift. The reviewer
  would take the exclusion — it is smaller and it is truer.
- `previewPush` asks the question the push asks, per A-018's own rule, so
  whichever way it goes the preview cannot promise a move that fails.
- `changeStatus` maps a slot-taken refusal to words: *"Her time has been sold to
  somebody else — that correction can't go back on the book."* Never a stack
  trace on the one screen whose job is explaining itself.
- **Small decision (OQ-19): what happens when she walks in after a release?**
  (a) irreversible, and the desk is told in words why the correction is refused;
  (b) an un-release while the freed tail is still empty — one guarded `UPDATE
  releasedAt = NULL`, refused by the same constraint the moment anything has
  been sold. Do not pick it inside the item.

**Money/trust:** (a) is a broken screen on Dana's worst hour. (b) is a wrongly
branded client, which is the exact harm A-055, A-060 and A-068 were each built
to prevent — it has now come back through a fourth door.

**Confidence: high on (a) — the reviewer ran it, with the SQLSTATE. High on
(b)'s mechanism, medium on how often she actually walks in after a release,**
because a desk that has already given up on her is not usually five minutes
early to do so.

## 4. The lapsed list's call marks never expire and never say when — S

A-073 reuses A-072's marks, which is right, and the reuse changed the table's
name to `ClientCallMark` (`clients/call-marks.ts`), which is righter. But the
two subjects have completely different lifetimes and only one of them was
designed for. A freed slot dies on Thursday at 2, so a mark against it is at
most a few days old. **The `lapsed` subject is one row per client, forever**,
and the lapsed round is a quarterly errand.

`apps/web/app/staff/dashboard/lapsed/page.tsx:139-144` renders
`OFFER_WORDS[mark.outcome]` and the caller's name and **nothing else** — while
`call-marks.ts:110` has been returning `calledAt` all along. So in October the
owner opens the report and reads "left a message — Priya" beside a name, from a
call Priya made in June, and skips her. That is A-061's original defect (a list
that lies about what has been done) inverted: not a missing memory, a memory
with no expiry.

What it needs:

- The date on the row. It is one field that is already in the payload.
- A mark older than the report's own window reads as stale rather than as
  handled — A-059's `RunningLateTold` already has exactly this rule
  (`day/running-late.ts:226`) and it is the right one to copy rather than
  invent.
- Nothing stored, nothing cleared: staleness is derived from `calledAt` against
  the report's `weeks`.

**Money/trust:** small in dollars, direct in trust — the second round of calls
is the one that books the appointments, and this is the field that stops it
happening.

**Confidence: high on the fact, medium-high on the harm.**

---

## What Phase 7 left behind that is load-bearing

Most of the left-behinds are honest and should stay. Three are not:

- **A-069's "nothing un-releases"** — finding 3(b). It is not a missing
  convenience; it is a client wearing a no-show she did not earn.
- **A-072's `ATTEMPT_WORDS` still exported from a `'use client'` module and read
  by a server component.** A-072's own entry documents the identical shape
  producing a blank 500 on `/staff/opened`, found only because the spec asserted
  what the page *says*. "It demonstrably works" is true and is not a reason — it
  works because Next happens to resolve that import today. Move it beside
  `OFFER_WORDS` in the next session that opens the file.
- **A-073's flagged exclusion asking its own twelve-month question** instead of
  calling `clientReliability` (its own note says so). That is a second copy of
  CLIENT-04's window and threshold living outside the module that owns them —
  the status-enum rule wearing a different hat. One call, or one shared
  constant.

Everything else — A-067's shortened-then-cancelled understatement, A-068's
picker note, A-070's un-writable chip — is correctly sized and correctly
deferred.

## On the interface

**The design brief has this right and this review will not duplicate it.**
`docs/design/01-design-brief.md` names the absent staff shell as "the largest
single UX gap in the product" and the detail panel as the screen needing the
most work. Both are true and both are already scoped. Two operator notes to fold
into that work rather than into a backlog row:

- **The phone rings and there is no route to a client from the day.** The day
  grid's toolbar (`apps/web/app/staff/day/page.tsx:118-168`) has Walk-in,
  Anyone, Conflicts, Call-down, Print sheet and Opened up, and no client search;
  `/staff/clients` is linked from exactly two places. So "it's Mrs Kerr, can I
  move Thursday" is day grid → `/staff` → Clients → search, while she waits.
  That belongs in the shell's requirements beside the two badge counts.
- **Finding 1's "what's still open" count wants to live in the same shell**, not
  on a page somebody has to remember.

## What NOT to build

- **Do not auto-complete appointments on a timer.** It is the obvious answer to
  finding 1 and it is the one answer that destroys the counter the product
  exists to keep: a genuine no-show that nobody tapped becomes a completed
  visit, silently, and the client's reliability record is quietly wrong in her
  favour forever. If OQ-18 lands anywhere near (c), that is the sentence to
  argue with.
- **Do not re-open D-7 or D-44.** Finding 2 is the *body range* following a cut
  the parent row already made; it is not `no_show` freeing its slot, and it does
  not touch status, `startAt`, `endAt`, utilization or the twelve-month count.
- **Do not add a client-axis conflict check** to solve anything above. D-17 is
  right and every one of these has a resource-axis or a status answer.
- **Do not build a "close the day" report for the OWNER.** It is a desk errand
  at six o'clock, not a management screen; put it where the desk already is or
  it will not happen.
- **Everything on the Phase 6 and Phase 7 do-not-build lists stands unchanged** —
  no `no_show` freeing its own slot, no lane-splitting room strip, no `/staff`
  dashboard, no Print button or free-gap rows on the day sheet, no auto-derived
  running-late delta, no week or month grid, no third role, no series rule
  editor, no multi-provider chains, no second reminder touch, no call-down
  re-ranking.
- **A-053 stays blocked.** Unchanged, and the Resend/Twilio accounts remain the
  owner's most valuable non-engineering action — all four findings above were
  scoped so they do not need one.

## The process note

Checkpoint 5 concluded *a constraint is never one edit*. The Phase 6 review
concluded *a state change is never one edit*. A-069 is the first item to break
both rules with one column, and the tell was in plain sight in its own header
comment: **it listed the readers that follow for free, and one item on that list
— "the chair holds" — was half true.** The one worth writing down:

> When a new column changes what a range means, the readers to grep for are not
> the ones that read *that* column. They are the ones that keep their own copy
> of the same fact under a different name. `blockedEnd` and `bodyEnd` are the
> same fact; only one of them was told.

And the cheaper habit underneath it: **A-069's test file created no chairs.** An
item that changes occupancy in a product whose room is enforced by two exclusion
constraints must have a fixture with a room in it, and a one-chair room is the
only size that can fail.
