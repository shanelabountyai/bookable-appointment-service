# Operator review: Phase 19 close

**Run 2026-09-22, at `a742cf3`, after A-134 closed Phase 19 and emptied the backlog.**

Phase 19 was the three findings from my Phase 18 review. I re-ran all three against the built code and did not rely on the write-ups. **All three hold at the instants their fixtures freeze** (section 4):

- **A-132 (the head).** The client in the chair stays the head after her booked end. A checkout after the claim frees the chair. A no-show hole now absorbs the delay.
- **A-133 (`pushedOffMinutes`).** After a partial push, the unmoved chair is still as late as she was, and the pushed clients read the remainder.
- **A-134 (the gap).** A client booked into a colour's processing time waits for the application only. The Cut after the colour is unchanged.

**This review found one defect, and it shows up three ways.** I proved each by running code against `bookable_test` as `db:reset:test` produces it. The probe scripts lived in the session scratchpad. No repo file was changed, the database was reset afterwards, and nothing here started a server or Playwright.

**Verdict: the cascade is now right about the client in the chair, and wrong about the next one.** Each Phase 19 fix holds at the moment it was tested, and one routine tap later that moment is over. The head is picked by a status check: the latest-starting client who is `in_progress`, or `checked_in` with her start passed. The head then carries the whole claim, plus any minutes a push took off it. **So the next client to sit down takes over the whole claim, however that claim has already been spent.** A-132's early-checkout fixture shows it directly. Ann is out at 13:50, so the 14:00, 15:00 and 16:00 all read on time. Priya starts Bea on time at 14:00, and the 15:00 and 16:00 go straight back on the ring-round at 35 and 30. Nothing about the day has changed except that the next client sat down. This is the same failure as Phase 18's finding 1, one client later: A-132 moved the flip, it did not remove it. It is one function and one small decision. **After it I would close the cascade and the project.** Section 6 lists the gaps I would live with.

---

## 1. A claim spent by a checkout comes back when the next client sits down, and a waiting client can take the head from the client in the chair (M, decision needed)

### 1a. The next client to sit down gets the whole claim back

This is the Phase 18 column, carried past the checkout into the next ordinary events:

```
Priya · Thu 29 Oct · Cuts (45 + 10 buffer): 13:00 Ann (in the chair), 14:00 Bea, 15:00 Cat, 16:00 Dee

13:30  +40 claimed          ring-round: Bea 14:00->14:35 (35) | Cat 15:00->15:30 (30) | Dee 16:00->16:25 (25)   correct
13:31  Bea cancels          ring-round: (empty)                                                              A-130, holds
       desk rings Dee back ("come at your booked time"), ticks at 0
14:40  Ann out at 14:36     ring-round: (empty)                                                              A-132, holds
14:51  Cat arrives early, checked in      ring-round: (empty)
14:53  Priya starts Cat at 14:52          Cat chip +40 | ring-round: Dee 16:00->16:35 (35) told 0 STALE
15:30  Cat in the chair                   identical                                                          truth: Cat out ~15:47, Dee on time
15:41  Cat out at 15:40                   ring-round: (empty)                                                Dee flips back again
```

**The same thing happens when Cat is only checked in.** Suppose the start tap is skipped, which is exactly the lapse D-22 is written around:

```
14:59  Cat checked in 14:58, before her 15:00   ring-round: (empty)
15:01  nothing tapped, clock passes 15:00        Cat chip "likely 15:40" | Dee 16:00->16:35 (35) told 0 STALE   (Priya idle since 14:36)
```

**This is A-132's own fixture with the clock moved on by one event.** `running-late.test.ts:983-989` asserts that everybody is on time at 13:51 after Ann's early checkout at 13:50:

```
13:51  Ann out early 13:50               ring-round: (empty)                                   the fixture's assertion, holds
14:01  Bea checked in and started 14:00  Bea +40 | Cat 15:00->15:35 (35) | Dee 16:00->16:30 (30)
```

### 1b. A pushed client who has checked in takes the head, with the pushed-off minutes, while the late client is still in the chair

This happens on a partial push, which is the push form's default. The next client arrives at her new time and the desk checks her in. That is the normal order of events on a late day:

