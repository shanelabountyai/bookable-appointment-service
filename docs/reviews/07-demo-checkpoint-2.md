# Demo checkpoint 2 — the walk

**Walked 2026-08-18, at the Milestone 3 boundary (A-027 closed it).**
**Result: it ran, and it found two real defects and one product question.**

The backlog's instruction is to walk it when the milestone closes, not when
convenient, because rental's checkpoint-1 defects all sat in items already
marked ✅ and every one was invisible from inside the item that introduced it
(D-28). Both defects below are exactly that shape: every unit and e2e test for
the items involved passed while they were true.

The walk was scripted rather than clicked, so what follows is transcript. The
script has been deleted; what it found lives on as a regression test and two
code changes.

The seed is anchored to a fixed week (`2026-06-09`..`13`), which is in the
past, so the walk injects Saturday morning's clock — every write path takes
`now` as a parameter precisely so that is possible.

---

## 1. A walk-in booked from the grid, into a gap — ❌ **DEFECT**, now fixed

```
Dana's Saturday: 7 booked, 7 gaps
  gaps: 09:55–10:00 (5m)  10:55–11:00 (5m)  11:55–12:00 (5m)  13:55–14:00 (5m)
        14:55–15:00 (5m)  15:55–16:00 (5m)  16:55–17:00 (5m)
  (Dana's Saturday has no usable gap — taking Priya's instead)
  gap opens 13:35; first offered time at or after it: 13:45
booked walk-in at 13:45 with no client record → id cmsz04lx…
```

**What was wrong.** A gap begins where the previous appointment's *buffer*
ends — 13:35 — and the slot grid is anchored to window-open on the salon's
15-minute interval, so 13:35 is not a candidate the engine will ever offer.
Clicking a gap therefore sent the desk to `/staff/book?at=13:35`, the booking
was refused with `SlotNotOffered` **carrying no reasons at all** (a
non-candidate has no exclusion entry), and the panel — which offers an
override on any engine refusal — invited staff to **override into a slot that
was completely free**.

That is the failure mode VISIT-01 already names in another context: routing
ordinary bookings through the override path makes the override marker
meaningless, and a marker nobody trusts is one nobody reads.

**The fix.** A gap link is now a *starting point*, not a bookable instant. The
panel lists the real offered times for the chosen service and preselects the
first one at or after the gap the desk tapped. One tap for the ordinary case,
and the list is right there to correct it.

**And a regression I introduced fixing it, caught by A-017's own suite.** My
first version fell back to the day's *first offered slot* when nothing was
offered at or after the requested time — which silently turned "book her at
18:00, after we shut" into a 9am booking and reported success, making BOOK-05's
outside-hours override unreachable. The fallback is now the requested time
itself, so an unofferable time still reaches the refusal and the override that
belongs with it. Two defects in the same seam, in opposite directions: one made
an override necessary where it should not be, the other made it impossible
where it should be.

**Why the tests missed it.** A-016's and A-017's fixtures book on-grid times
(10:00, 14:00), so their gaps opened on-grid too. The defect needs a service
whose duration and buffer do not divide the slot interval — which is most of
the seeded catalogue and none of the fixtures.

---

## 2. The day column showed the neighbouring days — ❌ **DEFECT**, now fixed

```
Dana: 61 appointments in total, 2 with startDay = 2026-06-09
day view shows 29 in Dana's column
  which start on days: 2026-06-09, 2026-06-10
  first: 2026-06-09 09:00
  last : 2026-06-10 16:30
  render bounds: 2026-06-09 08:50 → 2026-06-10 17:00
```

**What was wrong.** `loadDayView` deliberately queries a window of local
midnight ±24 hours: the busy set needs that width so a neighbouring day's
buffers still subtract correctly, and an overnight window needs it to exist at
all. The *displayed* appointments were never clipped back. On a seeded week,
Dana's Tuesday column showed 29 appointments running into Wednesday afternoon,
and the grid's vertical extent stretched across two days.

