# Operator review: Phase 16 close

**Run 2026-09-19, at `d47be96`, after A-126 closed Phase 16 and emptied the backlog.**

Phase 16 was the three findings from my Phase 15 review. I re-ran all three against the built code and did not rely on the write-ups. **All three hold** (section 4). The partial sale now leaves its remainder on `/staff/opened`. The waitlist offers the instant the engine would sell, and the write accepts it. A cancellation from a past day tells the desk in words that the time has gone. Booking a client from the match row closes her waitlist entry, and a refused booking leaves the entry open. Dana's own screen lists the bride she agreed to come in for.

**This review found three gaps. I proved each one by running code against `bookable_test` as `db:reset:test` produces it.** The probe scripts lived in the session scratchpad, no repo file was changed, and the database was reset afterwards (`781 appointments … 1 double-booked by override`). Nothing here started a server or Playwright.

**Verdict: the freed-time loop is now the right shape. It asks the book, it asks the engine, and it closes its own entries.** The single most consequential gap is **not** in Phase 16. It sits under it. **"Nobody came — put the rest of the time back" crashes on a colour or a balayage.** Those are the salon's two most valuable services, they are the no-shows that leave the most dead time, and the crash comes from a database CHECK that nothing maps. The other two gaps are the Phase 15 process note ("a snapshot with a live-looking label") turning up again one level in:

- The freed-time list and its matcher still assume the clock stops at the cancelled appointment's START.
- A-126's new "has she got clients?" predicate counts cancelled clients as clients.

---

## 1. Releasing a no-show on a colour or a balayage crashes, so the most valuable dead time of the day cannot be put back (S, no decision)

It is 13:35. Priya's 13:15 colour has not turned up and is not answering. The desk marks her a no-show and presses **"Nobody came — put the rest of the time back"** (A-069/D-44, on the appointment page and, since A-102, on Priya's own phone list). The screen errors. The two hours stay blocked. Nobody sees them on `/staff/opened`, and the desk learns that this button is not safe to press.

```
Priya · 13:15 appointment · marked no_show, then released at the time shown   (releasableAt says true in every case)

Cut      worked blocks 13:15-14:10                        release 13:35 -> OK, 35 min back
Colour   worked blocks 13:05-14:00 14:40-15:35            release 13:35 -> THROWS 23514 appointment_block_well_formed
                                                                           after: releasedAt=null, still blocks 13:05-15:35
Balayage worked blocks 13:05-14:15 14:50-15:15 15:45-16:40 release 13:35 -> THROWS 23514 appointment_block_well_formed
                                                                           after: releasedAt=null, still blocks 13:05-16:40
Colour   worked blocks 13:05-14:00 14:40-15:35            release 14:45 -> OK, 50 min back   <- only once the LAST worked block has begun
```

**Cause: the trigger's two steps run in the wrong order.** `appointment_write_blocks` (live body from `packages/db/prisma/migrations/20260901220000_release_no_show/migration.sql:137-143`) cuts the blocks like this:

```sql
UPDATE "AppointmentBlock" SET "blockedEnd" = NEW."blockedEnd"
 WHERE "appointmentId" = NEW."id" AND "blockedEnd" > NEW."blockedEnd";
DELETE FROM "AppointmentBlock"
 WHERE "appointmentId" = NEW."id" AND "blockedEnd" <= "blockedStart";
```

Its own comment says "everything starting at or after it goes". In practice, a block that starts AFTER the released instant has its end moved to BEFORE its start first. `appointment_block_well_formed` (`CHECK ("blockedEnd" >= "blockedStart")`, `20260819234500_appointment_blocks/migration.sql:80`) refuses that before the DELETE can run. A segmented service (D-29) is the only kind with a second block, so a Cut releases fine and a Colour cannot be released until its rinse has started. By then most of the time has already gone, unsold. `releaseTime` in `apps/web/lib/appointments/actions.ts:145-151` maps `NotReleasable` and `SlotTaken` and rethrows everything else (`:150`), so the desk gets the error boundary. `release-time.test.ts`'s Colour has no segments. CLAUDE.md's A-093 note already says the segmented service is "the salon's most valuable one" and that no fixture had one.

