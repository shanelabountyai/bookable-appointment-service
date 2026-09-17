# Operator review: Phase 15 close

**Run 2026-09-17, at `5700b6d`, after demo checkpoint 13 closed Phase 15 and emptied the backlog.**

Three phases have gone by since the last operator review. Phase 13 was the four findings from the Phase 12 close plus checkpoint 10's, and it did them the way a desk defines done. I re-ran two of them here rather than trusting the write-ups. **A-116 holds:** a mis-tapped cancel, another stylist seated in the freed Chair 1, and "Put it back on the book" goes through into Chair 2. **A-114 holds at the desk as well as on the website:** `(512) 555-0101`, `512.555.0101`, `1-512-555-0101`, `555 0101`, `alice  HALL` and `hall` all find Alice Hall. Phases 14 and 15 were rendering work (the gap label, the cancelled chip, the flag on the chip). Checkpoints 11 to 13 measured those better than I can.

**This review found three gaps. I proved every one by running code against `bookable_test` as `db:reset:test` produces it. Transcripts are below, the probe scripts lived in a scratch directory, and the database was reset afterwards.** Two of the gaps are in the waitlist and freed-time loop, the part of the product that sells perishable supply. D-56 made that loop ask the right question about the CLIENT (her whole visit). It still asks the wrong question about the TIME:

> **"WHAT OPENED UP" IS MEASURED AS THE APPOINTMENT THAT LEFT, NOT AS THE TIME THAT IS FREE.** `freedMinutes` is `blockedEnd − blockedStart` of the cancelled row, and nothing after that asks the book. So the answer is right only while the book around that row stays exactly as it was. That holds on a quiet Tuesday. It is false on a Saturday, because the first thing a good desk does with a freed three hours is sell part of it.

**Verdict: the book, the room and the booking paths are the right shape for a real salon. But the loop that sells cancelled time works only until the desk sells some of it.** The most consequential gap is finding 1. A cancelled balayage frees 215 minutes, the desk sells a blow-dry into the front 35, and two things go wrong. `/staff/opened` drops the whole row, so the 205 minutes still free are on no list. And the appointment page's "Who wants this slot?" still offers a waiting cut-and-colour client at an instant the database refuses.

---

## 1. The freed-time screens measure the appointment that left, so a partial sale hides the rest and the waitlist offers a time that is taken (M, needs a decision)

It is a Saturday morning. Gina rings to cancel a 13:15 balayage with Priya: 180 minutes of work, 10 minutes of buffer before and 25 after. That is the most valuable slot in the afternoon. Wendy is on the waitlist for cut then colour (185 minutes under D-23). Before the desk rings round, a walk-in wants a blow-dry, and the desk puts them in at 13:00, the first free time.

```
Priya · Tue 13 Oct · afternoon window 13:00–17:00 · 15-minute grid
Balayage 13:15, blocked 13:05 - 16:40                 -> cancelled
/staff/opened row (after cancel)                      : ['13:15 215 min']
who wants this slot (after cancel)                    : ['Wendy Waiting Cut+Colour 185']

desk sells a Blow-dry at 13:00 to Bo                  -> ACCEPTED
Priya live that afternoon                             : ['13:00-13:35']
/staff/opened row (after the blow-dry)                : []                    <- 13:35-17:00 is free and on no list
who wants this slot, appointment-page door            : ['Wendy Waiting Cut+Colour 185']   <- unchanged
Book link: Wendy Cut+Colour at 13:15 (the link's at=) -> SlotTaken ["overlaps-booking"]
same visit at 13:45 (inside the remainder)            -> ACCEPTED
```

**Three wrong answers, one cause.**

