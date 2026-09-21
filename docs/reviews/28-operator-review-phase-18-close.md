# Operator review: Phase 18 close

**Run 2026-09-21, at `dcf9347`, after A-131 closed Phase 18 and emptied the backlog.**

Phase 18 was the two findings from my Phase 17 review. I re-ran both against the built code and did not rely on the write-ups. **Both hold at the instant their fixtures freeze** (section 4):

- **A-130 (cancellation).** A cancellation between the client in the chair and the rest of the column absorbs the delay: all of it, or part of it. The two clients the desk had already rung read "Now on time — ring back". Two holes, a raised delta after the ring-round, and a Cut following a colour all project correctly.
- **A-131 (release sentence).** The sentence names every free piece of a segmented release. It says the same thing before the press, at the write, and on the settled line. It names the same piece `/staff/opened` lists. It says "None of it is" when the remainder is under A-109's floor.

**This review found three gaps. I proved each one by running code against `bookable_test` as `db:reset:test` produces it.** The probe scripts lived in the session scratchpad and no repo file other than this one was changed. The database was reset afterwards. Nothing here started a server or Playwright.

**Verdict: the cascade is the right shape, and I would still not run a Saturday on it, because it forgets itself.** The most consequential gap is the length of time a hole keeps absorbing the delay. **The hole stops absorbing at the moment the client in the chair was *booked* to finish.** From that minute on, the whole delta lands on the first client after the hole. That client flips from "on time" back to "+40" and is flagged to ring again, while the stylist is still in the chair and nothing in the book has changed. On the backlog's own column, that minute is 13:56: twenty-five minutes after the desk set the delay and five minutes after it rang everybody back. A no-show hole never absorbs at all. A client can only be marked no-show after her own start time, and by then the chair's booked end has passed. The second gap is D-43 meeting D-62. Pushing *part* of the delay, which is the push form's default, makes every client the push moved read "on time — ring back" while the chair is still running late. The third gap is smaller: a client booked into a colour's processing time is projected at the colour's full delay.

All three share a root. **The cascade's head is chosen by the book, not by who is in the chair.**

---

## 1. The absorption expires at the chair's booked end: at 13:56 the on-time clients flip back to +40 and "ring again", and a no-show hole never absorbs at all (M, decision needed)

This is the backlog's own column, with the clock left running:

```
Priya · Thu 29 Oct · Cuts (45 + 10 buffer): 13:00 Ann (in the chair), 14:00 Bea, 15:00 Cat, 16:00 Dee

13:30  +40 set       ring-round: Bea 14:00->14:35 (35) | Cat 15:00->15:30 (30) | Dee 16:00->16:25 (25)   <- A-130: honest, the 5-min slack per Cut absorbs
13:30  desk rings Cat and Dee, ticks both
13:31  Bea cancels   ring-round: Cat 15:00 on time, STALE "Now on time — ring back" | Dee the same            <- A-130 working
13:32  desk rings both back ("come at your booked time"), ticks at 0
13:40                ring-round: (empty)          chips: 15:00, 16:00, no "likely"
13:56  Ann STILL in the chair (her booked envelope ended 13:55)
                     ring-round: Cat 15:00->15:40 (40) told 0 STALE | Dee 16:00->16:35 (35) told 0 STALE
                     chips     : 15:00 likely 15:40 | 16:00 likely 16:35
14:20                identical
14:36  Ann checked out (completed); Priya is free
                     ring-round: Cat 15:00->15:40 (40) STALE | Dee 16:00->16:35 (35) STALE                  <- the stylist is idle and the screen says 40 behind
```

**The no-show hole never works:**

```
Priya · Thu 5 Nov · the same column, +40 at 13:30, Bea no-show at 14:10
14:10  unreleased    : Cat 15:00->15:40 (40) | Dee 16:00->16:35 (35)
14:10  released (45m): Cat 15:00->15:40 (40) | Dee 16:00->16:35 (35)                                     <- truth: Ann out ~14:35, Cat seen on time
```

D-62(1) names "cancelled and released time" as a hole. A released no-show can never be one in a back-to-back column. `no_show` is recorded after the client's start, and her start is at or after the chair's booked end, so the chair has always left the chain by then.

**Cause: the chain drops an appointment when its *booked* envelope ends.**

