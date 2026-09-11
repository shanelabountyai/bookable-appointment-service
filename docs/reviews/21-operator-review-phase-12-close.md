# Operator review — Phase 12 close

**Run 2026-09-11, after A-113 closed Phase 12 and emptied the backlog for the thirteenth time.**

Phase 12 did what the last review and checkpoint 9 scoped it to do, and most of it is done the way a desk defines done. A-106 is the best item in the phase: "when can you fit me in?" has an answer on the phone, it comes from the engine rather than a guess, and Dana's colour book being full until the 22nd is one call instead of ten date-box presses. A-108's missed-reminder list is exact — I skipped one five-minute tick on a 43-appointment cohort and it listed precisely the four clients in that band and nobody else. A-113's seed carries the double-booked hour, and both resets in this pass print `1 double-booked by override` and `686 messages sent`; the 713-row outbox that could not be walked is gone.

**This review found three gaps. Every one was proved by running code against `bookable_test` as `db:reset:test` produces it, and the transcripts are below** (probe scripts deleted, database reset afterwards). Two of them share one shape, and the third is its sibling:

> **A ROW THAT SURVIVES A CHANGE KEEPS ITS ID, AND EVERY READER KEYED ON THE ID ALONE IS STILL ASKING ABOUT BEFORE.** D-6 made a reschedule a same-row update and D-53 made a reinstatement a same-row edge, and both were right: the id, the event log and the manage link survive. But the reinstatement asks "is **this appointment's** chair free?" when the question is "is **a** chair free?", and the missed-reminder list asks "does **this appointment** hold a reminder?" when the sweep asks "does it hold one **for this start time**?". Each pair gives the same answer on the fixture everybody writes — a room where nobody took the freed chair, an appointment that never moved.

**Verdict: the book is right, the room is right, and the desk can finally answer the most common sentence in the salon — but the undo Phase 12 built for the worst mis-tap in the business fails in exactly the room where mis-taps happen, and it fails with a sentence that is false.** The most consequential gap is finding 1: Dana's column is empty at four o'clock, two chairs are free, and "Put it back on the book" says the time was sold, then tells the desk to make the rebooking that brings back every harm D-53 was written to remove.

---

## 1. "Put it back on the book" is refused while the stylist is free, and the way out rebuilds everything D-53 closed — S

It is Friday, busy, one hour to a 16:00. Two Beas in the book; the desk cancels the wrong one. D-42's machine correctly records `cancelled_late`. The phone rings: Priya's next client, 16:00. Then the desk notices.

```
cutoff 120 min · Cut & finish = 60 min body, 5 before / 10 after · chairs 1–4

1. Dana · Bea Lindqvist · Cut & finish · Fri 18 Sep 16:00          -> seated in Chair 2
2. 15:00 — the desk presses Cancel on the wrong Bea (box unticked)  -> cancelled_late
3. next call: Priya · Alice Hall · Blow-dry · Fri 16:00             -> seated in Chair 2
   chairs free across Dana's envelope 15:55–17:10 : [Chair 3, Chair 4]
   Dana's busy set across it                      : 0 rows
4. "Put it back on the book"                      -> SlotTaken ["overlaps-booking"]
   which the panel words (actions.ts:87) as
   "That time has been sold to somebody else since it was cancelled,
    so it cannot go back on the book. Book them in somewhere else."
5. the desk does what it is told — Dana, the SAME instant, new booking -> ACCEPTED, Chair 3

   old row : cancelled_late · outbox [appointment.confirmed, appointment.cancelled] · 1 token · 2 events
   new row : booked         · outbox [appointment.confirmed]                        · 1 token · 1 event
   Bea Lindqvist's late cancels on record: 0 -> 1
```

Reproduced three times on three days and three chairs (Tuesday: Chair 1 freed and taken, Chairs 2–4 empty; Thursday: Chair 3 freed and taken, Chair 4 empty; Friday above).

**Why it is certain rather than unlucky.** `findFreeResource` hands out the lowest-numbered free chair (`resources.ts:130`, `orderBy: { name: 'asc' }`), so the chair a cancellation frees is the one the next overlapping booking — on any stylist — is given whenever no lower chair is free. For Chair 1 that is every time. The reinstatement returns the appointment to the chair it held before, because `resourceId` survived the cancellation. `transition.ts:145-148` says so, and calls it *"the conservative direction, and the desk can move it afterwards."* CLAUDE.md says the opposite — *"A reader stricter than the constraint does not fail safe; it refuses work the salon needs"* — and the desk cannot move it afterwards: a cancelled appointment has no move panel, and the only thing offered is "Book them in somewhere else."