```
Priya · Cuts 13:00 Ann (in the chair), 14:00 Bea, 15:00 Cat, 16:00 Dee · +60 at 13:30, push +20 from 14:00 (delta 40, pushed off 20)

13:32  after the push       Ann +60 | Bea 14:20->14:55 (35) | Cat 15:20->15:50 (30) | Dee 16:20->16:45 (25)      A-133, holds
       desk rings Cat (25... then 30) and Dee, ticks
14:19  Bea checked in 14:12              identical
14:21  clock passes Bea's pushed 14:20   Ann loses the head | Bea chip +60 "likely 15:20"
                                         Cat 15:20->16:00 (40) told 25 STALE | Dee 16:20->16:55 (35) told 20 STALE
       truth: Ann is still in the chair until 14:55; Bea 35, Cat 30, Dee 25, exactly as at 13:32
```

Two "ring again" calls are generated with no change to the book. Only the clock moved past a waiting client's start. The +15-of-40 default push does the same thing at a smaller size: Cat goes from 15 to 25 and Dee from 10 to 20, with Bea's chip at +40 on her pushed start.

### 1c. A colour drops out of the chain at her booked end when her gap client was never checked out

```
Priya · Colour 13:15 Cora in the chair (13:05-14:00, 14:40-15:35) · trim 14:15 Tess (in the gap) · Cut 15:45 Uma · +40 at 13:40
14:40  Tess started, done in the gap, checkout forgotten
15:36  Tess heads (+40, ends 15:15); Cora is past her booked end and not the head, so she drops
       Uma 15:45: on time, off the ring-round      truth: the rinse runs to 16:15, Uma is 30 late
```

This needs one lapse, a forgotten checkout on a 20-minute trim. It is lower frequency than 1a and 1b. It is in the same lines of code, so fix it in the same edit.

### Cause: the head is chosen by status, and it always carries the whole claim

All citations are in `packages/db/day/running-late.ts`:

- **`:309-311`: the head is the latest-starting `in_progress` or `checked_in` client whose start has passed.** A checked-in client waiting for the chair outranks the client actually in it (1b). The client seated after a checkout becomes the head (1a).
- **`:313-323`: the post-claim checkout is only read when there is no head.** "Nobody after her inherits the delta" (D-63(1)) therefore lasts until the next client sits down. D-63's two sentences disagree here: "the head is the client in the chair, projected at booked end + delta" and "once she is checked out … nobody after her inherits the delta". The build follows the first.
- **`:340-341`: the head carries `minutes + pushedOffMinutes` unconditionally.** D-63(2) says that is for "the unmoved head". A pushed client who becomes the head carries the push twice.
- **`:325-326`: only the head is exempt from the booked-end filter.** A second client in the chair (the colour) still drops out of the chain at her booked end (1c).

**The fixtures that pass against it.** The backlog fixture (`running-late.test.ts:925-940`) never checks Cat in. The early-checkout fixture (`:983-989`) stops at 13:51. Every A-133 fixture (`:1044-1095`) evaluates at 13:31 with nobody checked in. The A-134 fixtures (`:1147-1164`) do the same. **Each one stops the clock at the event that set the answer, and the next routine tap resets it.**

### What it costs

1a hits every late day on which the stylist catches up and carries on, which is the good outcome of a late day. The desk rings Dee to "come thirty-five late", then rings her back, then may ring her a third time. If Dee believes the first call, Priya stands idle from about 15:47 to 16:35. That is one cut, $55–65 on my prices (my estimate). 1b hits most partial-push days on my book (my estimate): the client checks in on arrival, and the rest of the column jumps by the pushed minutes. The trust cost is the same one Phase 18 named. A ring-round that changes its mind with nobody touching the book gets ignored, and the Post-it goes back on the desk.

### Needs a decision (D-64: whose claim it is once the chair has changed hands)

D-22, D-43, D-62 and D-63 all stand. This decision only says how the head rule and the checkout rule combine.

- **(a) Recommended. The claim belongs to the chair as it was when the claim was made, and three rules follow from that.**
  1. **A checkout after the claim spends it, whether or not the chair has been filled since.** The chain seeds from the latest checkout at or after `claimedAt` (`endedAt` + her after-buffer). A client seated after that checkout is projected from it like any other chain member, capped at the delta. This is D-63(1)'s "nobody after her inherits the delta" winning over the head rule.
  2. **An `in_progress` client outranks a `checked_in` one for the head.** A `checked_in` client past her start is the head only when nobody is `in_progress`. D-63's "latest-starting" still breaks ties within each status.
  3. **Every client in the chair stays in the chain until she is checked out, not just the head.** Each one is projected as a member.