- **`/staff/opened` drops the whole row the moment anything is sold inside it.** Bound 3 is `busy.length === 0 && absences.length === 0 ? row : null` (`opened.ts:266`). Before a partial sale, "still empty" and "still has sellable time" mean the same thing. After one they do not. The day grid draws the 13:35–17:00 gap correctly, because it derives gaps from the busy set. The screen whose only job is selling freed time does not draw it. Wendy fits there, and the probe booked her there.
- **The appointment page's door into the matcher checks neither "still empty" nor "still future".** `appointments/[id]/page.tsx:291-305` renders "Who wants this slot?" for any appointment in `SLOT_FREEING_STATUSES`, with `freedMinutes(detail)` taken from the cancelled row (`:420`). `matchFreedSlot` (`waitlist.ts:273`) never asks the book: it compares minutes (`:351` → `fitsFreedSpan`, `core/settings/service.ts:111`, `footprint <= freed`). So the panel names Wendy, and the Book link (`waitlist/page.tsx:150`, `at=` the cancelled start) opens a booking the database refuses. That is the offered-then-refused shape CLAUDE.md has recorded five times, now on the screen used to make phone calls. **By reading, not run:** the same door appears on a cancellation from last week. `matchFreedSlot`'s date filters (`:278`, `:280`) use the freed day, not today.
- **Free time next to the cancelled appointment is invisible to the matcher.**

```
Marcus · Tue 13 Oct · morning empty apart from a Cut at 09:00 (blocked 09:00-09:55)
Cut cancelled; Marcus live appointments that day      : 0
/staff/opened                                         : ['09:00 55 min']
who wants this slot                                   : []
Wendy Cut+Colour at 09:00 with Marcus                 -> ACCEPTED
```

A 55-minute cancellation on an empty morning is three hours of sellable time. The waitlist compares Wendy's 185 minutes with 55 and says nobody fits. The write accepts her. The listing may be right to call this "55 minutes opened up", because the rest was already open. The matcher is wrong, because Wendy is on the phone list for exactly this morning. **Also by reading:** a minutes-only fit ignores the grid. The probe's first staff booking at 13:10 was refused `SlotNotOffered` because the 15-minute grid anchors at window open. A span can fit by minutes and still have no start the engine will offer.

**This is CLAUDE.md's checkpoint-6 rule on the waitlist side: *a read model that predicts a chooser's answer must ask the chooser's question.*** D-56 already says the matcher should ask "the question the WRITE will ask". It answers that for the client (every line, the composed footprint) and then substitutes a subtraction for the book. `computeSlotsIn` exists so that no offering surface can go around the engine, and this one does.

**Money and trust:** a cancelled colour or balayage is the $150–250 slot of the afternoon on my own price list. Selling a blow-dry into the front of it is the right first move, and it is exactly the move that takes the rest off the screen. On my own desk that happens most Saturdays (my estimate, not an industry figure). If the rest goes unsold, the salon loses a $180-class appointment to earn a $45 one. The trust cost is the "Book" button that opens a refusal while the client is on the phone. A desk that sees that twice stops ringing from the waitlist panel and goes back to a list on paper.

**Needs a NEW D-number (D-60) before it is built.** D-56 decided what an ENTRY is and that a span matches "anyone it can hold". Nothing decided what the SPAN is once the book around it changes. The options:

- **(a)** The span is the **contiguous free run of that provider that overlaps the freed range**, recomputed from the busy set on every read. `/staff/opened` keeps a partly sold row, keyed the same so A-072's call marks survive, showing the remainder's start and length. The matcher offers a client when **the engine offers at least one start for that client's whole visit, with that provider, whose blocked range overlaps the free run**. The Book link carries that start, not the cancelled one.
- **(b)** As (a), but the span is clipped to the freed range and neighbouring free time is never counted. This is cheaper and closer to "what opened up". It keeps the neighbour miss above.
- **(c)** Leave `/staff/opened` alone and put bound 1 (still future) and bound 3 (still empty) on the appointment-page door. This removes the false offer and keeps both hidden-time misses.

**My recommendation is (a).** The day grid already shows the run, so the waitlist should be selling the same run. Asking the engine rather than subtracting minutes also brings breaks, close, the grid and the room (`canSeat`) along for free, which is the exact list of things a minutes comparison cannot see.