**What the refusal costs, line by line against D-53's own rationale.** D-53 existed because *"the recovery was a NEW appointment, new id, new manage token, an event log split across two rows"* — step 5 is exactly that. Because the client was *"sent a cancellation by default and then a booking"* — `appointment.cancelled` then `appointment.confirmed`. And because of *"a `cancelled_late` sitting on four surfaces of her twelve-month record"* — 0 → 1. And the sentence is untrue: the time was not sold, a chair was. `transition.ts:152` maps every refusal to `overlaps-booking`, so the one screen whose job is explaining itself says "somebody has Dana then" while Dana's column is empty.

**Every other occupancy change already re-picks the chair.** A-034's rule is *the chair follows the move*, and the shared chooser is `chairForMove` (`resources.ts:180`), called from `reschedule.ts:167`, `change-services.ts:487` and `attach-client.ts:279`. The reinstatement is a new way for an appointment to start occupying its time and it is not a move, so nobody grepped for it.

**Money/trust:** a wrong-client cancel happens perhaps monthly on my own desk (my estimate, not an industry figure), and the desk usually notices after the next call — which is precisely when the freed chair has been given away. The dollars are small. The trust is the whole of D-53: a client whose record says "1 late cancel" for a thumb-width, read to her down the phone, is a client the desk has to apologise to — and it counts toward CLIENT-04's self-serve block. And a screen that says "sold" beside an empty column is a screen the desk stops believing.

**Proposed row — A-114 (S).**

> **"Put it back on the book" is refused in the room where mis-taps happen, with a sentence that is false, and the desk's only way out rebuilds every harm D-53 closed.** D-53 lets the exclusion constraint decide whether a cancelled appointment may return — into its OWN chair, because `resourceId` survived the cancellation (`transition.ts:145-148`, which calls this "the conservative direction"). But `findFreeResource` hands out the lowest-numbered free chair (`resources.ts:130`), so the chair a cancellation frees is the one the next overlapping booking on ANY stylist is given. Measured on `db:reset:test`, three days, three chairs: Dana late-cancelled by mis-tap, Priya's next phone booking seated in the freed chair, **Dana's column empty and two chairs free, and the reinstatement refused** as `SlotTaken ['overlaps-booking']`, worded *"That time has been sold to somebody else since it was cancelled… Book them in somewhere else"* (`actions.ts:87`). The desk does as told: the identical instant books straight into Chair 3 — leaving a `cancelled_late` row with its cancellation notice sent, a second confirmation, a second manage token, a split event log, **and the late cancel D-53 existed to take off her record.** Re-pick the chair inside the reinstatement's transaction with the chooser every other occupancy change already uses (`chairForMove`, `resources.ts:180`; called at `reschedule.ts:167`, `change-services.ts:487`, `attach-client.ts:279`), preferring her own. The provider axis stays the database's call exactly as D-53 says, and the constraint still defends the chosen chair against a race — this is a chooser, not a check-then-write. Word the two refusals apart: no chair free is said about the ROOM (A-032's `no-resource-free`), the stylist taken is said about the stylist; `transition.ts:152` collapses both into `overlaps-booking`. **Ride along, by reading and not run:** A-075's un-release puts a no-show's time back through the trigger onto the same chair (`release-time.ts:261`) — the same shape. **The fixture is the item:** at least two chairs, the freed one taken by a DIFFERENT stylist's booking, another chair free, the stylist free. On a one-chair room the refusal is correct, and a test written there passes against the bug.

PRD: APPT-06, RES-02, RES-03, CLIENT-04; D-30, D-53. Depends on: A-112, A-034. **No new D-number** — D-53's guard is untouched, and choosing a chair at write time is D-30/A-034's existing mechanism.