- **(b) Rule 1 only.** It fixes 1a, which is the commonest case, and leaves the partial-push flip (1b) and the colour drop (1c). I reject it: 1b is the default push path.
- **(c) Prompt the desk to clear the claim at checkout** ("Priya's chair emptied after the claim — back on time?"). I reject it. It is a tap the desk skips on exactly the days this matters, and it fixes a wrong derivation with desk discipline.

**What (a)(2) costs.** A forgotten `in_progress` 11:00 plus an un-started current client (two lapses at once) would let the 11:00 head the chain. This is the mirror of the two-lapse case A-132 already accepted.

**Not in scope:** a pushed client who heads the chain after a claim made with an empty chair (section 6), D-22's engine interval, and D-43's stored arithmetic.

**Row: A-135 (M).**

**Confidence: high.** It was run end to end on four shapes through `loadDayView` with the real `transitionAppointment`, push and told-mark paths. Each flip happens on a routine tap, with the chip, the ring-round and the stale flag all agreeing on the wrong answer.

## 2. Nothing else in the cascade is worth a row

I tried the shapes the brief named and the Phase 19 fixtures never reached:

| Shape | Result |
|---|---|
| Colour head with a trim in the gap: trim checked in, clock past her start, started, checked out; colour past its booked end | Uma (the Cut) reads 30 at every instant, which is correct. Tess's chip says +40 once she is checked in and past her start, against a true 25. She is in the building, and D-64(a)(2) fixes it anyway. |
| Pushed client who is also in the gap (push +15 from the trim) | The push leaves Tess behind (`blocked-by-one-that-stays`, the rinse) and moves Uma. D-43's partial-push rule keeps the delta at 40. Tess reads 25 and Uma 16:00->16:15 (15). Both are correct. |
| No-show in the gap | Uma and Vi are unchanged (30/25), which is correct: a gap is not a hole. |
| No-show after the colour (Uma, 15:45, marked at 16:00) | Vi at 16:45 is on time, and the colour's rinse to 16:15 is absorbed. Correct. |
| Checkout during the gap (Tess out at 15:00) | The head goes back to the colour. Uma is 30, which is correct. |

## 3. Is the running-late cascade done?

**After A-135, yes.** Four closes in a row have found cascade defects, and they are one defect moving along the column. Each fix held at its own instant, and the defect reappeared at the next instant nobody tested. A-135 needs to add the walk-the-day fixture from section 8, not another single-instant fixture. With that fixture in place, the remaining imprecision is what an operator lives with. It is bounded by the delta cap and mostly under A-059's 15-minute threshold (section 6). **I will not scope another cascade row unless it flips the ring-round with no book event behind it.** Anything smaller goes in `DEMO.md`'s concessions.

## 4. Re-run of the Phase 19 fixes, against the built code

- **A-132 holds at its instants.** On the backlog column, 13:31, 14:40 (after the 14:36 checkout) and 14:51 (Cat checked in, before her start) all read an empty ring-round. The early-checkout shape is empty at 13:51. The no-show hole holds as in its fixture. **It does not hold** once the next client sits down (finding 1a).
- **A-133 holds while the late client is still the head.** At +15 of 40, 13:32 reads Ann +40, Bea 14:15->14:35 (20), Cat 15:15->15:30 (15), Dee 16:15->16:25 (10). At +20 of 60, 13:32 reads 35/30/25. Both are exact. **It does not hold** once a pushed client is checked in past her new start (finding 1b).
- **A-134 holds** at every instant in section 2, including a colour past its booked end with the trim checked out.

The chip and the ring-round agreed in every measurement, including the wrong ones. They read one `lateMinutes` computed once per column (`day-view.ts:390-395`). That is the right shape, and it is why the fix is one function.

## 5. Rows

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
|---|---|---|---|---|---|---|
| 137 | ⬜ A-135 | See `docs/prds/06-backlog.md` row 137 for the full text. | APPT-03, APPT-04; D-22, D-43, D-62, D-63 | M | A-134 | 20 |