**Proposed row: A-124 (M). DECIDE FIRST (D-60), THEN BUILD.**

> **The freed-time screens measure the appointment that left, not the time that is free. A partial sale hides the rest, and the waitlist offers a time that is taken.** `freedMinutes` is the cancelled row's `blockedEnd − blockedStart` (`opened.ts:330`, `appointments/[id]/page.tsx:420`), and `matchFreedSlot` compares minutes (`waitlist.ts:351`, `fitsFreedSpan`) without asking the book. Measured on `db:reset:test`: a cancelled 215-minute balayage with a blow-dry sold into its first 35 minutes **disappears from `/staff/opened`** (`opened.ts:266`, all-or-nothing "still empty") while 13:35–17:00 is free and a 185-minute cut and colour **books there**. The appointment-page door **still names that client, and its Book link's instant is refused `SlotTaken`**. A 55-minute cancellation on an otherwise empty morning **matches nobody**, while the same client **books** at its start. **D-60** decides what a span is (the operator recommends (a): the contiguous free run overlapping the freed range, and a client matches when the engine offers a start for the whole visit whose blocked range overlaps it). Then: `/staff/opened` keeps a partly sold row with its remainder, keyed as before so A-072's marks survive. The matcher asks the engine through `computeSlotsIn` rather than `fitsFreedSpan`. The Book link carries the engine's start. The appointment-page door applies the same derivation, so an old or fully resold cancellation says so in words rather than offering anyone. **Fixtures:** (1) a freed range with a short booking sold into its FRONT, with a client who fits the remainder and not the original start; (2) a short freed range beside an empty stretch, with a client longer than the range; (3) a freed range whose minutes fit but whose only fitting start is off the grid; (4) a cancellation whose day has passed. **Assert the offer and the write agree:** book every matched client at the link's instant inside a rolled-back transaction, and expect no refusal. **Not in scope:** automated offers (OQ-4, A-053), ranking the match list.

PRD: WAIT-01, WAIT-02, SLOT-07; D-23, D-56, D-58. Depends on: A-119, A-109, A-067.

**Confidence: high on the facts** (all three cases run end to end, and both writes provoked). **Medium on the option:** (a) changes what `/staff/opened` counts as one row, and that is the owner's call.

## 2. Booking someone off the waitlist does not take them off it, so the desk rings a client who is already booked (S, needs a decision)

The waitlist row has two buttons, **Book** and **Fulfilled** (`waitlist/page.tsx:150`, `:155`). Book goes to `/staff/book` and never comes back. Nothing in the booking write path knows the waitlist exists: grep `waitlist` in `packages/db/booking` and `apps/web/lib/booking` and the only hit is a comment in `any-provider.ts:15`. A-072's **"Took it"** mark is a record on that one freed span (`offer-actions.ts:28`) and closes nothing either.

```
Wes Waitlisted · Cut then Colour · any stylist · 6–17 Oct
Tue 6 Oct  Priya 13:15 opens up -> who wants it: [ 'Wes Waitlisted' ]
desk presses Book on Wes        -> booked Tue 6 Oct 13:15 Priya
Wes waitlist entry status now   : active
Wes on the standing queue       : true
Wed 7 Oct  Dana 13:15 opens up  -> who wants it: [ 'Tom Byrne', 'Wes Waitlisted' ]
Wed 14 Oct Marcus 13:15 opens up-> who wants it: [ 'Wes Waitlisted' ]
Wes live appointments           : [ { startDay: '2026-10-06', startWallTime: '13:15' } ]
```

Two taps on two screens in the middle of a call is a step the desk skips. When it is skipped, the next freed span lists the same client with no sign of the booking made yesterday. The booking panel's clash check will not catch it either: `clientAlreadyBookedAround` (`walk-in.ts:276-293`) looks for OVERLAP with the new time, and a booking on a different day does not overlap. **D-56 made this more frequent.** A waiting client now matches every span the visit fits, not only spans freed by the same service, so a stale entry comes up on more calls.