**The fix.** An appointment is drawn in a column only if it overlaps the day
itself or one of that provider's resolved windows for it. The gap arithmetic
still uses the wide set, because that width is load-bearing there.

**Why the tests missed it.** Every A-016 test seeds a single day. The defect
cannot appear without a *neighbouring* day that has rows in it — which is what
a seeded week has and a unit fixture does not. The regression test now books
Monday, Tuesday and Wednesday on purpose and asserts the Tuesday column
contains exactly one appointment. Removing the clip makes it fail.

After the fix:

```
day view shows 2 in Dana's column
  which start on days: 2026-06-09
  render bounds: 2026-06-09 08:50 → 2026-06-09 17:00
```

---

## 3. Check in the client who arrived late — ✅

```
Ellie Dunn booked 09:00, checked in at 10:12
  status booked → checked_in; scheduled start unchanged: 09:00
```

The actual arrival is recorded and the scheduled time is untouched — D-7's
actual-vs-scheduled, which is what makes "she was seventy minutes late"
answerable afterwards.

## 4. Dana runs +38, and the column projects — ✅

```
stored delta: 38m by staff
day view says: +38 min
  Tom Byrne: booked 13:00 → likely 13:38
  Alice Hall: booked 14:00 → likely 14:38
  Sam Okafor: booked 15:00 → likely 15:38
slots withheld because she is behind: 6
  e.g. 10:15 10:30 10:45 11:00
```

The delta is stored with the actor who claimed it, the projections appear
beside the scheduled times, and six slots the booking page would otherwise
have sold are withheld with the reason `provider-running-late` — operator R-1's
headline, closed.

## 5. Push the column from 2pm — ✅ mechanically, ⚠️ **but see the question below**

```
+30m: 3 would move, canPush=false — 1 past closing (16:00)
+60m: 3 would move, canPush=false — 1 past closing (16:00)
+90m: 3 would move, canPush=false — 2 past closing (15:00, 16:00)
refused: 1 past closing
```

The preview names the collision before anything moves and the refusal is
total, which is what APPT-04 asks for. See §9.

## 6. Dana calls in sick — ✅

```
4 stranded:
  13:00 Tom Byrne     +15125550106 — Cut [booked]
  14:00 Alice Hall    +15125550101 — Cut [booked]
  15:00 Sam Okafor    +15125550103 — Cut [booked]
  16:00 Nadia Rahman  +15125550105 — Cut [booked]
reassigned to Priya: 2; could not: 2 (provider-busy)
after: 2 still conflicting, 2 kept-flagged
nothing cancelled: true
```

Recording the absence succeeded with nine clients in the book, every stranded
client came back with a phone number, the partial reassignment reported what it
could not do, and **nothing was cancelled**.

## 7. The customer's manage link — ✅

```
link opens: yes → appointment cmsz04le…
  she is booked 13:00 with Marcus
  rescheduled 13:00 → 16:00, same id true
  same link still opens after the move: yes
  cancelled with the same link: booked → cancelled
```

The whole of D-5 in four lines: multi-use, survives the reschedule it was used
for, and the same link then cancels.

## 8. A no-show mis-tap, corrected — ✅

```
corrected: no_show → completed, isCorrection=true
  arrival timestamps after correction: checkedIn=null ended=null
```

Recorded as a *correction* rather than a status change, and it invents no
timestamps — nobody knows when a visit mis-marked as a no-show actually ended,
so the system does not pretend to.

Every action is in the log:

```
  booked by staff
  status_changed by staff
  status_corrected by staff — "mis-tap, she was here"
```

```
event types written across the whole walk:
  booked: 225   status_changed: 3      provider_changed: 2
  conflict_acknowledged: 2   status_corrected: 1   rescheduled: 1
outbox:
  appointment.confirmed: 225   appointment.rescheduled: 1
```

---

## 9. The product question this walk raises — for the owner

**"Push the column" is all-or-nothing, and on a real Saturday that makes it
unusable at the moment it is needed.**

Dana is 38 minutes behind. Here is every push size the product will accept:

