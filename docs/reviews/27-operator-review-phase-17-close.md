# Operator review: Phase 17 close

**Run 2026-09-21, at `707e01d`, after A-129 closed Phase 17 and emptied the backlog.**

Phase 17 was the three findings from my Phase 16 review. I re-ran all three against the built code and did not rely on the write-ups. **All three hold** (section 3). A colour or a balayage now releases at any instant: in its first block, in a processing gap, in a middle block, or in its last block. The kept blocks, the chair hold and the `/staff/opened` row are right each time, and un-releasing restores every block. A late cancellation stays on the freed-time list after its start. Once the bigger side of a middle sale is past, the smaller side comes back. A closed day whose clients have all been cancelled reads "not working today" with no running-late controls.

**This review found two gaps. I proved each one by running code against `bookable_test` as `db:reset:test` produces it.** The probe scripts lived in the session scratchpad, no repo file other than this one was changed, and the database was reset afterwards. Nothing here started a server or Playwright.

**Verdict: the no-show and freed-time loop is now the right shape for a real salon, and I would run a Saturday on it.** The single most consequential gap is where that loop meets running late. **A cancellation in a column that is running behind does not let the column catch up.** Every client after the gap is still projected forty minutes late and is still on the list to ring. A desk that works that list tells two clients to come in forty minutes late, and the stylist then stands idle through the time the cancellation gave her. The second gap is smaller. After a segmented release, the sentence the desk reads counts processing time the stylist had already sold, and it says the time "is on What's opened up" when the piece that starts now is not.

Both have the same root: **a single number carried across a range as if the range had no holes in it.**

---

## 1. A cancellation in a running-late column does not absorb the delay, so the desk rings clients to come late into time that is now free (M, decision needed)

It is 13:30 on a Thursday. Priya's 13:00 cut ran long, so the desk sets **+40**. The ring-round lists her 14:00, 15:00 and 16:00. The desk rings the 15:00 and the 16:00, says "about forty minutes late", and ticks both. At 13:31 the 14:00 rings to cancel. Priya now has an hour of slack before 15:00. Her 13:00 will be out by about 14:35, and the 15:00 will be seen on time. The screen does not know that:

```
Priya · Thu 29 Oct · four Cuts: 13:00 Ann (checked in), 14:00 Bea, 15:00 Cat, 16:00 Dee · each blocked 55 min (45 + 10 buffer)

13:30  +40 set
   chips      : 13:00 Ann likely 13:40 | 14:00 Bea likely 14:40 | 15:00 Cat likely 15:40 | 16:00 Dee likely 16:40
   ring-round : Bea 14:00 -> 14:40 | Cat 15:00 -> 15:40 | Dee 16:00 -> 16:40
13:30  desk rings Cat and Dee, ticks both
   ring-round : Bea 14:00 -> 14:40 | Cat 15:00 -> 15:40 (rung) | Dee 16:00 -> 16:40 (rung)
13:31  Bea rings and cancels (cancelled_late)
   chips      : 13:00 Ann likely 13:40 | 14:00 Bea [cancelled_late] | 15:00 Cat likely 15:40 | 16:00 Dee likely 16:40
   ring-round : Cat 15:00 -> 15:40 (rung) | Dee 16:00 -> 16:40 (rung)       <- neither is late any more; neither is flagged to ring back
   /staff/opened for Bea's slot: "14:00 55m"
```

The probe went through `setRunningLate` → `markToldAbout` → `transitionAppointment` → `loadDayView` → `toGridModel`. That is the same model the grid, the phone list and the ring-round render from. The components were not rendered.

**Cause: the delta is added to every booked start, flat, whatever lies in between.**

- `lateCallList` projects each row as `startAt + minutes` (`packages/db/day/running-late.ts:290`).
- The chip does the same: `f.shift(appointment.startAt, column.runningLateMinutes)` (`apps/web/lib/day/view-model.ts:451`). So does the accessible label (`:478`).
- Staleness compares the delta with the delta she was told about (`running-late.ts:293`), not with her own projected delay. A client who was told "+40" and is now on time is therefore never flagged `stale`.

APPT-03 (`00-master-prd.md:90`) says the day view "projects revised expected starts down the column". A delay that runs through an hour of free time is not a revised expected start. It describes a column with no holes in it. Holes appear the moment somebody cancels, and a late column is exactly when the desk hopes somebody will.

**What it costs.** Two clients rearrange their afternoon to arrive forty minutes late. Priya is idle from about 14:35 to 15:40. The rest of her day then runs late again, and this time the lateness is real, all the way to close. On my own book, a running-late column plus a same-day cancellation on that column is a weekly Saturday event (my estimate), and each one throws away 40–60 minutes of a chair that has just become free (roughly one cut, $55–65 on my prices). Trust is the bigger cost. The ring-round is the screen that took the Post-it off the desk (A-059). When it tells the desk to ring people for nothing, the desk goes back to working the delay out in its head, and then the sticky note comes back.

