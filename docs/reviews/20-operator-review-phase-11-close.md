# Operator review — Phase 11 close

**Run 2026-09-09, after A-105 closed Phase 11 and emptied the backlog for the twelfth time.**

Phase 11 did what the last review scoped it to do, and it did the expensive one first. A-098 is the best item in the phase: `Provider.active` now answers exactly one question and the five surfaces that were using it as a proxy for five different questions ask their own — and it found a sixth reader nobody named. A-100 turned a spanning query round to ask from the day's rows outward. A-099 kept a written promise D-8 had been making since project setup. A-102 found two askers of "is there time to give back?" that disagreed by a whole after-buffer.

**This review found four gaps. Every one was proved by running code against `bookable_test` as `db:reset:test` produces it, and the transcripts are below.** Two of them share one shape, and it is worth naming before the list:

> **THE PRODUCT ANSWERS "WHEN?" AND "WAS SHE TOLD?" FOR THE CLIENT, AND FOR THE DESK IT ANSWERS NEITHER.** `daysWithAvailability` (SLOT-07) and `anyProviderDays` both take an `audience: 'public' | 'staff'` parameter. Between them they have **four callers and every one passes `'public'`** — the public flow twice, the customer's own manage link once, and the "no preference" day list once. No staff screen has ever called either. And `/staff/messages` — the screen whose entire job is "is anybody not going to hear from us?" — cannot see a message that was never attempted, so it prints an all-clear that is character-identical whether the queue drained or the queue never ran.

**Verdict: the book is correct, the room is correct, a departed stylist no longer takes her clients with her — and the desk still cannot answer the most common sentence in the salon.** The most consequential gap is finding 1: **the client on her phone gets a list of the days she can come; the desk on the phone with her gets `<input type="date">` and "Try another day."** On the seeded book, 30% of stylist-service combinations offer nothing on any given open day, and the longest dead run from today is ten days.

---

## 1. "When can you fit me in?" — the desk has to guess, one date box at a time — M

It is Tuesday. Dana has called in sick for the week. The desk opens `/staff/conflicts?day=2026-09-09` (which, since A-100, is now correctly scoped to the day), finds Mrs Kerr's colour, and taps the row's **Move her** link — `conflict-list.tsx:98`, `/staff/appointments/{id}#move`. That link is the right answer to the highest-stress event in the business: Mrs Kerr does not want Priya, she wants Dana, and "Dana's back Thursday, can you do two o'clock?" is what saves the booking.

Here is the whole of what the desk gets (`move-panel.tsx:72-79, :106-109`):

```
Move to which day?   [ 2026-09-09 ▾ ]        ← a bare <input type="date">
What time?           Nothing free that day for this visit. Try another day.
```

There is no way for that panel to know Dana is off until Monday. The desk types Wednesday — nothing. Thursday — nothing. Friday — nothing. Saturday — nothing. Four server round-trips, on the phone, to discover a fact the database has had since the `TimeOff` row was written thirty seconds earlier. The panel's own header comment (`move-panel.tsx:11-18`) argues the decision deliberately:

> *A NATIVE DATE INPUT, not a list of days with openings. The customer's flow offers a curated 28-day list because she is browsing; the desk is not browsing — it is on the phone with somebody who has already said "next Tuesday" or "same time in six weeks".*

That is right about half the calls and wrong about the other half, and the other half is the half where money is on the table. Nobody rings a salon saying "next Tuesday" when their stylist is off sick. They ring saying *when can you fit me in.*

**The same dead end, three times, and the walk-in is the only one that got fixed.** A-103 built exactly this answer — walk forward on the calendar axis, name the soonest following day, cap it — and scoped it to `?walkin=1`. The three refusals it did not reach:

```
booking-panel.tsx:416   "Nobody can take that on {day}. Try another day."       ← provider=any, the phone call
booking-panel.tsx:464   "She is not working that day. Type a time below…"       ← a named stylist
move-panel.tsx:108      "Nothing free that day for this visit. Try another day." ← every reschedule and every rescue
```