**Confidence: high on the facts** (reproduced three times, the chair picker's ordering and the error mapping both read); **medium on frequency**, which is from my own book.

## 2. The one failure D-51 was written for is the one the badge cannot see — and a client reminded of the wrong time is not on the list — S

D-51 recorded the sweep, derived who was missed, and listed them. The list is right. **The shell badge is not wired to it.**

A salon whose cron missed exactly one tick, simulated: 288 five-minute ticks over the 24 hours into Saturday, one skipped — the one whose band held the Saturday 10:00 starts.

```
cohort: 43 appointments starting Sat 12 Sep 07:00 … Sun 07:00, all booked 10+ days ahead
ran 287 of 288 five-minute ticks — skipped Fri 10:00 (one deploy)     reminders enqueued: 39
the next tick's dispatch drained the outbox

AT Sat 07:00
  shell badge "Messages" (countUnsentNotifications)   0
  /staff/messages stuck rows                          0
  watermark remindersLastRunAt                        Sat 06:55     <- "ran five minutes ago"
  ground truth: cohort holding no reminder row        4
  "Due in the next day and never reminded"            4 -> Sat 10:00 Marcy Dunn · Nadia Rahman · Rae Núñez · Dev Iyer
```

**A missed tick leaves no outbox row** — that is the whole reason D-51 derived the cohort from appointments. And the next tick drains everything else. So the badge (`countUnsentNotifications`, `stuck.ts:173`, rendered from `layout.tsx:58`, counting outbox rows only) reads 0, the stuck list is empty, and the watermark says the job ran five minutes ago. Four ten o'clocks were never reminded, and they are visible only to somebody who opens a screen whose badge says there is nothing on it. The page body is honest — `page.tsx:55` includes the list in its all-clear test — but nobody opens Messages on a Saturday morning with a 0 beside it. The badge's own header (`stuck.ts:161`): *"How many NOBODY HAS BEEN TOLD ABOUT."* These four are exactly that.

**The second half reaches further, because reminders cause reschedules.** "Got your reminder, can I do Wednesday instead?" is the commonest reply a reminder gets.

```
Sam Okafor, Sat 11:00 — reminded; row key reminder-24h:…:1789228800000
Sat 08:00  the desk moves him to Wed 16 Sep 16:00 (same row, D-6)
the sweep band for Wed 16:00 is missed
AT Tue 17:00  never-reminded list: 41 rows — Sam Okafor's appointment on it: false
the sweep itself, run at that band: enqueues — his reminder rows now
  reminder-24h:…:1789228800000  |  reminder-24h:…:1789592400000
```

The other 40 are Wednesday clients whose band nothing swept in this simulation — the list working. He is the one it misses. Predicate 4 (`missed-reminders.ts:76`) is `notifications: { none: { template: REMINDER_TEMPLATE } }` — any reminder row, ever, for this appointment. The sweep's identity is `reminder-24h:{id}:{startAtMs}` (`reminders.ts:112`). **The two halves of D-51 disagree about whether he has been told**, and the sweep is the one that is right: it writes him a second key. He was reminded about Saturday. Nobody reminded him about Wednesday.

**Money/trust:** the reminder is the leak this product exists to plug. A missed cron tick is a platform question I cannot measure from here, but when it happens it is one band of clients — and on a salon that books on the quarter hour that is the whole ten o'clock. At $60–180 a no-show on my rates, one missed band on a Saturday is a few hundred dollars. The trust cost is the familiar one: this is the second consecutive phase where the thing the desk looks at says "fine" in exactly the state the feature was built to catch.

**Proposed row — A-115 (S).**

> **The one failure D-51 was written for is the one the badge cannot see — and a client reminded of the wrong time is not on the list.** D-51 derived the missed cohort and put it on `/staff/messages`, and the list is exact: measured with a 43-appointment cohort and one skipped tick, 4 unreminded, 4 listed, all in the skipped band. But the shell badge is `countUnsentNotifications` (`stuck.ts:173`, `layout.tsx:58`), which counts OUTBOX rows — and a missed tick writes none, and the next tick drains everything else. So at Saturday 07:00 **the badge reads 0, the stuck list is empty and the watermark says the job ran at 06:55**, while four ten o'clocks were never reminded. `stuck.ts:161` defines the badge as *"how many NOBODY HAS BEEN TOLD ABOUT"*. **Part 1:** count the cohort in the badge, from `listMissedReminders` itself — never a second predicate — with a test asserting badge = actionable outbox rows + listed cohort on a book with a skipped tick. **Part 2:** predicate 4 (`missed-reminders.ts:76`) asks whether the APPOINTMENT holds any reminder row, while the sweep's identity is `reminder-24h:{id}:{startAtMs}` (`reminders.ts:112`) — so a client reminded for Saturday and moved to Wednesday on D-6's same row drops off the list when Wednesday's band is missed, **while the sweep, run at that band, enqueues a second reminder**. Measured: Sam Okafor, absent from a 41-row list, second key written. Match on the key built from the row's CURRENT `startAt`, via one exported key builder. **Move predicate 3 with it** (`missed-reminders.ts:89`): "booked early enough" must become "at THIS time early enough" — the latest event that rewrote `startAt` (reschedule, column push), else `createdAt` — or every same-day move sits on the list permanently, which is the false row predicate 3 exists to keep off. **No new D-number:** D-51 decided what the list contains and that the never-tried bucket is counted; it did not decide that the badge ignores the list. **Not in scope:** any catch-up enqueue (D-51's (b) stands), any staleness alarm keyed to a cron interval. **Fixtures:** a skipped tick with every other tick run so the outbox is clean; and remind → reschedule by more than a day → skip the new band.