```
+ 5m  canPush=true   moving=3  stuck=0
+10m  canPush=false  moving=3  stuck=1 (16:00)
+15m  canPush=false  moving=3  stuck=1 (16:00)
+20m  canPush=false  moving=3  stuck=1 (16:00)
+30m  canPush=false  moving=3  stuck=1 (16:00)
+38m  canPush=false  moving=3  stuck=1 (16:00)
+60m  canPush=false  moving=3  stuck=1 (16:00)

Dana's Saturday: 09:00 10:00 11:00 13:00 14:00 15:00 16:00
last: 16:00–16:45, blocked to 16:55; she closes 17:00
```

**Five minutes is the largest push allowed**, because her last client of the
day blocks to 16:55 against a 17:00 close. The three afternoon clients could
all move 38 minutes with room to spare; one client at the end of the day vetoes
the entire operation, and the desk is left doing by hand exactly what the
feature exists to do.

I implemented all-or-nothing from APPT-04's "refuses silently-lossy shifts",
and I still think that is the right reading of *silently*. But note the
inconsistency with A-019, built two items later: its bulk reassign is
deliberately partial, because "three reassigned to Priya, six kept-flagged" is
the demo checkpoint's own wording. Both are bulk operations over appointments;
they answer this question differently.

**The options, as I see them:**

1. **Leave it.** All-or-nothing, and the desk shortens the push or moves the
   last client by hand. Safe, and occasionally useless.
2. **Named partial push** — move what fits, refuse the rest, and say who was
   left behind, exactly as the reassignment does. A partial push that names its
   casualties is not *silent*, which is what APPT-04 actually forbids.
3. **Push-and-overflow** — offer to push the stuck one past closing as a
   BOOK-05 override, with a reason. Honest, and it puts a marker on the one
   appointment that needs a conversation.

My recommendation is **(2)**, for consistency with A-019 and because the desk's
real question is "who do I have to ring?". It is a change to APPT-04's meaning,
so it is the owner's call, not mine.

**Answered 2026-08-18: (2), the named partial push.** Recorded as D-26 and
implemented in the same session. One consequence surfaced while building it and
is worth stating here, because it changes what the feature can promise: an
appointment left behind still occupies its old time, so anything that would
shift on top of it cannot move either — and that cascades backwards. On a
fully packed column the honest answer is still "nothing moved, and here is who
is in the way", which is a better answer than a bare refusal but is not the
same as "it now works". Without the cascade a partial push would hand the
database a genuine overlap and the whole transaction would fail at COMMIT,
naming no pair at all.

---

## 10. Smaller observations — no code change

- **The checkpoint's own prose does not match the seed.** It describes "the
  2:15 gap" and "the 10:00 who arrived at 10:12". On the seeded Saturday, Dana
  is fully booked with seven five-minute slivers, her first client is 09:00,
  and the only usable gap belongs to Priya at 13:35. The walk reports what the
  seed actually contains rather than engineering the seed to match the prose —
  the same call checkpoint 1 made about its "11:15" example.
- **A customer cancelling through her manage link produces no outbox row**, and
  nothing tells the salon either — it is visible on the grid and in the log,
  and that is all. Same for a reassignment: the client is handed to a different
  stylist without being told. Neither is in a story yet (A-020's machinery and
  A-022's reminders are where notifications get their second pass), but a
  client turning up expecting Dana and finding Priya is an operator-facing gap
  worth a backlog line.
- **Event rows are stamped by the database clock** (`@default(now())`) while
  every domain decision uses the injected `now`. In production those agree; in
  a scripted walk with an injected clock the log's times are the walk's own.
  Not a defect, but worth knowing before someone tries to assert on them.

---

## Verdict

Milestone 3's screens hold up: the sick day, the running-late column, the
manage link and the correction path all did what they promise, and nothing was
silently cancelled, moved or hidden at any point.

Two defects found, both fixed here, both invisible from inside the items that
introduced them — which is the entire argument for walking a checkpoint at the
milestone boundary rather than trusting a green suite. One product question
raised for the owner rather than decided quietly.