**And the answer is already built, parameterised for staff, and unreachable from a staff screen.** `daysWithAvailability` (`packages/db/scheduling/slot-query.ts:306`) is SLOT-07, derived from the same pure function the day view uses so a listed day cannot be an empty one. `anyProviderDays` (`packages/db/booking/any-provider.ts:240`) is its "anyone" sibling. Grepped repo-wide, their callers are:

```
public-actions.ts:150   listDaysWithOpenings   audience: 'public'
public-actions.ts:217   listAnyProviderDays    audience: 'public'
manage/actions.ts:173   listRescheduleDays     audience: 'public'   ← SHE reschedules herself and gets the list
any-provider.ts:256     (inside anyProviderDays)
```

So `/manage/{token}` — the customer moving her own appointment at eleven at night — renders *"Which day suits you?"* over a two-column grid of only the days that have something (`booking-flow.tsx:308-343`). The desk moving the identical appointment gets a date box and a sentence about trying another day. That is the staff path being measurably worse than the self-serve path at the one thing the desk does forty times a day, and it is the definition of the moment the paper book comes back out.

**What it costs, measured.** Every `(stylist, service, day)` pair over the next 30 days, run through `computeDaySlots` at `audience: 'staff'`, `#` = at least one time offered:

```
Dana     Colour                 ........###..#####..#####..###   first open: +8d
Dana     Root touch-up          ........###..#####..#####..###   first open: +8d
Dana     Balayage               ........###..#####..#####..###   first open: +8d
Marcus   Balayage               ..........#..#####..#####..###   first open: +10d
Tess     Cut                    #.##..#...#..#####..#####..###
Priya    Balayage               #.#...#..##..#####..#####..###

empty (provider, service, day) cells over 30 days: 288/840 = 34.3%
over the next 9 days: 115/252 — and 56 of those are the two days the salon is shut,
so on the SEVEN days it is open: 59 of 196 = 30% offer nothing at all
longest run of consecutive dead days from today for one pair: 10
```

Dana's colour book is full for eight days. A client rings for one. The desk presses the date box eight times, each a server round-trip, to reach the first day it could have been told about in one. And the demo book is **sparse past day eight** — beyond that it is nearly all `#` by construction, so on a real book six weeks deep every one of these numbers is worse, not better.

**Money/trust:** on my own desk, "the soonest I can do you is half nine a week Thursday" converts. Silence while the receptionist clicks does not, and "let me ring you back" is a booking lost about half the time. Four calls a day where the desk cannot answer, at a $60 average ticket, is roughly $120 a day walking out — call it $600 a week, and that is my number from my own book, not an industry figure. The adoption cost is the larger one: a desk that has to guess at days keeps a diary open beside the screen, and the day it does that the software is decoration.

**Proposed row — A-106 (M).**

> **The desk cannot answer "when can you fit me in?", and the customer can.** `daysWithAvailability` (`slot-query.ts:306`) and `anyProviderDays` (`any-provider.ts:240`) both take `audience` and **all four call sites pass `'public'`** — the public flow twice, the manage link once. Three staff refusals dead-end instead: `booking-panel.tsx:416` (*"Nobody can take that on Thursday. Try another day."*), `booking-panel.tsx:464`, and `move-panel.tsx:108` — the last of which is where `/staff/conflicts`'s per-row **Move her** link (`conflict-list.tsx:98`) lands, so the rescue for a sick stylist is the surface that cannot say which day she is back. Measured on the seeded book: **30% of (stylist, service) pairs offer nothing on any given open day, and Dana's colour book is dead for eight consecutive days.** Give all three the answer A-103 already built for the walk-in — the soonest following day anybody can take her, with each stylist's earliest time on it — computed **once, in one server action**, never per surface, because a second opinion about "when is she free" is this repo's most-found defect. **Reuse `daysWithAvailability` with `audience: 'staff'`, do not write a cheaper predicate**: the whole reason SLOT-07 exists is that a date picker built from an approximation offers a day the booking page then refuses. Cap it the way A-103 capped its walk-forward (a week for a walk-in; a fortnight is right here, since the phone caller is not standing in the building) and keep the existing date box beside it for "she already said next Tuesday" — the panel's comment is right that both questions are real. **The fixture is the item:** the answer must be a MULTI-DAY absence with the stylist genuinely gone for a week, because on a book where everyone works the same hours "tomorrow" is always the answer and a search that walks one day passes.