PRD: NOTIF-01, NOTIF-02; D-6, D-51. Depends on: A-108.

**Confidence: high on both halves** (both simulated end to end, ground truth reconciled by SQL); **medium on priority** — how often a tick is missed in production is the one number I cannot get from a test database.

## 3. The waitlist remembers one service of a two-service visit, offers her time she cannot use, and hides time she can — M, and it needs a decision

A-110 put a waitlist door on the booking refusal, prefilled from the panel. The door carries the whole visit (`booking-panel.tsx:312` appends every chosen service). The form selects the first (`entry-form.tsx:145`) and names the rest in a sentence (`:158`: *"They also asked for Colour — one service per entry, so say so when you ring them."*). Nothing stores that sentence: `WaitlistEntry` has one `serviceId` and no field that could hold the rest.

What the form submits when the desk presses Add without editing, for a Cut + Colour refused on Tuesday with Priya:

```
stored entry : {"serviceId":"Cut","providerIds":[Priya],"fromDay":"2026-09-15","toDay":"2026-09-15","dayParts":["tuesday"]}
WaitlistEntry: id, businessId, clientId, serviceId, providerIds, fromDay, toDay, dayParts, status, createdAt, updatedAt
her visit's footprint (D-23: first bufferBefore, last bufferAfter): 0 + 45 + 120 + 20 = 185 min

matchFreedSlot  a Cut freed · Priya · Tue 10:00 · 55 min                      -> MATCHES Alice Hall
matchFreedSlot  a Colour freed · Priya · Tue 10:00 · 190 min (holds her visit) -> Alice Hall NOT offered
```

`matchFreedSlot` filters `serviceId: freed.serviceId` (`waitlist.ts:215`) and fits one service. So the waitlist puts her name against a 55-minute hole that cannot hold her appointment, and does not put it against a three-hour hole that can. The desk that rings her sees a name and a phone (`waitlist/page.tsx:112-116`), and the standing queue shows `Cut` (`:199`). The sentence that would have warned the ringer was on a form somebody filled in last week.

Cut + colour is, in D-23's own words, *"half the sample business's Saturday book"*. A-110's own PROGRESS entry names the limitation — *"what this item refuses to do is make a promise the matcher cannot keep without saying so on screen"* — and it said so on the wrong screen.

**Money/trust:** a false match is a waitlist call that ends "no, I need my colour too" — three or four minutes of the desk's time (my estimate from my own desk), and it teaches the desk that a match does not mean a fit, which is the one thing a waitlist panel has to mean. A missed match is the three-hour Saturday gap she would have paid $180+ for, never showing her name: the perishable supply the waitlist exists to sell.

**Needs a NEW D-number before it is built.** WAIT-01 (`00-master-prd.md:137`) defines an entry as *"service + acceptable providers + date range + day-parts"* — it predates VISIT-01 and D-23, and no decision since has touched waitlist matching. The question is *what is a waitlist entry for, and what does a freed span match?* **(a)** ordered `serviceIds`; fit the COMPOSED footprint at the freed span's provider (D-23's end-buffers, provider qualified for every line), and offer any freed span she fits, whichever service freed it; **(b)** as (a), but offer only spans freed by an appointment sharing one of her services; **(c)** keep one service, store the rest as text and render it on the match row. **My recommendation is (a):** the span is the perishable thing, not the service — A-109 already made `/staff/opened` ask "can this salon sell this span to anything", and a freed balayage that would hold her cut + colour is still invisible to her under (b). (c) keeps the false match and attaches a warning to it.