**Do not derive "fulfilled" from the book by itself.** "I'm booked on the 24th, but put me down if anything comes up sooner" is one of the commonest waitlist requests at a real desk. A rule that hides anyone holding a matching appointment in the window would silently delete that client from the list they asked to be on.

**Money and trust:** each wasted call is three or four minutes (my estimate from my own desk). It also tells the client the salon does not know they are booked, and in my experience that is the call after which clients stop trusting the confirmation text. And a stale entry on the standing queue looks exactly like somebody still waiting, which is the dead-looking-live class A-110 closed for `toDay`.

**Needs a NEW D-number (D-61) before it is built.** WAIT-01/02 and D-56 define what an entry matches. Nothing defines what closes one apart from a person pressing a button. The options:

- **(a)** The waitlist's Book link carries the entry id, and the booking write marks that entry `fulfilled` **in the same transaction**, stamped with the appointment it became. Separately, every match row and standing-queue row **names any live future appointment the client already holds** ("already booked Thu 24 Sep 10:00 with Dana") and **never hides them**.
- **(b)** Only the annotation. Closing stays a manual button.
- **(c)** Derive fulfilment: exclude anyone holding a live appointment in the window that carries every service on the entry.

**My recommendation is (a).** It closes the common path where the desk actually made the booking, and it tells the ringer the truth on every other path (the client rang back, booked online, or was booked from the day grid) without deleting the "sooner if you can" client. (c) deletes that client, which is why I am against it.

**Proposed row: A-125 (S). DECIDE FIRST (D-61), THEN BUILD.**

> **Booking someone off the waitlist does not take them off it, so the desk rings a client who is already booked.** The match row's Book link (`waitlist/page.tsx:150`) goes to `/staff/book`, and no booking path reads or writes `WaitlistEntry`. Closing the entry is a separate Fulfilled button (`:155`), and A-072's "Took it" is a mark on one span (`offer-actions.ts:28`). Measured: a waiting cut-and-colour client booked from the panel stays `active`, stays on the standing queue, and is **matched again on the next two freed spans** with no sign of the booking. `clientAlreadyBookedAround` (`walk-in.ts:276`) checks overlap only, so the second booking would not be warned about either. **D-61** decides what closes an entry (the operator recommends (a)). Then: the Book link carries `waitlistEntryId`, the staff booking write sets that entry `fulfilled` inside its own transaction (an entry already closed or lapsed is not an error), and match rows and queue rows name any live future appointment the client holds and never filter on it. **Fixtures:** book from the panel and assert the entry is closed and absent from the next span's matches; a client holding a LATER appointment who asked for sooner still matches, with the appointment named on the row; a booking that fails (SlotTaken) leaves the entry `active`. **Not in scope:** self-serve bookings closing an entry (no entry id reaches that path; the annotation covers it).

PRD: WAIT-01, WAIT-02; D-56. Depends on: A-119, A-072.

**Confidence: high on the facts** (run end to end; the absence of any waitlist write in the booking paths grepped). **Medium on frequency**, which is from my own desk.

## 3. A stylist's own view says "not working today" over clients booked on their day off (S)

Reported as left behind in the Phase 12 review (§5), and still in the tree. A day with no hours still gets bookings. The two ordinary ways are an out-of-hours override (BOOK-05, "Dana will come in for the bride") and AVAIL-05's keep-flagged choice when a date is closed over existing bookings. The Everyone grid draws those clients. The stylist's own tab does not.

```
Dana · Wed 21 Oct · two Cuts booked (10:00 Bree Bride, 11:00 Mo Mother), then the date closed (DateOverride isClosed)
loadDayView: Dana column closed = true | appointments = [ 'Bree Bride booked', 'Mo Mother booked' ]
ProviderDay (provider-day.tsx:28) renders: "Dana is not working today."
```

`ProviderDay` returns on `column.closed` before it looks at the appointments (`provider-day.tsx:28-30`). The printed sheet had the same bug and A-093 fixed it in the right order: items first, then `closed` only to word an EMPTY day (`day-sheet.tsx:137-148`). The phone view is the one sibling nobody moved. The model is right (run). The render is wrong (read, not rendered: this review does not start a server).

