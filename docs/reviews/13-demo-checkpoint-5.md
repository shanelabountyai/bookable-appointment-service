# Demo checkpoint 5 — the walk

**Walked 2026-09-01, at the Phase 6 boundary (A-064 closed the last built row
and the scoped backlog ran out for the seventh time).**
**Result: three defects, and all three are the same item's blind spot —
A-063 changed what a chair means and three readers were never told.**

Checkpoints 1–4 each found a defect sitting inside an item already marked ✅
and invisible from within the item that introduced it. This one is a sharper
version of the same shape: **A-063 split one invariant into two, fixed the
database, the chooser and three write paths — and left three OTHER readers
still asking the old question.** Its own PROGRESS entry names one of them and
characterises it as harmless. It is not.

The second theme is the one A-060 warned about and A-057 could not hear,
because A-057 shipped first.

The walk was scripted rather than clicked, so what follows is transcript. The
scripts have been deleted; what they found lives on as three fixes and eight
regression tests, each one verified to FAIL against the code as it stood.

Scenes were chosen at the **seams between** items rather than down the middle
of any one, as before.

---

## Finding 1: the salon ends a standing booking, and the client wears it

`endSeriesHere` classified each occurrence from the clock alone:

```ts
to: row.insideCutoff ? 'cancelled_late' : 'cancelled',
```

with a comment saying "§7 lets staff write either unconditionally, so nothing
downstream re-decides this". That was true when A-057 shipped. **A-060 is the
item that stopped it being true**: it took the classification off the front
desk *and* gave the desk an escape — "she gave us proper notice", "this one's
on us" — precisely so a cancellation the SALON caused never lands on an
innocent client's rolling count. A-057 has no escape, and it is the one action
where the salon is usually the cause.

Mrs Kerr's six four-weekly Tuesdays, ended on the morning of the next one
because Dana is leaving:

```
booked standing Tuesdays: 6
ended: 6 notified: 6
   2026-03-03T20:00:00.000Z cancelled_late     <-- the one inside the window
   2026-03-31T19:00:00.000Z cancelled
   ... four more cancelled

Mrs Kerr, whose only fault was booking a standing appointment:
  noShows: 0  lateCancels: 1  blocked: false

FINDING? salon-caused end stamped a late cancel: true
```

One occurrence, not six — only the imminent one is inside a 24-hour cutoff, and
the row's own "six taps" framing does not apply to the classification. It is
still wrong, and it is worse than it looks for a reason the row itself names:
**"end here, rebook from here" is this product's documented way to MOVE a
standing appointment.** A client who asks to shift her 2pm to 2:30 is marked a
late canceller for asking. `client-flag.tsx` then shows "1 late cancel in the
last 12 months" at the desk, for a year.

It does not block her online booking — `selfServeBlocked` counts no-shows only
— and saying so precisely matters more than the finding sounding big.

**The fix routes the series end through A-060 rather than around it.** The
status now comes from `cancellation: 'derive'`, so the cutoff is resolved once,
in `transitionAppointment`, from real rows — the second copy of the arithmetic
is gone, which is the same argument A-060 made about the two buttons. One
checkbox on the panel, "This one is on us — do not count it against her",
passes `cancellation: 'override'`; the reason this action already demands
satisfies `override`'s own requirement for one, so nothing new is asked of the
desk. The overruled classification is still recorded per occurrence, so
`/staff/dashboard/overruled` can answer "how many, and who" exactly as before.

The result message stopped claiming "3 inside the cancellation window" after
the desk has just said none of it counts.

## Finding 2: the push refuses a chair its own client is sitting in

A-063's PROGRESS left this behind explicitly, and got the severity wrong:

> A-018's column push has its own in-memory chair planner and was not taught to
> share — it is strictly stricter than the database, so a push can silently
> split a shared chair back into two rather than fail. Nothing refuses and
> nothing double-books; it is a seating cosmetic.

It refuses. Nadia has a cut with Dana and a colour with Priya, buffers
overlapping and bodies a clear gap apart — one chair, by A-063. A chair is
retired mid-Saturday (checkpoint 4's own scene), leaving three for a room that
genuinely needs three. Dana is five minutes behind:

```
at 13:50-14:00 — holds: 4  chairs actually used: 3
retired a chair; assignable chairs now: 3

push Dana +5:  canPush = false
   Nadia Okafor  13:00 -> 13:05   no-chair-free
```

`canPush = false`. The column cannot move at all, and the reason given is a
chair with nobody else in it. A planner stricter than the constraint does not
fail safe here — it refuses the move on the busiest day, which is the only day
anyone presses the button.

**The fix makes `planChairs` ask the two questions the database asks**, in the
same shape and the same order: envelopes may overlap only for the same holder
(`holderKey WITH <>`), bodies never overlap for anyone. `holderKey` is derived
in the planner with the identical `COALESCE(clientId, 'appt:' || id)` the
hold-writing trigger uses — a nullable key would make every unnamed walk-in one
holder, free to pile into a single chair.

The greedy first-fit and its `ponytail:` note are untouched; this changes what
"free" means, not how a chair is picked.

## Finding 3: the room stopped OFFERING a chair that is empty

The sharpest of the three, because it is the only one a client meets, and
because it is A-063's own stated harm still running.

`fullSpans` collapses the room's cardinality question into busy intervals for
the engine. It counted **holds**:

```ts
events.push({ t: h.start, delta: 1 }, { t: h.end, delta: -1 });
```

A-063 made one woman's two appointments share one chair. From that moment "how
many holds overlap" and "how many chairs are taken" stopped being the same
number, and this function was still counting the first. So a two-chair room
with one chair genuinely free declared itself full, and the engine subtracted
the interval before anything reached a screen:

```
NoResourceFree: Every Chair is taken for that time.
```

Read A-063's row back:

> the room reports full and refuses a real client on the authority of a chair
> with nobody in it.

That is what it fixed at the constraint and the chooser, and what was still
happening at the offer. **A-063's own tests could not see it** — they asked
`findFreeResource` and they asked the constraint. Nothing asked the thing that
decides what a client is shown, so the defect lived in the gap between "she
could be seated" and "she is ever offered the time".

**The fix counts chairs.** `fullSpans` takes `ChairHold` — a span with its
`resourceId` — and sweeps a per-chair open count, so a chair is occupied once
however many of one client's holds are sitting on it. The type change is
deliberate: every caller now has to say which chair, and the compiler found
them all.

---

## What was walked and found clean

Worth recording, because a checkpoint that only lists defects reads as if
nothing else was checked.

**The client merge against the shared chair.** Merging two records for one
woman reassigns her appointments to the survivor, and `clients.ts` never
touches the holds — so `holderKey` looked like a column that could go stale and
resurrect A-063's bug for anyone who was ever a duplicate. It cannot:
`appointment_write_resource_hold` rewrites the hold on every appointment write
and derives the holder from `NEW."clientId"`, so the merge's `updateMany`
resyncs it. Walked, and the chair still followed her.

That trigger is the reason findings 2 and 3 were possible at all, and the
reason there were not five: everything that reads holds THROUGH the database
was already correct, and the three things that were wrong all kept their own
copy of the room in memory or in a sweep.

## The lesson, which is one sentence

**A-063 split an invariant in two and the split reached the writers but not the
readers.** The status-enum trap this repo was built to prevent — "a status enum
is never one edit" — has a mirror image nobody had written down: a CONSTRAINT
is never one edit either. The write paths were threaded carefully; the three
places that model the room independently of the database were not, because
nothing named them as readers of the same rule.

Proposed for CLAUDE.md, alongside the status-enum rule.