**Proposed row — A-116 (M). DECIDE FIRST (a new D-number), THEN BUILD.**

> **The waitlist remembers one service of a two-service visit, offers her time she cannot use, and hides time she can.** A-110's refusal link carries the whole visit (`booking-panel.tsx:312`); the entry form selects the first service (`entry-form.tsx:145`) and names the rest in a sentence (`:158`) that nothing stores — `WaitlistEntry` has one `serviceId` and no other field. `matchFreedSlot` then filters `serviceId: freed.serviceId` (`waitlist.ts:215`) and fits that one service. Measured: a Cut+Colour waitlisting (185-minute footprint under D-23) stored as `Cut` **matches a 55-minute freed cut**, and **is not offered a 190-minute span that holds her whole visit**. The match row renders a name and a phone (`waitlist/page.tsx:112-116`); the warning sentence is on a form from last week. **The new D-number** amends WAIT-01's definition of an entry; the operator recommends (a): ordered `serviceIds`, fit the COMPOSED footprint at the freed span's provider with D-23's end-buffers and every line qualified, and offer any span she fits whatever freed it — which also makes `opened.ts:326`'s `primaryServiceId` stop deciding who is asked, removing A-109's left-behind (a link naming a service that no longer fits the decayed span). Carry every prefilled service into the entry; drop the "one service per entry" sentence rather than rewording it. **Migration:** existing single-service rows become one-element lists, no backfill guess. **Fixture:** a two-service entry, and three freed spans — shorter than the visit but longer than its first service; longer than the visit, freed by a service that is not hers; exactly the visit's footprint. The first and last are where the current matcher and the right one disagree in opposite directions. **Not in scope:** automated offers (OQ-4, A-053 stay blocked), a self-serve waitlist.

PRD: WAIT-01, WAIT-02, VISIT-01; D-23. Depends on: A-110, A-109.

**Confidence: high on the facts** (schema, prefill, form and matcher all read; the match run both ways); **medium on the option** — (a) changes what "who wants this slot?" means for single-service entries too, and that belongs to the owner.

## 4. Tested and CLEAN — recorded because a measured "no" is worth the same as a measured "yes"

- **A-106 is affordable on the phone.** `staffOpenDays`' two arms over the fortnight cap, four runs each on `db:reset:test`: anyone Colour **2685 / 1724 / 2811 / 2279 ms**; anyone Cut+Colour **1215 / 1334 / 1013 / 970**; anyone Balayage **1053 / 1384 / 2106 / 1183**; Dana Colour **492 / 1258 / 1276 / 328**. One to three seconds, on the empty path only (`staff-actions.ts:588`, called from `booking-panel.tsx:213` after a day came back empty) — "let me have a look for you", not a stall. Dana's colour came back with her first open day ten days after the day asked. Nobody needs to cache it or write a cheaper day predicate. The ceiling to watch: the seeded future book is ~19 days deep.
- **D-51's cohort has no false positives.** 43 appointments, 39 reminded, 4 listed, all four in the skipped band; SQL ground truth agrees. Predicate 3 (`createdAt <= startAt − 24h`) did not let one same-day booking through.
- **The dead cron job is fixed in the checked-in config.** `vercel.json` schedules `/api/jobs/reminders` at `*/5 * * * *`, matching `reminderWindow`'s width. The "factor of 288" is now only the route comment's Hobby-plan note, which is deployment-tier as recorded.
- **A-112's other readers follow the status column, by reading.** `/staff/opened` sources cancellations by `SLOT_FREEING_STATUSES` (`opened.ts:282`) and the dashboard counts cancels by status (`dashboard.ts:115-119`, `:171-173`), so a *successful* reinstatement leaves no stale freed row and no stale cancel count. In finding 1's transcript the late-cancel count tracked the row status exactly.
- **A refused reinstatement is a sentence, not a stack trace.** All three runs came back as `SlotTaken` through `transition.ts:152`, never a raw `23P01`. A-078's lesson held — the sentence is wrong (finding 1), but it is a sentence.
- **The booking path's chair chooser agrees with the constraint.** All three "book them in somewhere else" writes at the identical instant were accepted straight into the next free chair; no offered-then-refused on BOOK-04.
- **A-110's prefill carries what the panel held** — client, stylist, `fromDay = toDay =` the refused day, the weekday tag. Only the second service was lost (finding 3).
- **A-108 and A-113's seed fixes are real on a fresh install.** Both resets in this pass printed `686 messages sent` and `1 double-booked by override`.