**Money and trust:** this is the scenario where the stylist does not turn up. The one person who needs to know about the 10:00 on a day off is told they are not working. On my own book, a day-off favour or a kept-flagged day happens a few times a month (my estimate). A missed one is a lost client and a bad review, not a lost slot.

**Proposed row: A-126 (S).**

> **A stylist's own view says "not working today" over clients booked on their day off.** `ProviderDay` checks `column.closed` before the appointments (`provider-day.tsx:28-30`), so the list is never reached. Measured through `loadDayView`: Dana's column on a closed date holding two kept bookings is `closed = true` with both appointments on it. The printed sheet already words this correctly (`day-sheet.tsx:137-148`, A-093: items first, `closed` only for an empty day). Use the sheet's order. A closed day that HAS appointments renders the list with a line saying the day is outside their hours (same wording source as the grid header's "off today", `day-grid.tsx:161`). **Ride-along, by reading:** the phone view has never had `ColumnControls` (only `day-grid.tsx:197` renders it), so a stylist running late cannot say so from their own screen. Include it only if it is one component. **Fixture:** a closed date with an appointment on it, asserting the client's name is on the provider tab. An empty closed date is the fixture that passes against the bug.

PRD: BOOK-05, AVAIL-05; A-016's list view. Depends on: A-093, A-107.

**Confidence: high on the model, medium on the render** (read, not rendered). **High on consequence.**

## 4. Tested and CLEAN

- **A-116 holds.** Dana's Cut & finish at 16:00 is seated in Chair 1 and cancelled by mis-tap. Priya's client at 16:00 is given Chair 1. "Put it back on the book" → **OK, now in Chair 2.** This is the Phase 12 review's own fixture, and it now passes.
- **A-114 holds at the desk.** `searchClients` finds Alice Hall (`+15125550101`) from `(512) 555-0101`, `512.555.0101`, `1-512-555-0101`, `555 0101`, `alice  HALL` and `hall`, one row each time.
- **A dead reminder job is not silent.** By reading: `listMissedReminders` (`missed-reminders.ts:90-133`) has no watermark in any predicate, so a job that stops completely puts everyone due in the next 24 hours on the list and on A-117's badge. That is the alarm the Phase 12 review argued for instead of a cron-interval alert. Checkpoint 12's note that the page gives no sign when the job has gone stale is covered by the list filling up.
- **A-117's `MOVING_EVENT_TYPES` covers every event that rewrites `startAt` today** (`rescheduled`, `column_pushed`). By reading, `provider_changed`, `services_changed` and `client_changed` do not move the start.
- **Both resets in this pass seeded cleanly** (`753 appointments … 1 double-booked by override`, and 779–780 messages sent, varying with the clock).

## 5. What Phases 13 to 15 left behind that is load-bearing

- **The match list is oldest-first** (`waitlist.ts:293`). Since D-56, a waiting single Cut is listed above a later cut-and-colour client on a 215-minute span. The row prints both footprints, so the desk can choose, and I am not scoping it. If A-124 lands and the desk still sells big spans in small pieces, ranking by fit is the next question.
- **A same-day cancellation widens its stylist's column all day** (A-122 / D-54). At 1024 px, checkpoint 13 already has Marcus clipped and Tess off-screen. On a heavy cancellation day the tablet desk will be scrolling sideways to find a stylist. Measure it on a day with three cancellations before anyone scopes it.
- **Four hand-typed `['cancelled', 'cancelled_late']` lists remain in db code** (`clients.ts:426`, `providers.ts:139`, `services.ts:241`, `walk-in.ts:284`), plus two `CANCELLED` sets (`day-view.ts:431`, `view-model.ts:558`). All are correct today. They are CLAUDE.md's "a status enum is never one edit" waiting to happen. Fold them into whichever item next touches one of those files.
- **Not re-measured this pass:** A-118's "Nothing has actually been sent" section, A-120's seeded reminder band, and the A-121/122/123 geometry. Checkpoints 11 to 13 measured all three.
- **A-053 stays blocked.**