- The chain filter is `isPushable(a.status) && a.occupiesEnd > now` (`packages/db/day/running-late.ts:234`). `occupiesEnd` is the booked envelope (`packages/db/day/day-view.ts:361-362`), not the projected end.
- At 13:56 Ann is still `in_progress`, but her booked envelope ended at 13:55, so she leaves the chain. The next member is Cat. The first member of the chain carries the whole delta (`running-late.ts:241-243`), so Cat reads +40. Checking Ann out (`completed` is not pushable) produces the same result.
- **The fixtures that pass against it.** The unit fixtures freeze `NOW = 13:31`, with the chair booked to 14:00 (`packages/db/day/running-late.test.ts:809`). The e2e runs on next Tuesday (`apps/web/e2e/running-late.spec.ts:80-85`, test at `:218`), so the real clock is before every appointment and the filter never removes anyone. No test in the repo evaluates the cascade after the chair's booked end, which is the only time the desk looks at it twice.

**What it costs.** Priya is running late, which is exactly when the desk has no spare attention. The desk rings Cat three times in half an hour: "forty late", then "on time", then "forty late" again. Or it stops trusting the list, and that is worse. If the desk believes the 13:56 screen, Cat arrives at 15:40 and Priya stands idle from about 14:35. That is the loss A-130 existed to prevent, and it now arrives twenty-five minutes later instead of at once. On my own book, a late column with a cancellation or a no-show in it is a weekly Saturday event (my estimate). The idle chair is 40–60 minutes, roughly one cut, $55–65 on my prices. The trust cost is larger than the money: this is the list that took the Post-it off the desk (A-059).