PRD: BOOK-01, BOOK-04, SLOT-07; APPT-05 (the move panel). Depends on: A-103 (its walk-forward is the shape), A-100 (the conflicts row that links here).

**Confidence: high.** Both functions read, both grepped for callers, the 30-day availability map run against the seeded book.

## 2. `/staff/messages` prints an all-clear it cannot possibly know — M, and it needs a decision

The screen exists because *"a queue that quietly gives up is the same silence as a queue that never tried, with better manners"* (`stuck.ts:1-22`, its own header). It closes exactly half of that.

`listStuckNotifications` (`stuck.ts:55`):

```ts
where: { businessId, OR: [{ status: 'failed' }, { status: 'pending', attempts: { gt: 0 } }] }
```

`attempts > 0` is the filter, justified two lines up: *"A fresh `pending` row (attempts = 0) is not stuck, it is new."* True — while the dispatcher is running. **A message the dispatcher has never touched is `pending` with `attempts = 0` forever, and it is invisible to the one screen that exists to find it.** The shell badge is no help either: `countFailedNotifications` (`stuck.ts:91`) counts `status: 'failed'` only, so it reads 0.

Proved on the demo install as it ships, before I wrote a single row:

```
select status, (attempts=0) as never_attempted, count(*) from "NotificationOutbox" group by 1,2;
 status  | never_attempted | count
---------+-----------------+-------
 pending | t               |   713

/staff/messages rows shown : 0
shell badge "Messages"     : 0
the screen therefore says  : "Everything has gone out. Nothing is waiting and nothing has been given up on."
```

**Seven hundred and thirteen confirmations nobody has ever been sent, and the screen says everything went out** — character for character the sentence a healthy salon sees. (The 713 is the seed's own doing, and that is an A-095-class dishonesty in its own right: `seedSetup` enqueues a confirmation per appointment and nothing dispatches. But the read model's blindness is real either way, and this is what proves it.) I added forty more rows dated 26 hours old and the screen did not move.

**The second half is worse, because it is silent in production too.** `reminderWindow` (`packages/core/notifications/reminder.ts:21-36`) is `[now + 24h, now + 24h + 5 min)`, a function of `now` alone. `sendDueReminders` (`reminders.ts:51-57`) queries that band and nothing else. **There is no watermark, no catch-up and no record anywhere that the job ran** — I listed every table in the schema; there is no row anywhere that says a sweep happened. So:

- A tick that does not fire — a deploy, a cold start, a 5xx, a rotated `CRON_SECRET`, or the **Hobby-plan daily cron the route's own comment names** (`route.ts:15-18`) — permanently loses every appointment starting in that five-minute band. The next tick's window has moved past them.
- Nothing records which ones. There is no list to ring.
- NOTIF-02's own wording is `[now+24h, now+24h+tick)`. The implementation hardcodes five minutes and the tick is a deployment setting. On a daily cron the two disagree by a factor of 288 and the product sends almost nothing, with a green screen.

Measured on the seeded book: **38 appointments in one day's reminder cohort, and the worst single five-minute band holds 4.** A real salon books on the quarter-hour, so the band containing `:00` holds most of the hour's starts — one missed tick is the whole ten o'clock.

**Money/trust:** the reminder is the leak this product exists to plug, and today the leak has no gauge. A no-show at my rates is $60–180. But the trust cost is the one that finishes a product: the desk reads "Everything has gone out", the client arrives at the wrong time or not at all, and the second time that happens the desk goes back to ringing everybody by hand — which is the shadow calendar with a phone attached.