**Money and trust:** on my own book a colour or balayage is the $150–250 appointment, and a same-day no-show on one leaves two to three hours. Those are the hours A-069, A-102, A-109 and A-124 were built to sell (my estimate: a colour no-show a fortnight). The trust cost is bigger than the lost slot. A button that crashes once is a button the desk stops pressing on everything, Cuts included, and the no-show time goes back to being written on the paper book.

**Proposed row: A-127 (S).** See `06-backlog.md`, Phase 17.

**Confidence: high** (provoked end to end on three services, and the transaction rolled back each time). The UI crash is by reading the action, not rendered.

## 2. The freed-time loop still assumes the clock stops at the cancelled appointment's start, so time that is still free drops off the list during the afternoon (S, no decision)

D-60(3) says the remainder is "the freed range clipped at `now` and at whatever has since been sold into it". The derivation does that. Two things around it still answer from the moment the cancellation happened:

```
Priya · Tue 27 Oct · Balayage 13:15 (blocked 13:05-16:40) cancelled; Kay asks for "3pm" -> Cut 15:00 (blocked 15:00-15:55)
Carl is waitlisted for a Cut with Priya, 20-31 Oct
day grid gaps (freeRunsFor)  : 09:00-12:00, 13:00-15:00, 15:55-17:00

now 10:00 | /staff/opened: ["13:05 115 min"] | door: 13:05 115 min | Carl matched: 13:00 | Carl Cut 16:00 write: ACCEPTED
now 14:00 | /staff/opened: []                | door: 14:00 60 min  | Carl matched: 14:00 | Carl Cut 16:00 write: ACCEPTED
now 15:05 | /staff/opened: []                | door: null "This time has gone" | Carl matched: no | Carl Cut 16:00 write: ACCEPTED
```

```
Same event, two ways to record it · Root touch-up 13:15 (blocked 13:10-15:00) · client rings at 13:20 to say she is not coming
cancelled_late (she rang)   -> /staff/opened: []                | appointment-page door: 13:20 100 min | Carl offered 13:30 -> ACCEPTED
no_show + release           -> /staff/opened: ["13:20 100 min"]
```

(`listOpenedSlots` was called with `lookbackDays: 60` in the at-the-day probes, so the recency bound is not what empties the list. The probe's rows carry the real clock's `updatedAt`.)

**Two causes, both about time passing:**

- **The cancellation source still bounds on the START** (`opened.ts:337`, `startAt: { gt: args.now }`). A cancelled row leaves `/staff/opened` at its original start time, even though `freedSpanNow` would report its remainder and the appointment-page door does. The vacated source next to it was corrected long ago to "not entirely past" (`opened.ts:472`). Its own comment explains why: "Mrs Hall dropping her colour at two o'clock leaves an hour that is still worth a phone call at half past." A client who rings at 13:20 to cancel her 13:15 is the most perishable freed time the salon ever has. Recorded as a late cancel it is never on the list. Recorded as a released no-show it is. **Two answers to one question, and the difference is which button the desk pressed.**
- **The run is chosen before the clock is applied** (`free-runs.ts:206` computes overlap against the unclipped `freedStart`, and `:215` clips at `now` only afterwards). When a sale into the middle splits the freed range, the side holding more of it wins even after that side is in the past. The remainder is then empty, so `freedSpanNow` returns `null`. The door says "This time has gone — it is past, or somebody else has it now", `matchFreedSlot` offers nobody, and 15:55–16:40 of the freed range, plus the run to close, is still free and bookable. This is the A-124 lunch-break defect again with `now` as the break.

**Money and trust:** the afternoon after a morning cancellation is exactly when walk-ins and "can you fit me in today" calls come. On my own desk a same-day hole sells more often after its original start than before it (my estimate). A list that empties at 13:15 while the grid still shows three free hours sends the desk back to reading the grid, and then `/staff/opened` is dead code. The door sentence "somebody else has it now" is false on its face, and the desk can see that it is.

**Proposed row: A-128 (S).** See `06-backlog.md`, Phase 17.