**Needs a decision** (what a delta means downstream of free time). D-22 (a stored delta, never a rewrite), D-41 (nothing is sent) and D-43 (what a push does to the delta) all stay as they are. This decides only how the delta is projected.

- **(a) Cascade the projection (recommended).** The delta applies to the appointment in the chair or next up. Every later live appointment is projected at `max(its booked start, the previous live appointment's projected blocked end)`. Cancelled rows and released no-show tails are holes. A client whose projection equals her booked time drops off the ring-round and loses her "likely" line. A client who was rung and whose own projected delay has fallen by 15 minutes or more (A-059's existing threshold) is flagged "rung about +40, now on time: ring back". The stored delta and the engine's `running-late` interval are unchanged. One pure function serves both the chip and the ring-round.
- **(b) A cancellation or release in a late column reduces the stored delta by the freed minutes**, D-43-style. I reject this. A delta is a claim with a person's name on it. It does not handle a gap that was already in the column, and it is wrong when the gap falls after the next client rather than before her.
- **(c) Keep the projection flat and add a line to the column:** "A gap at 14:00 may absorb this. Set back on time?" This is the cheapest option. It leaves the ring-round wrong for anyone the desk does not re-check.

**Proposed row: A-130 (M).** See the draft in section 5.

**Confidence: high** on the model (run end to end, told marks included). **Medium** on frequency, which comes from my own desk.

## 2. After releasing a segmented no-show, the sentence the desk reads counts the processing time and points at a list the piece starting now is not on (S, no decision)

A-127 made this button work on a colour, and that makes it the ordinary case. Priya does a fringe trim in her colour client's processing time, which is what segmented services exist for. Then the colour client does not come. At 13:35 the desk presses **"Nobody came — put the rest of the time back"**:

```
Colour 13:15 · worked blocks 13:05-14:00, 14:40-15:35 · Fringe trim sold into the processing gap at 14:15 (blocked 14:15-14:30)
   panel before : "Put 120 min back"
   after        : "120 min back on the market. It is on What's opened up."
   /staff/opened: ["14:30-15:35 65m"]
   actually free inside the freed range (freeRunsFor = the grid's gaps): 13:35-14:15 (40m), 14:30-15:35 (65m) = 105m

Balayage 13:15 · worked blocks 13:05-14:15, 14:50-15:15, 15:45-16:40 · Blow-dry sold into gap 1 at 14:15 (blocked 14:15-14:50)
   panel before : "Put 185 min back"
   after        : "185 min back on the market. It is on What's opened up."
   /staff/opened: ["14:50-16:40 110m"]
   actually free inside the freed range: 13:35-14:15 (40m), 14:50-16:40 (110m) = 150m
```

The sentence overstates what came back by the length of the booking in the processing time. It also sends the desk to a list that holds the later piece only. D-60(3) correctly shows one row per freed range, taken from the run holding the most of it. The piece it leaves out is **13:35–14:15, the one that starts now**. That is the only piece the walk-in standing at the desk can use. The grid draws it and the sentence does not mention it.

**Cause: the minutes are the envelope, end to end.**

- `releaseNoShowTime` returns `fromBlockedEnd − releasedAt` (`packages/db/appointments/release-time.ts:204`).
- The panel computes the same thing before the press (`apps/web/app/staff/appointments/[id]/page.tsx:500`).
- The action words it as "It is on What's opened up" (`apps/web/lib/appointments/actions.ts:144`).

A Cut has no processing time, so on a Cut the envelope and the freed time are the same number. That is the fixture every test uses. The same sentence also claims "It is on What's opened up" for a remainder below A-109's floor, which the list drops by design.

**Fix, within D-60(3):** derive the sentence from `freeRunsFor` clipped to `[releasedAt, fromBlockedEnd)`, the same derivation the list and the grid use, and name every piece. For example: "40 min now (13:35–14:15) and 65 min from 14:30. The 14:30 is on What's opened up." The panel before the press should say the same thing, or give the range rather than a minute count. **Do not** add a second `/staff/opened` row per piece (D-60(3), section 4).

**What it costs.** This is the most perishable 40 minutes of the day, with a walk-in who could take it, and the desk has just been told to look somewhere it is not. It is a smaller cost than finding 1, but the button is the one A-127 has just made trustworthy on the salon's most valuable services. A number that the next screen contradicts is how a desk learns to stop reading the numbers.

**Proposed row: A-131 (S).** See the draft in section 5.

**Confidence: high** (two services, run end to end, the free runs taken from the grid's own derivation).

## 3. Re-run of the Phase 17 fixes, against the built code

- **A-127 holds.** Priya · no-show at 13:15 · released at the instant shown (the blocks listed are the worked blocks before → after):

  ```
  Colour   first block   13:35  13:05-14:00 14:40-15:35              -> 13:05-13:35                        hold body 13:15-13:35  opened 13:35-15:35 120m
  Colour   gap           14:20  13:05-14:00 14:40-15:35              -> 13:05-14:00                        hold body 13:15-14:20  opened 14:20-15:35  75m
  Balayage first block   13:35  13:05-14:15 14:50-15:15 15:45-16:40  -> 13:05-13:35                        hold body 13:15-13:35  opened 13:35-16:40 185m
  Balayage gap 1         14:30                                       -> 13:05-14:15                                               opened 14:30-16:40 130m
  Balayage middle block  15:00                                       -> 13:05-14:15 14:50-15:00                                   opened 15:00-16:40 100m
  Balayage gap 2         15:30                                       -> 13:05-14:15 14:50-15:15                                   opened 15:30-16:40  70m
  Balayage last block    16:00                                       -> 13:05-14:15 14:50-15:15 15:45-16:00                       opened 16:00-16:40  40m
  ```

  No release threw. Each release left exactly the worked time before the release instant, and both edges of every block are right. The chair hold is cut at the release instant. A waitlisted Cut client was matched at the first grid start in each freed range, and **`bookAppointment` accepted every one**. `unreleaseNoShowTime` restored all blocks in all seven cases.
- **A-128 holds.** A balayage (13:05–16:40) is cancelled, and a Cut is then sold at 15:00:

  ```
  10:00  list 13:05 115m | door 13:05 115m | matched 13:00
  13:30  list 13:30  90m | door 13:30  90m | matched 13:30   <- used to drop at 13:15
  14:00  list 14:00  60m | door 14:00  60m | matched 14:00
  15:05  list 15:55  45m | door 15:55  45m | matched 16:00   <- used to be "This time has gone"
  15:30  list 15:55  45m | door 15:55  45m | matched 16:00
  16:45  list —          | door "This time has gone" | Cut at 16:00 refused in-the-past
  ```

  Every match was written and accepted. The two-ways-to-record-it case now agrees. A root touch-up at 13:15 whose client rings at 13:20 reads `13:20 100 min` whether it was recorded as `cancelled_late` or as a released no-show, and the waitlist offer at 13:30 is **ACCEPTED** either way.
- **A-129 holds.** Dana, closed Wed 21 Oct:
  - Both clients kept: "Off today — these clients are booked outside Dana's hours.", controls shown.
  - One cancelled and one kept: the same heading, controls shown.
  - Both cancelled: **"Dana is not working today."**, **no controls**, and both cancelled rows are still listed.

  This used the shipped `hasLiveAppointment`/`hasDayToRunLate` through `loadDayView` → `toGridModel`. The render is covered by A-129's e2e.

## 4. What Phase 17 left behind that is load-bearing, and my call on each

- **D-60(3), one row per freed range, stands as I left it.** Finding 2 makes the smaller-side case more frequent, because a segmented release with its processing time sold is ordinary. The hidden piece there is the one starting now. The fix I am asking for is the sentence, which stays within D-60(3). The grid draws both pieces.
- **The engine's running-late interval runs from `now`** (D-22). In the finding 1 probe it covers 13:31–14:11 while Ann is projected in the chair until about 14:35, and `/staff/opened` lists Bea's slot as `14:00 55m`. This is a settled decision and I am not asking for it to change. If (a) is chosen, the cascade makes the chip honest about when Priya is really free, and the desk reads the chip before it rings anybody from the list.
- **Still open from Phase 15 §5:** oldest-first match order and the D-54 column widening on heavy cancellation days. Fold them into whichever item next touches those files. A-129 retired one hand-typed cancelled list, and I found no other reader of `kind === 'appointment'` asking "has a client coming" (`lanes.ts` already splits `coming` from `vacated`).

## 5. Draft rows

**A-130 (M), decide first.** **A cancellation in a running-late column does not absorb the delay, so the ring-round tells clients to come late into time that is now free.** The projection is `startAt + delta` for every awaiting appointment, flat (`running-late.ts:290`, `view-model.ts:451`, `:478`), and a told client is `stale` only when the DELTA changes (`:293`). Measured on `db:reset:test`: Priya +40 at 13:30 with Cuts at 13:00 (in the chair), 14:00, 15:00 and 16:00. The 14:00 cancels at 13:31. The 15:00 and 16:00 are **still projected 15:40/16:40 and still on the ring-round**, both already ticked as rung, **neither flagged to ring back**, while the 13:00 is out by about 14:35 and the 15:00 would be seen on time. **Decide (new D-number):** (a) cascade: project each later live appointment at `max(booked start, the previous live appointment's projected blocked end)`, cancelled and released time being holes; an on-time client drops off the ring-round; a rung client whose own projected delay has fallen by 15 minutes or more reads "now on time: ring back"; the stored delta and the engine interval unchanged (D-22, D-43 untouched). (b) reduce the stored delta on cancel/release (rejected: a delta is a named claim). (c) a hint line only. The operator recommends (a). **Fixtures:** a late column with a cancellation between the in-chair client and the rest, a gap that absorbs PART of the delay (the next client still late, by less), and a gap after the next client (the next client still fully late). A back-to-back column passes against the bug, and every existing A-018/A-059 fixture is one. **Not in scope:** the engine's `running-late` interval (D-22), sending anything (D-41).

**A-131 (S).** **After a segmented no-show is released, the sentence counts processing time the stylist had already sold, and says the time "is on What's opened up" when the piece that starts now is not.** `releaseNoShowTime` returns `fromBlockedEnd − releasedAt` (`release-time.ts:204`), the panel computes the same before the press (`appointments/[id]/page.tsx:500`), and the action appends "It is on What's opened up" (`actions.ts:144`). Measured on `db:reset:test`: a Colour (13:05–14:00, 14:40–15:35) with a fringe trim at 14:15, released at 13:35, reads **"120 min back"**. The free time is 13:35–14:15 and 14:30–15:35 (105 min), and `/staff/opened` lists **only 14:30–15:35** (D-60(3)). A balayage with a blow-dry in gap 1 reads **"185 min back"** against 150 min free and a list row of 14:50–16:40. Derive the sentence from `freeRunsFor` clipped to `[releasedAt, fromBlockedEnd)` and name each piece, saying which one is on the list. The panel says the same before the press. **Do not** add a list row per piece (D-60(3)). **Fixtures:** a segmented release with a booking in its processing time, asserting both pieces' edges in the sentence; a release whose remainder is under A-109's floor, asserting no "is on What's opened up". A Cut fixture passes against the bug.

## 6. What NOT to build

- **Do not fix finding 1 by making cancellations or releases write the stored delta.** A delta has a person's name on it (D-22, D-41), and a write-side reduction is wrong whenever the gap falls after the next client. Derive the projection and leave the claim alone.
- **Do not change the engine's `running-late` interval** to follow the cascade. It is settled (D-22), and it stops the website selling the next forty minutes, which is its whole job.
- **Do not fix finding 2 with a second `/staff/opened` row per piece** (D-60(3)), and do not hide the minute count. Give the true pieces.
- Every earlier do-not-build list stands: no holds, no automated offers (OQ-4, A-053 blocked), no cron staleness alarm, and no re-opening of D-60(3) or D-61.

## 7. The process note

> **A NUMBER CARRIED ACROSS A RANGE — "FORTY BEHIND", "120 MINUTES BACK" — IS ONLY TRUE IF THE RANGE HAS NO HOLES IN IT, AND THE FIXTURE EVERYBODY WRITES HAS NONE.** The running-late delta is added to every later start as if the column were back to back. The release minutes are measured end to end as if the visit were one block. Both are exactly right on a solid column of Cuts, and both go wrong the moment the book has a hole in it: a cancellation between the in-chair client and the next, or a client booked into processing time. Phase 16's note was about a range CUT at an instant. This one is about a range SUMMARISED by one number. **When code turns a range into a single figure, write the fixture where the range has a hole in it, and assert the figure against the pieces.**

---

**Files cited, all verified against the working tree at `707e01d`:**

- `packages/db/day/running-late.ts` (:290 flat projection, :293 staleness by delta)
- `apps/web/lib/day/view-model.ts` (:451 chip projection, :478 accessible label)
- `packages/db/day/day-view.ts` (:382-383 `lateCallList` wiring)
- `docs/prds/00-master-prd.md` (:90 APPT-03 "projects revised expected starts down the column")
- `packages/db/appointments/release-time.ts` (:204 release minutes, end to end)
- `apps/web/app/staff/appointments/[id]/page.tsx` (:500 panel minutes before the press)
- `apps/web/lib/appointments/actions.ts` (:144 "It is on What's opened up")
- `packages/db/day/free-runs.ts` (:207-228 A-128's live-range run choice, re-run and holding)
- `packages/db/appointments/opened.ts` (:352 A-128's `blockedEnd > now` bound, re-run and holding)
- `packages/db/prisma/migrations/20260919120000_release_segmented_blocks/migration.sql` (A-127's DELETE-then-UPDATE, re-run and holding)
- `apps/web/lib/day/run-late.ts` (:11-15 `hasLiveAppointment`, re-run and holding)