## 6. What NOT to build

- **Do not derive waitlist fulfilment from the book alone** (finding 2's option (c)). It deletes the "sooner if you can" client.
- **Do not fix finding 1 with a cheaper minutes predicate.** "Subtract the busy minutes from `freedMinutes`" is a third copy of the book and still ignores the grid, breaks, close and the room. Ask the engine.
- **Do not add a hold, a reservation or an automated offer to the waitlist.** OQ-4 and A-053 stay blocked, and nothing here needs them.
- **Do not add a cron-interval staleness alarm.** Section 4 shows the missed list is already the alarm.
- **Do not re-open D-55's name-and-phone reuse rule** to catch a client who books online under a different name. D-17's household is the reason it is what it is.
- **Do not re-open D-56, D-57, D-58 or D-59.** Finding 1 adds D-60 about the SPAN and leaves D-56's definition of the ENTRY alone. Finding 2 adds D-61 about closing an entry. Every earlier do-not-build list stands.

## 7. The process note

The Phase 12 rule was about rows that keep their id through a change. This phase's gaps are its mirror image: **a value copied off a row at the moment of an event, and then trusted after the book has moved on.**

> **A DERIVED SPAN THAT STOPS ASKING THE BOOK AT THE MOMENT IT IS DERIVED IS A SNAPSHOT WITH A LIVE-LOOKING LABEL.** `freedMinutes` is correct at the instant of the cancellation and not one booking later. `/staff/opened` checks the book once and treats any change as "gone". The appointment-page door never checks it at all. Neither mistake shows on the fixture everybody writes, where nothing happens between the cancellation and the question. **The failing fixture is always one where the desk did the sensible thing in between**: sold part of the time, or had free time next to it already. When a screen answers "what can I sell?", ask the engine what it would sell, at read time, every time.

And one about screens that split one act into two buttons: **if the second button records that the first act happened, the first act should record it.** "Book" and "Fulfilled" side by side is the same class as "Book" and "Took it". Every "the desk will remember to" in this product has turned into a row nobody closed.

---

**Files cited, all verified against the working tree at `5700b6d`:**

- `packages/db/appointments/opened.ts` (:266 still-empty bound, :330 cancelled `freedMinutes`, :450 vacated `freedMinutes`)
- `packages/db/waitlist/waitlist.ts` (:273 `matchFreedSlot`, :278 and :280 date filters, :293 oldest-first, :351 minutes fit)
- `packages/core/settings/service.ts` (:111-112 `fitsFreedSpan`)
- `apps/web/app/staff/appointments/[id]/page.tsx` (:291-305 "Who wants this slot?", :420 `freedMinutes`)
- `apps/web/app/staff/waitlist/page.tsx` (:73 matcher call, :150 Book link, :155 and :236 Fulfilled)
- `apps/web/lib/waitlist/actions.ts` (:54-66 status action)
- `apps/web/lib/waitlist/offer-actions.ts` (:28 outcomes)
- `packages/db/booking/any-provider.ts` (:15, the only `waitlist` hit under booking)
- `packages/db/booking/walk-in.ts` (:276-293 `clientAlreadyBookedAround`, :284)
- `apps/web/app/staff/day/provider-day.tsx` (:28-30)
- `apps/web/app/staff/day/day-sheet.tsx` (:137-148)
- `apps/web/app/staff/day/day-grid.tsx` (:161, :197)
- `packages/db/day/day-view.ts` (:104-106 `closed`, :431)
- `apps/web/lib/day/view-model.ts` (:558)
- `packages/db/notifications/missed-reminders.ts` (:52 `MOVING_EVENT_TYPES`, :90-133)
- `packages/db/clients/clients.ts` (:88-108 `searchClients`, :426)
- `packages/db/settings/providers.ts` (:139)
- `packages/db/settings/services.ts` (:241)