**Confidence: high** (all three instants run, both writes provoked, and the recency bound ruled out). **Medium on frequency**, which is from my own desk.

## 3. A stylist's own screen says "these clients are booked outside her hours" over clients the desk has cancelled (S, no decision)

A-126 got the kept-bookings day right. Its predicate is "the closed column holds an appointment item", and the day view has drawn cancelled appointments as items since Phase 14 (greyed, because "she cancelled" is information the desk needs). So the ordinary way to resolve AVAIL-05 (Dana closes Wednesday, the desk rings both clients, both cancel) produces this:

```
Dana · Wed 21 Oct · two Cuts (10:00 Bree Bride, 11:00 Mo Mother), then the date closed (DateOverride isClosed)
closed date, both kept            : items ["10:00–10:45 Bree Bride [booked]", "11:00–11:45 Mo Mother [booked]"]
   ProviderDay -> "Off today — these clients are booked outside Dana's hours." | ColumnControls: true     <- correct (A-126 holds)
desk rang both and cancelled them : items ["10:00–10:45 Bree Bride [cancelled]", "11:00–11:45 Mo Mother [cancelled]"]
   ProviderDay -> "Off today — these clients are booked outside Dana's hours." | ColumnControls: true     <- should be "Dana is not working today."
```

The run went through `loadDayView` → `toGridModel` → `hasDayToRunLate`, and `ProviderDay`'s two predicates were mirrored in the probe. The component was not rendered. The line comes from `provider-day.tsx:37` and `:47`. `item.kind === 'appointment'` has no status in it, and neither does `hasDayToRunLate` (`apps/web/lib/day/run-late.ts:16`, shared with the grid since A-126), so the stylist is also offered "behind by" and a push on a day with nobody in her chair. Each row does say "Cancelled", so the screen contradicts itself: a heading that says booked over rows that say cancelled. **This is CLAUDE.md's "a narrower list is a new fact".** "Has an appointment" and "has a client coming" stopped meaning the same thing when cancelled chips arrived, and this new reader used the first to mean the second.

**Money and trust:** this is the day off where the stylist either comes in for nobody or rings the desk to ask. Either way she stops trusting her own screen. It is cheap to fix, and it is the screen A-126 exists to make trustworthy.

**Proposed row: A-129 (S).** See `06-backlog.md`, Phase 17.

**Confidence: high on the model, medium on the render** (read, not rendered).

## 4. Re-run of the Phase 15 findings, against the built code

- **Partial sale holds (A-124).** Priya's balayage 13:15 (blocked 13:05–16:40) is cancelled. `/staff/opened` reads `13:05 215 min` and the matcher offers Wendy (cut + colour) at `13:00`. A blow-dry is sold to Bo at 13:00. `/staff/opened` now reads `13:35 185 min`, where it used to drop the row. The appointment-page door reads `13:35 185 min`. "Who wants this slot?" offers Wendy **at 13:45**, and that Book link's instant is **ACCEPTED**, where it used to be refused `SlotTaken` at 13:15. An old link carrying the original range is re-derived on read and gives the same answer.
- **Neighbour case holds.** Marcus's 09:00 Cut is cancelled on an empty morning. The list reads `09:00 55 min`, the matcher offers Wendy at 09:00, and the write is **ACCEPTED**. Before, the matcher offered nobody.
- **Past cancellation holds.** `freedSpanNow` on the most recent pre-14-Sep seeded cancellation returns `null`, so the door renders "This time has gone" instead of a Book link.
- **Waitlist close-on-book holds (A-125).** Wes is offered at 13:00. A competing Cut takes 13:00 first, so Wes's Book link is refused **`SlotTaken`** and his entry is **still `active`**. Once that Cut is cancelled, his Book link books 13:00 and the entry is **`fulfilled`**. The next span (Dana, Wed 7 Oct) no longer lists him. Re-waitlisting him for "sooner" **matches**, and the row names "Already booked 2026-10-06 13:00 with Priya", so it is a label and not a filter, as D-61 says.
- **Closed day with kept bookings holds (A-126).** Dana's closed Wed 21 Oct with Bree and Mo booked lists both under the "Off today" line, and the controls render. The cancelled-only variant is finding 3.