**This is not an argument against the SMS non-goal.** The console adapter is fine. What is dishonest is scheduling logic that assumes a scheduler which never misses a tick, and a screen that reports delivery it never observed. Both are wrong with a logging adapter.

**Needs a NEW D-number before it is built.** "What does the job do about a band it missed?" has a wrong answer — quietly enqueuing a day-old reminder that lands at 3am, or one for an appointment starting in ninety minutes, is a worse message than none. The options, and my recommendation is (b): **(a)** widen the sweep backwards to a watermark and enqueue anything still ≥ N hours out; **(b)** record the sweep, DERIVE the gap, and put the missed cohort on `/staff/messages` as a named list with phone numbers — the salon rings them, which is what a salon does; **(c)** both. (b) fits D-14's reality exactly and needs no policy about what a late message may claim. It is the same shape as D-46's answer: the reports became right because the desk could be told the truth, not because the software started guessing.

**Proposed row — A-107 (M). DECIDE FIRST (a new D-number), THEN BUILD.**

> **Two ways a client is never told, and neither one is visible.** `listStuckNotifications` (`stuck.ts:55`) filters `attempts > 0`, so a row the dispatcher has never touched cannot appear; `countFailedNotifications` (`stuck.ts:91`) counts `failed` only, so the badge reads 0 beside it. Proved on `db:reset:test`: **713 outbox rows, all `pending`, all never attempted, and the screen says "Everything has gone out. Nothing is waiting and nothing has been given up on."** Separately, `reminderWindow` (`reminder.ts:21`) is a **5-minute band anchored to `now` with no watermark, no catch-up, and no record anywhere in the schema that the job ever ran** — so a missed tick permanently loses everyone starting in it and there is no list to work. NOTIF-02 says the window is one *tick* wide; the tick is a deployment setting and the route's own comment names a plan where it is a day. Three parts: a **never-attempted bucket on `/staff/messages` bounded by age** ("14 messages queued over an hour ago and not tried — the job may not be running"), the badge counting it, and a **sweep watermark** the reminder job writes so the gap is derivable. `enqueueNotification`'s `reminder-24h:{id}:{startAtEpochMs}` dedupe key (P1-7) already makes a re-sweep idempotent, which is what makes the catch-up cheap — that key is the whole reason this is an M and not an L. **Ride along, and it is one line:** `sendDueReminders` (`reminders.ts:53`) is the only core query in the repo with **no `businessId` filter**. **Not in scope:** any real channel, and any message that makes a claim about the future after its own window has passed — that is what the D-number decides.

PRD: NOTIF-01, NOTIF-02; D-14, D-37, D-38. Depends on: A-051 (the screen), A-048 (the idempotency this rests on).

**Confidence: high on the blindness** (proved with a transcript on the shipped demo book); **high on the window** (read, and the schema has no run-record table); **medium on the priority**, because with a logging adapter today's harm is unmeasurable — and that is exactly why it should be built before the channel arrives rather than after.

## 3. The waitlist has no door in and no door out — S

WAIT-01 is the answer to "I can't give you anything for three weeks." Today the desk reaches it by remembering it exists.

**No door in.** Grepped: `apps/web/app/staff/book/`, `apps/web/app/staff/day/` and `apps/web/lib/booking/` contain **zero references to the waitlist**. The whole product has exactly one inbound link to `/staff/waitlist` — the nav item (`staff-nav.tsx:52`) — plus the sell-direction link from `/staff/opened`'s freed-slot row. So at the one moment the feature exists for, the moment the panel says *"Nobody can take that on Thursday. Try another day."*, the screen offers nothing, and the desk must navigate away, **search for the client again** (`entry-form.tsx:29-36`, its own picker), re-pick the service, tick the acceptable stylists, type a date range and tick day-parts. Six fields from cold — every one of which was on the screen it just abandoned, with the client still on the phone. That is longer than writing her name in the back of the diary, which is what will happen.