**Needs a decision (D-63(1): what the cascade's head is, and when it stops being the head).** D-62's cascade, its "a claim made with an empty chair lands whole on the next client", and its "a forgotten un-started 11:00 never seeds the chain" all stand. This decides only who the head is.

- **(a) The head is the client in the chair (recommended).** That is an `in_progress` appointment, or a `checked_in` one whose booked start has passed. D-22's own header says check-in discipline collapses when the desk is three deep, so "start" is not always pressed. She stays the head whatever her booked end, and she is projected to end at her booked envelope end plus the delta. Once she is checked out, the stylist is free from that moment, taken from the `completed` event's timestamp: the chain starts there and nobody after her inherits the delta. With nobody in the chair, the chain is D-62's as built.
- **(b) Keep chain members until their *projected* end instead of their booked end.** This is the cheapest option and it fixes 13:56. It still flips at checkout (14:36 → Cat +40), because a checked-out head leaves the chain either way. I reject it.
- **(c) Clear the delta automatically when the chair is checked out.** I reject this for the same reason D-62 rejected (b): a delta is a claim with a person's name on it (D-22).

**Row: A-132 (M).**

**Confidence: high.** It was run end to end at five instants, with told marks, on both hole types.

## 2. Pushing part of the delay makes every pushed client read "on time — ring back" while the chair is still late (S, decided alongside D-63)

This column is back to back with no cancellation. The desk pushes part of the delay, and the push form's default is always a partial push:

```
Priya · Thu 19 Nov · Cuts: 13:00 Ann (in the chair), 14:00 Bea, 15:00 Cat · +40 at 13:30

13:30  ring-round: Bea 14:00->14:35 (35) | Cat 15:00->15:30 (30); desk rings both, ticks at their delays
       preview "Push by 20" from 14:00: 14:00->14:20, 15:00->15:20, delta 40 -> 20
       preview "Push by 15" (the field's default): delta 40 -> 25
13:31  after pushing +20:
       ring-round: Bea 14:20 on time, told 35, STALE "Now on time — ring back" | Cat 15:20 on time, told 30, STALE
       chips     : 14:20, 15:20, no "likely" on either
       truth     : Ann is still out at ~14:35 (the push did not move her), so Bea is 15 late on her new time and Cat 10
```

The desk has just pushed because Priya is behind, and the screen tells it to ring both clients and say "come at your booked time". The pure function confirms the arithmetic. With the head carrying the original 40, Bea reads 15 and Cat reads 10, which is right. With the head carrying the reduced 20, both read 0.

**Cause: each pushed minute is counted twice.**

- D-43 reduces the stored delta by the pushed minutes (`deltaAfterPush`, `packages/db/day/running-late.ts:123-126`, applied at `push-column.ts:460`). That arithmetic was exact for the flat projection it was written against: pushed start + reduced delta = old start + old delta.
- The push starts at the first client who has not sat down (`apps/web/lib/day/view-model.ts:529-532`), so **the chair is never moved**. Under D-62 the chair is the head and carries the delta. After a push she carries the *reduced* delta. Meanwhile the push has opened a gap between her booked end and the next client's new start, and the reduced delta drains into it.
- The push field defaults to 15 whatever the delta is (`apps/web/app/staff/day/column-controls.tsx:57`), so a partial push is what the desk gets unless it retypes the number.
- A full push (+40 of 40) is unaffected, because the delta goes to zero and nothing is projected. The A-018/A-059 push fixtures are either full pushes or pre-date the cascade, and they pass against this.

This is CLAUDE.md's "a state change is never one edit" rule, one phase on. D-62 changed what the delta means to its readers, and D-43's writer still assumes the old meaning.

**Needs a decision (D-63(2)), taken with D-63(1).** D-43's stored arithmetic and the engine interval (D-22) stay as they are.

- **(a) The delta row records how many minutes pushes have taken off it (recommended).** It is written inside the push's own transaction, next to D-43's reduction, and reset when the delta is cleared. The head in the chair, whom the push never moves, is projected at delta + pushed-off minutes. Everyone the push moved projects from their new start with the reduced delta, exactly as D-43 intends.
- **(b) The cascade reads pushed clients at their pre-push starts**, taken from the event log. It is heavier and it re-derives history on every render. I reject it.
- **(c) The push stops reducing the delta when the head was not moved.** This is arithmetically the simplest, but it re-opens D-43 and keeps the engine refusing the next 40 minutes after the desk has already moved the book. I reject it.

**Row: A-133 (S).**

**Confidence: high** on the model (the shipped push, preview included, the told marks, and the pure function checked both ways). **Medium** on frequency. Partial pushes are how my desk uses a push ("give them fifteen and see").

## 3. A client booked into a colour's processing time is projected at the colour's whole delay (S, no decision)

This is what segmented services exist for, and on my own book it happens most days:

```
Priya · Thu 12 Nov · Colour 13:15 in the chair (worked 13:05-14:00, 14:40-15:35) · Fringe trim 14:15 (in the gap) · Cut 15:45

+15 at 13:40   trim: likely 14:30, on the ring-round (15)   | Cut: likely 15:50 (5)  correct
               truth: application ends 14:15, the gap is 14:15-14:55, the trim is seen AT 14:15 — on time
+40 at 13:40   trim: likely 14:55 (40)                      | Cut: likely 16:15 (30) correct
               truth: application ends 14:40; the trim is 25 late, not 40 — off by exactly A-059's 15-minute threshold
```

**Cause: the chain is envelopes.** `occupiesStart`/`occupiesEnd` are the minimum and maximum over the worked blocks (`packages/db/day/day-view.ts:350-362`, A-093's collapse, which is correct for drawing the chip). `projectedDelays` therefore treats a colour as one solid block (`running-late.ts:245`). The trim client in the gap is waiting on the end of the colour's *first* block, not its last. A client *after* the whole colour is projected correctly, and must stay that way. A processing gap is not a hole a later client can use, because the colour's second block moves with its delay.

**What it costs.** One pointless call ("come fifteen late") and fifteen idle minutes in time that was sold precisely so the stylist would not be idle. This is smaller than findings 1 and 2, but it is the same function, and it touches the salon's most valuable service.

**Fix, within D-62:** a client whose booked start falls inside a processing gap of the appointment before her is late by `max(0, that block's projected end − her start)`, capped at the delta. The blocks are already on the busy read, so this needs no new query. Do it in the same edit as A-132 if convenient.

**Row: A-134 (S).**

**Confidence: high** on the measurement. **Medium** on value.

## 4. Re-run of the Phase 18 fixes, against the built code

- **A-130 holds at the instant its fixtures use.** Priya, Cuts at 13:00 (in the chair), 14:00, 15:00 and 16:00:

  ```
  13:30 +40, nothing cancelled        14:35 (35) | 15:30 (30) | 16:25 (25)        cascade, not flat: honest
  13:31 14:00 cancels, 15/16 told 40  15:00 ONTIME STALE | 16:00 ONTIME STALE      backlog measurement: holds
  two holes (14:00, 16:00), +40       ring-round empty
  same, +90                           15:00 -> 15:25 (25)
  told at 25, then +120               15:00 -> 15:55 (55) told 25 STALE            delta raised after the ring-round: holds
  Colour in chair, Cut after it       +15: 15:50 (5) | +40: 16:15 (30)              segmented predecessor: holds
  ```

  The chip, its accessible name and the ring-round agreed in every measurement. They read one `projectedDelays` call per column (`view-model.ts:365`, `running-late.ts:332`), and the provider tab renders the same `GridColumn` (`provider-day.tsx:65`). **It does not hold** after the chair's booked end, on a no-show hole, or after a partial push (findings 1 and 2).
- **A-131 holds.** For each release, the panel before the press, the write, the settled line and `/staff/opened` are shown in that order:

  ```
  R1 Colour + trim in gap, released 13:35     105m  13:35-14:15, 14:30-15:35  listed 14:30-15:35  | same | same | opened 14:30
  R2 Balayage, last block, released 16:00      40m  16:00-16:40              "It is on What's opened up" | same | same | opened 16:00
  R3 Cut released 14:44 (under the floor)      11m  14:44-14:55              "None of it is on What's opened up" | same | same | opened: none
  R4 Balayage + trim in gap 2, released 15:05  80m  15:05-15:15, 15:30-16:40  listed 15:30-16:40 | same | same @15:25 | opened 15:30
  R5 Colour + trim, released IN the gap 14:05  75m  14:05-14:15, 14:30-15:35  listed 14:30-15:35 | same | same | opened 14:30
  ```

  `listUnreleasedNoShows` offered the same minutes as the panel in all five cases. The settled line at 15:25 in R4 still names the 15:05–15:15 piece. It reads as a record of the release, which is what it is, and I am not asking for a change. (A probe note: `listOpenedSlots`' lookback filters on the event's wall-clock `createdAt`, so a probe on a future date has to widen `lookbackDays`. This is not a product defect.)

## 5. Rows

A-132, A-133 and A-134 are in `docs/prds/06-backlog.md` as rows 134–136, Phase 19. D-63 is needed before A-132 and A-133 can be built; I recommend (a) for both parts. A-134 needs no decision.

## 6. What Phase 18 left behind, and my call on each

- **"Told marks written before A-130 may read stale once."** Accepted. It is a one-off, and finding 1 is the flip that matters.
- **"A no-show outside working hours now offers nothing to release."** Correct: that time was never sellable.
- **A release in a late column still describes time the overrun occupies.** On the finding 1 no-show day, releasing Bea at 14:10 reads "45 min back: 14:10–14:55", while Ann is projected in the chair until about 14:35. That follows from D-22's engine interval, which is settled, and the engine refuses to sell into it. Once A-132 makes the chip honest, the desk reads the chip first. I am not asking for a change.
- **Still open from Phase 15 §5:** oldest-first match order and the D-54 column widening on heavy cancellation days. Fold them into whichever item next touches those files.

## 7. What NOT to build

- **Do not fix finding 1 by clearing or reducing the delta when the chair is checked out.** A delta is a named claim (D-22, D-62's rejection of (b)). Derive when the claim is spent. Never write it away.
- **Do not fix finding 2 by making the push stop reducing the delta.** That re-opens D-43, and the engine would keep refusing forty minutes the desk has already moved into the book.
- **Do not store a per-client projected delay.** One pure derivation serves the chip, the name and the ring-round, and that is why they agreed in every measurement above.
- **Do not make processing gaps holes for later clients.** The colour's second block moves with her delay, and the Cut after her is projected correctly today.
- Every earlier do-not-build list stands: no holds, no automated offers (OQ-4, A-053 blocked), no cron staleness alarm, and no re-opening of D-22, D-43, D-60(3), D-61 or D-62.

## 8. The process note

> **A DERIVATION THAT FILTERS BY "STILL GOING AT `now`" MUST BE TESTED AT A `now` THE FIRST ROW HAS OUTLIVED — AND EVERY FIXTURE FREEZES THE CLOCK TOO EARLY.** A-130's unit fixtures freeze `now` at 13:31 with the chair booked to 14:00. Its e2e runs next Tuesday, so the real clock is before every appointment. Neither can see the chain drop the client in the chair at her *booked* end, and that is the only time the desk looks at a late column twice. A projection must not change while the book does not. **Evaluate the same column at three instants — just after the claim, after the chair's booked end, after checkout — and assert that nobody's projection moves between them unless a book event did.** The second half of the note is Phase 6's rule again. D-62 changed what the delta means, and D-43's push still writes the delta for the old meaning. When a reader of a stored number changes its arithmetic, re-run every WRITER of that number against the new reader.

---

**Files cited, all verified against the working tree at `dcf9347`:**

- `packages/db/day/running-late.ts` (:123-126 `deltaAfterPush`; :234 chain filter on the booked envelope; :241-243 the head carries the whole delta; :245 envelope end; :332 ring-round reads `projectedDelays`)
- `packages/db/day/day-view.ts` (:350-362 `occupiesStart`/`occupiesEnd` = the min/max of the blocks)
- `apps/web/lib/day/view-model.ts` (:365 chip projection; :529-532 `pushFrom` skips the chair)
- `apps/web/app/staff/day/column-controls.tsx` (:57 push field defaults to 15; :328 "Now on time — ring back")
- `packages/db/day/push-column.ts` (:460 D-43 applied in the preview and the push)
- `packages/db/day/running-late.test.ts` (:809 `NOW = 13:31`, before the chair's booked end)
- `apps/web/e2e/running-late.spec.ts` (:80-85 next Tuesday; :218 the A-130 e2e)
- `packages/db/appointments/release-time.ts`, `packages/db/day/free-runs.ts`, `apps/web/lib/appointments/release-words.ts` (A-131, re-run and holding)