## 5. What Phase 12 left behind that is load-bearing

- **The stylist's own phone view still cannot run her day.** `ProviderDay` returns *"is not working today"* on `column.closed` before it looks at the appointments (`provider-day.tsx:28`), and it has never had `ColumnControls`. A-107's own entry records both. Dana, booked in on her day off for a bride, opens her phone and is told she is not working. A-107's defect class one component over; take it whenever the phone view is next open.
- **The walk-in answer and the phone answer are still two shapes** — A-103's week with options inline, A-106's fortnight with a list of days. Both are right for their caller; they are not yet one computation, and A-106 says so.
- **A lapsed waitlist entry is invisible, not closeable** (A-110). Harmless until finding 3's migration touches the table; decide then whether lapsed rows get a "ring or remove" section.
- **`route.ts` still runs `sendDueReminders` then `dispatchPendingNotifications` with no isolation between businesses** — a throw in one tenant's sweep skips dispatch for everybody. One tenant today.
- **A-075's un-release has finding 1's own-chair shape** (by reading `release-time.ts:261`, not run). In A-114 as a ride-along.
- **Not re-measured this pass, still recorded from the Phase 11 close:** the closed-day grid's midnight-to-midnight axis, `ON_THE_CHIP` wanting a name in the status module, `/staff/unfinished` oldest-first. A-109's floor and A-111's voice guard were not probed (the guard is a vitest file, which this review does not run).
- **A-053 stays blocked**, and finding 2 is the third consecutive review where the missing real channel makes a harm quieter rather than merely unmeasurable.

## 6. What NOT to build

- **Do not make the reinstatement re-run the engine or check the slot before writing.** D-53 put the provider axis in the database's hands and that is right; A-114 changes which chair is asked about, nothing else.
- **Do not enqueue a catch-up reminder for the missed cohort.** D-51's (b) stands until a real channel lands; a message calling itself a 24-hour reminder that arrives two hours before the appointment is worse than the phone call the list already prompts.
- **Do not add a "job has not run in N minutes" alarm keyed to the cron interval.** Counting the cohort in the badge (A-115) is the alarm, and it names people rather than durations.
- **Do not cache `staffOpenDays` or replace it with a cheaper day predicate.** Measured at 1–3 s on the empty path; SLOT-07 exists because a cheaper answer offers a day the panel then refuses.
- **Do not add a client or provider gender field** to make copy "correct". D-52 took the pronouns out; there is nothing to fill in.
- **Do not build automated waitlist offers, a self-serve waitlist, a week or month grid, a revenue tile, a deposit, a second reminder touch, auto-completion on a timer, or a third role.** Every earlier do-not-build list stands unchanged.
- **Do not re-open D-6, D-7, D-8, D-23, D-30, D-32, D-42, D-45, D-51, D-52, D-53 or D-54.** Finding 3 needs a NEW D-number and says so; findings 1 and 2 need none.

## 7. The process note

Phase 11's rule was *a parameter every caller passes identically is a constant with a misleading signature*, and A-106 applied it — the desk got its answer. The one this phase adds is about rows that are **deliberately kept alive through a change**:

> **A ROW THAT SURVIVES A CHANGE KEEPS ITS ID AND CHANGES ITS MEANING, AND EVERY READER KEYED ON THE ID ALONE IS NOW ASKING ABOUT THE OLD ONE.** D-6 kept the row through a reschedule and D-53 kept it through a cancellation, both so the id, the log and the manage link would survive — the right call, with a price nobody grepped for. `listMissedReminders` asks *"does this appointment hold a reminder?"* while the sweep that writes reminders asks *"does it hold one for this start?"* — the same question until the appointment moves, and reminders are what make appointments move. The reinstatement asks *"is this appointment's chair still free?"* when the operational question is *"is a chair free?"* — the same question until somebody sits in it, and the chair picker's ordering guarantees somebody does. CLAUDE.md's *a state change is never one edit* names the readers that keep their own copy of WHEN. **These are the readers that never kept a copy at all, and used the id as a stand-in for one.** When a write deliberately keeps identity through a change, grep for readers keyed on that identity ALONE — a `none`/`some` relation filter on `appointmentId`, a `resourceId` carried forward, a uniqueness or dedupe check missing the field that just changed.