**No door out.** `WaitlistStatus` has four values and **`expired` is never written anywhere in the repo** — grepped, zero occurrences outside the enum and one comment. `listWaitlist` (`waitlist.ts:81`) filters on `status` alone, so an entry whose `toDay` was in June is still on the standing queue in September looking exactly like somebody to ring. `matchFreedSlot` (`waitlist.ts:181-187`) correctly bounds by `fromDay`/`toDay`, so that entry can never actually match anything — **it is silently dead and visibly live**, which is the worst of the two. §8 of the master PRD states the intent in writing: *"`status ∈ {active, fulfilled, expired, cancelled}` + `createdAt`, so stale entries leave the panel."* They do not leave.

**Money/trust:** a freed Saturday two o'clock is $180 for about five hours and then zero, and the waitlist is the only mechanism in this product for turning it into money. A list nobody adds to is worth nothing, and a list padded with people whose window closed months ago is worth less than nothing, because the desk stops working it. Three seeded entries is the entire demonstrable state of the feature (A-095's own finding, one level up).

**Proposed row — A-108 (S).**

> **The waitlist has one door in — the nav — and none from the refusal.** Zero references to it in the booking panel, the booking actions or the day view; `staff-nav.tsx:52` is the only inbound link. So the moment WAIT-01 exists for — *"Nobody can take that on Thursday"* (`booking-panel.tsx:416`, `:464`) — offers nothing, and adding her means navigating away and **searching for the client a second time** on a form (`entry-form.tsx`) whose every field was on the screen just abandoned. Put **"Put her on the list for this"** on both refusals, prefilled from what the panel already holds: client, services, the stylist (or the set she would accept), the day she asked for as `fromDay`. **No second write path** — `addWaitlistEntry` unchanged, called with a prefill. Second half, and it is the reason the list is not read: **nothing ever writes `expired`** (grepped, zero) and `listWaitlist` (`waitlist.ts:81`) filters on status alone, so an entry whose own `toDay` has passed sits on the standing queue forever while `matchFreedSlot` (`waitlist.ts:181-187`) correctly refuses to match it — dead and looking live. §8 of the master PRD promises the opposite in writing. **Derive it, never a job**: a row past its `toDay` renders as over and drops out of the active list, the same way A-077 aged the lapsed call marks. The fixture needs an entry whose window is in the past AND a freed slot inside its old range, because the two halves only disagree there.

PRD: WAIT-01, WAIT-02; BOOK-04. Depends on: A-023, A-043; the refusal surfaces A-106 also opens — **ride it along with A-106**, which is standing in `booking-panel.tsx` anyway.

**Confidence: high.** Both halves grepped and read; the PRD sentence is the promise.

## 4. A mis-tapped cancellation cannot be corrected, and the flag it writes is permanent — S, needs a new D-number

Two Adas in the book. The desk cancels the wrong one. `transitions.ts:174-178`, verbatim:

```
// cancelled and cancelled_late have no outgoing edges at all. Reinstating a
// cancellation is a NEW booking, because the slot was genuinely released and
// may already have been sold to somebody else.
```

The first half of that reasoning is sound. The second half is not the whole picture, and the product has already decided the other way once. **D-45 met the identical shape on the release axis and answered it properly**: the un-release is *"one guarded same-row `UPDATE`, no check-then-write — the exclusion constraint refuses it the moment anything has been sold, and the desk is told so IN WORDS."* The slot being possibly-gone is an argument for letting the database decide, not for having no way back at all.

Three things follow from the missing edge, in rising order of harm:

- **The client is told, by default.** D-32 makes every staff cancellation enqueue an `appointment.cancelled` notice inside the same transaction, with the box **unticked**. The wrong Ada gets told her appointment is cancelled, and then — after the desk rebooks her — gets told she is booked. Two contradictory messages about an appointment that never moved.
- **The recovery is a different appointment.** A new row, a new id, a new manage token, and the event log split across two appointments neither of which says "this was a mis-tap". APPT-07's promise is that "who moved this appointment and when" always has an answer; here the answer is on a row the desk has to know to look at.
- **The flag is forever.** `reliability.ts:88` counts `cancelled_late` by status in one grouped query, and `flagSentence` (`client-flag.tsx:23-29`) renders *"N late cancels"* on four surfaces the desk reads down the phone. There is no correction edge and D-42's `overruled` escape only exists at the instant the cancel is written. **A late cancel the client did not commit sits on her twelve-month record permanently.** D-7 gave `no_show ↔ completed` a correction for exactly this reason — *"mis-taps are daily and the alternative is SQL surgery"* — and the identical daily mis-tap one button over has none.