D-64 is needed before A-135 can be built. I recommend (a). No other rows.

## 6. What Phase 19 left behind, and my call on each

- **"A forgotten `checked_in` earlier client with the real one never tapped in would head the chain"** (A-132). This needs two lapses. Accepted. D-64(a)(2) adds its mirror image, which is also accepted.
- **"The engine interval still reads the reduced delta; the column badge shows the reduced delta"** (A-133). These are D-22 and D-43, settled. Accepted.
- **"A gap client's own block is not checked against the colour's projected second block"** (A-134). This needs a delta bigger than the gap and is bounded by D-62's cap. Accepted.
- **A pushed client who becomes the head after a claim made with an empty chair carries delta + pushed-off on her pushed start.** Measured: +40 with an empty chair, push +15, Bea checked in. Bea's chip reads +40 against a true 25, and Cat reads 25 against a true 20. The cap bounds it, and the client affected is standing in the building. Live with it. Put it in `DEMO.md`'s concessions.
- **After a claim is spent, the engine still refuses the next `delta` minutes** (D-22's interval runs from `now`). At 14:40 on the 1a day a walk-in cannot be offered to an idle Priya until the desk taps "Back on time". That is one tap, and the refusal names `running-late`. Live with it. D-22 is settled.
- **Still open from Phase 15 §5:** oldest-first match order, and D-54 widening a column on heavy cancellation days. I would not build either now. Concede both in `DEMO.md`.

## 7. What NOT to build

- **Do not fix finding 1 by clearing the claim at checkout, or by prompting the desk to.** A delta is a named claim (D-22, D-62(b), D-63(1)(c)). Derive when it is spent.
- **Do not derive the head's delay from `startedAt`.** D-22 rejected it, and the start tap is the one that gets skipped.
- **Do not read the event log to find out who a push moved.** D-63(2)(b) rejected history reads on render, and D-64(a) does not need them.
- **Do not add a per-client stored delay, a staleness alarm, or an automated re-ring.** One derivation serving the chip, the name and the ring-round is why they agree.
- Every earlier do-not-build list stands: no holds, no automated offers (OQ-4, A-053 blocked), no cron staleness alarm, and no re-opening of D-22, D-43, D-60(3), D-61, D-62 or D-63.

## 8. The process note

> **A FIX THAT HOLDS AT THE EVENT IT WAS WRITTEN FOR MUST BE WALKED TO THE NEXT ORDINARY EVENT — AND ON A SALON COLUMN THE NEXT ORDINARY EVENT IS ALWAYS THE NEXT CLIENT SITTING DOWN.** Phase 18's note said to evaluate the column at three instants. A-132 did, and all three came before the next client was checked in. `projectedDelays` picks its head with a status predicate, and check-in and start are the two taps the desk makes most. A fixture that freezes the book at the event that set the answer is testing an arrangement of statuses that lasts about ten minutes. **Walk the column through the day's routine taps in order (check in on arrival, the clock past her start, start, checkout, for each client in turn) and assert that no projection moves unless the chair's true free time moved.** One walk-through fixture replaces the next four single-instant ones. The second half is D-63's lesson: a decision that states two rules in two sentences ("the head carries the delta", "nobody after her inherits it") has to say which one wins when both apply, or the build picks one silently.

---

**Files cited, all verified against the working tree at `a742cf3`:**

- `packages/db/day/running-late.ts` (:309-311 head = the latest-starting in-chair client by status; :313-323 checkout read only with no head; :325-326 non-head in-chair members still drop at their booked end; :340-341 the head carries `minutes + pushedOffMinutes` unconditionally)
- `packages/db/day/day-view.ts` (:350-363 the per-appointment block fold; :390-395 one `projectedDelays` per column, carried as `lateMinutes`)
- `packages/db/day/push-column.ts` (:737 the `column_pushed` event, cited only to rule it out as the mechanism)
- `apps/web/lib/day/view-model.ts` (:366-367 the chip shows `lateMinutes` for `checked_in`; :529-532 `pushFrom`)
- `packages/db/day/running-late.test.ts` (:925-940, :983-989, :1044-1095, :1147-1164: each stops before the next client sits down)