The fixture rule, a fourth time: **each of these is invisible on the fixture where the key and the thing coincide** — an appointment that was never moved, a room where nobody took the freed chair, a visit with one service. The failing fixture is always the one where the thing moved and the id did not.

And its companion, from finding 3: **a limitation disclosed where the data is entered is not disclosed where the decision is made.** A-110 wrote the multi-service gap down honestly, on the entry form. The person who acts on the entry reads a different screen, days later, with only the name on it. When an item's answer to a known gap is "say so on screen", check the screen it names is the one where somebody picks up the phone.

---

**Files cited, all verified against the working tree at `7ae9e5b`:**

- `packages/db/appointments/transition.ts` (:145-148 the own-chair comment, :152 the `SlotTaken` mapping)
- `apps/web/lib/appointments/actions.ts` (:82-89, the reinstatement sentence at :87)
- `packages/db/booking/resources.ts` (:130 lowest-numbered free chair, :180 `chairForMove`)
- `packages/db/appointments/reschedule.ts` (:167)
- `packages/db/appointments/change-services.ts` (:487)
- `packages/db/appointments/attach-client.ts` (:279)
- `packages/db/appointments/release-time.ts` (:261)
- `packages/db/notifications/stuck.ts` (:161-175)
- `packages/db/notifications/missed-reminders.ts` (:76 predicate 4, :89 predicate 3)
- `packages/db/notifications/reminders.ts` (:112 the dedupe key, :183-184 the watermark)
- `apps/web/app/staff/layout.tsx` (:49-59, badge at :58)
- `apps/web/app/staff/messages/page.tsx` (:55, :136)
- `apps/web/app/api/jobs/reminders/route.ts`
- `vercel.json`
- `apps/web/app/staff/book/booking-panel.tsx` (:213, :307-320, :312)
- `apps/web/app/staff/waitlist/entry-form.tsx` (:64-67, :145, :158)
- `apps/web/app/staff/waitlist/page.tsx` (:112-116, :199)
- `packages/db/waitlist/waitlist.ts` (:210, :215)
- `packages/db/prisma/schema.prisma` (`model WaitlistEntry`)
- `packages/db/appointments/opened.ts` (:282, :326)
- `packages/db/reports/dashboard.ts` (:115-119, :171-173)
- `apps/web/lib/booking/staff-actions.ts` (:588)
- `apps/web/app/staff/day/provider-day.tsx` (:28)
- `docs/prds/00-master-prd.md` (:137 WAIT-01)

---

## Corroborated and contradicted at demo checkpoint 10

The checkpoint walked a production build on a separate, freshly seeded database (`bookable_cp10`) while this review ran. See `docs/reviews/21-demo-checkpoint-10.md`.

**Backlog numbering.** The rows proposed here were renumbered when Phase 13 was scoped with the checkpoint's findings interleaved by consequence: this review's **A-114 is A-116**, **A-115 is A-117**, and **A-116 is A-119** in `06-backlog.md`. The citations above were spot-checked against the tree before scoping, and every one checked out.

- **A-106's "one call instead of ten" holds on two of the three surfaces, not on the third.** This review timed `staffOpenDays` directly. The checkpoint drove the panels and found the function is only **reached** when a day returns no candidates at all (`booking-panel.tsx:284`, `offered.length === 0`) — which a FULL day never does, because A-042's list carries the refused times. On Dana's full Saturday the booking panel shows 32 refused times and no day list; asking about the shut Sunday produces *"The next days with room: Tuesday 22 September"*. The move panel asks of bookable slots only and answers the full day correctly. The function is right and fast (the checkpoint measured ~0.3 s through the panel); the door to it is on the wrong branch. Checkpoint Scene 2; backlog **A-115**.
- **`/staff/messages`' all-clear is honest about the missed cohort (§2) and dishonest about delivery.** On every install that exists, every outbox row is `deliveredBy = log`, every appointment page says "queued", and the same page says *"Everything has gone out."* Checkpoint Scene 3; backlog **A-118**.
- **§2's simulation had to backdate its cohort ("all booked 10+ days ahead") to reach the list, and that is a finding of its own on the demo install:** 31 appointments due in the next 24 hours, 0 created early enough to be missable, so the list is empty by construction on every fresh seed. Backlog **A-120**.
- **A-113's seed fixes, a third database:** `686 messages sent`, `1 double-booked by override`, and the override renders as D-54 promised.