**Money/trust:** small in dollars, large in the thing client history is for. CLIENT-02 and CLIENT-04 exist so the desk knows who to ring the day before and who to be careful with; a record that can acquire a permanent black mark by a thumb-width and never lose it is a record the desk learns to discount, and then the whole reliability apparatus is decoration. On my own desk this happens perhaps monthly.

**Needs a NEW D-number, not a re-opening of D-7.** The question is: *may a cancellation be undone, and under what guard?* Options: **(a)** an APPT-06-style correction edge `cancelled | cancelled_late → booked`, staff only, within the same 7-day window, reason required, **refused by the exclusion constraint if the time has been resold and told so in words** — D-45's exact mechanism; **(b)** no reinstatement, but a `cancelled_late → cancelled` downgrade so the innocent flag comes off, leaving the rebooking as it is today; **(c)** leave it. My recommendation is (a): it is the one the database can enforce, it is the shape already decided once on a neighbouring axis, and (b) fixes the flag while leaving the client holding two contradictory messages.

**Proposed row — A-109 (S). DECIDE FIRST (a new D-number), THEN BUILD.**

> **The cancel button has no undo, and the mark it leaves is permanent.** `transitions.ts:174-178` gives `cancelled` and `cancelled_late` no outgoing edges, on the reasoning that the slot may already have been resold — which is the argument D-45 already answered on the release axis by letting the exclusion constraint decide and telling the desk in words. Meanwhile D-32 has already sent the wrong client a cancellation notice by default, and `reliability.ts:88` + `client-flag.tsx:23` put *"N late cancels"* on four surfaces of her record with **no correction path of any kind** — while the identical daily mis-tap on `no_show` has had one since D-7 precisely because *"mis-taps are daily"*. One guarded same-row `UPDATE` back to `booked`, staff only, inside APPT-06's existing 7-day window, reason required, event recorded, **and refused by `appointment_block_no_overlap` the moment anything has been sold into the time — mapped through `errors.ts` to a sentence, never a stack trace** (A-078's rule: provoke BOTH error shapes, statement-time and deferred, because `push-column.ts` is not the only path that can meet the second). The reinstatement must re-point the existing manage token (D-5's `repointManageTokens`), never mint a second, and must tell the client only if the desk says so — the suppression checkbox D-32 already has, defaulting the other way here because she has just been told the opposite.

PRD: APPT-01, APPT-06, CLIENT-04; D-7, D-32, D-42, D-45. Depends on: A-060, A-075.

**Confidence: high on the facts** (transition table, reliability query and flag component all read); **medium on the priority** — how often a desk cancels the wrong row is a matter for the owner and I am reasoning from my own book.

## 5. Tested and CLEAN — recorded because a measured "no" is worth the same as a measured "yes"

Each of these I expected to be a finding. None is. The next reviewer should not spend the pass.

- **"Who moved this appointment and when" has an answer.** `/staff/appointments/[id]` renders the append-only event log in plain language (`page.tsx:102`, `:382-386`) with the reason and the actor. APPT-07 is kept.
- **Closing the whole salon works, and it warns.** `DateOverride.providerId` is nullable and the engine genuinely reads the business-level pattern (`availability.ts:52-58` intersects both), so a bank holiday is one row. `saveDateOverride` returns a stranded count through `strandedByHoursChange`, and that function **fans out to every provider when `providerId` is null** (`impact.ts:237-239`), so shutting for Christmas lists everybody's clients, not nobody's. Every one of the five availability writes returns the count; A-047 closed that properly.
- **The pinned client note reaches the stylist.** `⚑` on the grid chip (`appointment-chip.tsx:125`) *and* on her own list (`provider-day.tsx:115`), visually distinct from the per-visit note. CLIENT-03's safety surface is on the screen the colourist actually reads.
- **D-17's soft "she already has an appointment then" note is real** — `staff-actions.ts:150` computes it, `client-picker.tsx:109` renders it. A promise from the decision log, kept.
- **The conflicts screen can move somebody, not only reassign or cancel.** `conflict-list.tsx:98` links each row to `/staff/appointments/{id}#move`. The sick-stylist case has the right door; it is what is behind the door that is finding 1.
- **The shell badges are not the performance problem the Phase 10 close flagged.** All four queries together, five runs on a 718-appointment book: **8, 8, 5, 6, 4 ms**. `listOpenedSlots` alone is 3 ms and A-102's second list added 1 ms. The ~570 ms was render, not query; the `ponytail:` note in `layout.tsx:39-43` can stay as written and nobody needs to cache anything.
- **`matchFreedSlot` bounds by the entry's own date range** (`waitlist.ts:185-186`), so a stale waitlist entry can never be matched against a slot outside its window. It is the *listing* that is wrong, not the matching — which is what makes finding 3 an S.
- **Client search takes the last few digits of a phone number** (`clients/page.tsx:54`) and the client record splits upcoming from past (`clients/[id]/page.tsx:55-56`). "It's Mrs Kerr, when am I in?" is answered.
- **The day view has prev/next as well as a date box** (`day/page.tsx:99-111`).

## 6. What Phase 11 left behind that is load-bearing

- **The seed enqueues 713 confirmations and dispatches none.** Half of finding 2's proof, and an A-095-class demo dishonesty in its own right: `/staff/messages` is the one screen a checkpoint cannot walk truthfully, because the demo book's outbox is in a state the product never produces. Fix it inside A-107 by dispatching in the seed, not by changing the screen.
- **`sendDueReminders` is the only core query with no `businessId`.** Correct today at one tenant, and it is the rule CLAUDE.md states. One line, inside A-107.
- **The day grid on a closed day renders a full midnight-to-midnight axis.** Recorded at checkpoint 8 and still true. It is the first screen after sign-in on two days in seven for a salon shut Sundays and Mondays, which is more often than "cosmetic" suggests. Worth one line whenever `view-model.ts` is next open.
- **`ON_THE_CHIP` still wants a name in the status module** (`view-model.ts:517`). Named at the Phase 10 close, and A-099 was in that file and did not take it. Ride it along with the next item that opens it.
- **`/staff/unfinished` is oldest-first**, so the six-o'clock errand is at the bottom. Third phase running. Still a product call, not a defect.
- **`/staff/design` returns 53 axe `incomplete` results.** Gallery-only, `incomplete` is not `violation`. Leave it.
- **A-053 stays blocked, and finding 2 is the second consecutive review where the missing channel makes a harm worse rather than merely unmeasurable.** The Resend/Twilio account remains the owner's most valuable non-engineering action.

## 7. What NOT to build

- **Do not build a week or month grid** to solve finding 1. Unchanged from the Phase 10 list. The fix is a list of days that have something, from the same engine call the booking page makes — a second answer to "what has Dana got on" can disagree with the first, and A-090 already spent an item proving how badly a day surface fails when two things model the same axis.
- **Do not auto-expire waitlist entries with a job.** Derive it from `toDay`, the way A-077 derived stale call marks. A job is a second write path that eventually disagrees with the read.
- **Do not send a catch-up reminder for a band the job missed without a decision.** A message claiming "tomorrow at 4:30" that arrives ninety minutes before the appointment is worse than none, and D-38 already established that the reminder is the only template the world can falsify while it sits in a queue.
- **Do not add a revenue tile, a deposit, a second reminder touch, a call-down re-ranking, a client-axis conflict check, auto-completion on a timer, a third role, a multi-provider chain, or a self-serve waitlist.** Everything on the Phase 6–10 do-not-build lists stands unchanged.
- **Do not re-open D-7, D-8, D-14, D-17, D-21, D-25, D-30, D-32, D-42, D-44, D-45, D-46, D-49, D-50 or D-51.** Findings 2 and 4 each need a NEW D-number and say so; neither reverses a settled one.

## 8. The process note

Phase 10's rule — *a period modelled as a state has no fixture that can see it* — was applied and A-098 and A-100 both landed on it. The one this phase adds is about **parameters that have a safe default and a caller who never learns the other value exists**:

> **A PARAMETER WITH A DEFAULT IS A DECISION NOBODY EVER MAKES AGAIN.** `daysWithAvailability` and `anyProviderDays` both take `audience: 'public' | 'staff'`. Four callers, four `'public'`s, and the `'staff'` arm has been dead code since it was written. Nothing failed, no test went red, and the capability that the desk most needs was sitting one string literal away for four phases. This is A-097's rule inverted: A-097 was a fallback arm that *inherited* the default it should have overridden; this is an argument that only one caller has ever supplied at all. **When a function takes an audience, a mode or a role, grep for the values it is actually called with, not for the values it accepts** — a parameter every caller passes identically is not a parameter, it is a constant with a misleading signature, and the surface that needed the other value has usually just been given a worse answer instead.

And its companion, which is what actually found finding 2: **a read model built around a filter that is true "while the system is healthy" reports health when the system is not.** `attempts > 0` is a perfectly reasoned exclusion — a fresh row is new, not stuck — and it is correct on every axis except the one where the thing that would advance `attempts` has stopped. The empty-state rule from checkpoint 8 generalises here: *an empty state must not answer a question that was never asked*, and a filter whose premise is "something else is running" is asking a question the screen cannot verify. **When a list is defined by exclusion, ask what state produces zero rows for the opposite reason** — and check that the sentence you print in that case is not the same sentence you print when everything is fine. It was, character for character, 713 times.

---

**Files cited, all verified against the working tree at `443d753`:**

- `packages/db/scheduling/slot-query.ts` (`daysWithAvailability`, :306)
- `packages/db/booking/any-provider.ts` (`anyProviderDays`, :240)
- `apps/web/app/staff/book/booking-panel.tsx` (:361-370 the date box, :416, :464)
- `apps/web/app/staff/appointments/[id]/move-panel.tsx` (:11-18 the argument, :72-79, :108)
- `apps/web/lib/booking/public-actions.ts` (:150, :217)
- `apps/web/lib/manage/actions.ts` (`listRescheduleDays`, :156)
- `apps/web/app/staff/conflicts/conflict-list.tsx` (:98)
- `packages/db/notifications/stuck.ts` (:55, :91)
- `apps/web/app/staff/messages/page.tsx` (:43-46)
- `packages/core/notifications/reminder.ts` (:21-36)
- `packages/db/notifications/reminders.ts` (:51-57)
- `apps/web/app/api/jobs/reminders/route.ts` (:15-18)
- `apps/web/app/staff/layout.tsx` (:49-56)
- `packages/db/waitlist/waitlist.ts` (:81, :181-187)
- `apps/web/app/staff/waitlist/entry-form.tsx`
- `apps/web/app/staff/staff-nav.tsx` (:52)
- `packages/core/scheduling/transitions.ts` (:174-178)
- `packages/db/clients/reliability.ts` (:88)
- `apps/web/components/client-flag.tsx` (:23-29)
- `packages/db/availability/availability.ts` (:52-58)
- `packages/db/availability/impact.ts` (:237-239)

---

## Corroborated independently at demo checkpoint 9

Finding 2's headline was re-proved on a **separate database** (`bookable_dev`, `db:seed:dev`, 718 appointments) during the checkpoint walk that ran alongside this review:

```
select status, (attempts=0) never_attempted, count(*) from "NotificationOutbox" group by 1,2;
 pending | t | 713

/staff/messages  →  "Everything has gone out. Nothing is waiting and nothing has been given up on."
```

Two books, two schemas, same sentence. See `docs/reviews/20-demo-checkpoint-9.md`.