## 5. What Phase 16 left behind that is load-bearing, and my call on each

- **A sale into the MIDDLE of a freed range hides the smaller side** (A-124's own note, "needs the operator"). My call: **leave D-60(3) alone.** One row per freed range keeps A-072's call marks whole, and the grid draws both gaps. A-128's clip-at-`now` fix covers the case that actually costs money: once the larger side is past, the other side comes back. Revisit only if the desk is seen reading "115 min" and missing the 65 on the other side.
- **`/staff/opened` names the remainder and not the wider run.** The waitlist panel names both. That is fine. The row is the index and the panel is the offer.
- **The booking panel re-derives its preselection from `at`** (`booking-panel.tsx:257-283`, "the first offered time at or after"). The Book link now carries the engine's own instant for this client, so the two agree. No row needed.
- **A standing series booked from the link does not close the entry** (D-61, not built). The "Already booked" line covers it. No row needed.
- **Still open from Phase 15 §5:** oldest-first match order, the D-54 column widening on heavy cancellation days, and the hand-typed cancelled lists. A-129 is one more reader of that same class. Fold them into whichever item next touches those files.

## 6. What NOT to build

- **Do not fix finding 1 by mapping 23514 to a friendly message.** The release is correct and the trigger is wrong. A tidier error on a button that never works is still a button that never works.
- **Do not fix finding 2 by widening the recency bound or re-adding a minutes predicate.** Bound on "not entirely past" and clip before choosing. `freedSpanNow` is already the one derivation.
- **Do not re-open D-60(3)** for a second row per freed range (section 5), and **do not re-open D-61** to derive fulfilment from the book. Every earlier do-not-build list stands, including no holds, no automated offers (OQ-4, A-053 blocked) and no cron staleness alarm.
- **Do not hide cancelled chips from the stylist's list** to fix finding 3. "She cancelled" is information the chair needs when the client turns up anyway. Fix the heading's predicate, not the list.

## 7. The process note

> **A RANGE THAT IS CUT AT AN INSTANT HAS THREE KINDS OF PIECE — BEFORE, STRADDLING, AND AFTER — AND THE FIXTURE EVERYBODY WRITES HAS ONLY THE FIRST TWO.** The release trigger was written for a visit that is one block, so "after" never existed until a segmented service arrived. `freedSpanNow` chose its run as if `now` were before the range. `cancelledCandidates` assumed `now` is before the start. All three are correct on the one-block, before-the-start fixture, and each fails only when the cut lands past a boundary: a processing gap, a sale into the middle, or the appointment's own start. **When code cuts or clips a range at an instant, write the fixture where the instant falls after a whole piece.**

---

**Files cited, all verified against the working tree at `d47be96`:**

- `packages/db/prisma/migrations/20260901220000_release_no_show/migration.sql` (:137-143 the UPDATE-then-DELETE cut)
- `packages/db/prisma/migrations/20260819234500_appointment_blocks/migration.sql` (:80 `appointment_block_well_formed`)
- `packages/db/prisma/migrations/20260902020000_release_cuts_the_chair/migration.sql` (the hold half to re-check)
- `packages/db/appointments/release-time.ts` (:82-95 `releasableAt`, which is true in every case above)
- `apps/web/lib/appointments/actions.ts` (:145-151 release action rethrows)
- `packages/db/appointments/opened.ts` (:337 cancelled bound on `startAt`, :472 vacated bound on the end)
- `packages/db/day/free-runs.ts` (:206 overlap against the unclipped range, :215 clip at `now`)
- `packages/db/waitlist/waitlist.ts` (:400-408 matcher's `freedSpanNow`, :569 containment)
- `apps/web/app/staff/appointments/[id]/page.tsx` (the `freedSpanNow` door and its "This time has gone" sentence)
- `apps/web/app/staff/day/provider-day.tsx` (:37, :47, :55, :126)
- `apps/web/lib/day/run-late.ts` (:14-20 `hasDayToRunLate`)
- `packages/db/day/day-view.ts` (:361 cancelled rows kept as items, :416-423 `isActive`)
