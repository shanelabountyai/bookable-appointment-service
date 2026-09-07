# Operator review — Phase 10 close

**Run 2026-09-07, after A-097 closed Phase 10 and emptied the backlog for the
eleventh time.**

Phase 10 did what D-49 scheduled it to do. The token layer is measured rather
than asserted (A-088), the primitives are a subset with a caller each (A-089),
the shell exists after four phases of being named as the gap (A-085), the demo
book finally binds the room and carries a waitlist (A-095), and every axe
assertion in the suite now measures both colour schemes through one helper with
a lint rule shutting the other door (A-096). A-093 is the best single item in
the phase: the printed sheet found a two-hour colour drawn eighty-five minutes
low, on the home screen, that three demo checkpoints had walked past.

**This review found four defects that are not design and not accessibility.
Every one of them was proved by RUNNING code against `bookable_test`, and the
transcripts are quoted verbatim below.** Two of them share one shape, and it is
worth naming before the list starts:

> **THE PRODUCT HAS TWO WAYS A STYLIST STOPS BEING AVAILABLE, AND NEITHER ONE
> IS SCOPED TO THE TIME IT AFFECTS.** A `TimeOff` row is a RANGE and the screen
> that resolves it ignores the range entirely — `/staff/conflicts?day=` shows
> every day's stranded client on every day of the year. `Provider.active` is a
> BOOLEAN with no range at all, so an absence that starts on Friday and never
> ends deletes the whole forward book from every screen the salon runs on.
> One is loud and wrong; the other is silent and empty.

**Verdict: the book is correct, the room is correct, the desk now has a
building to walk around in — and the two events that take a stylist out of the
book are the ones the building has no room for.** The most consequential defect
is finding 1: on the demo install as it ships today, taking one stylist off the
roster removes **106 appointments worth $2,870** from every screen in the
salon, keeps their chairs held, and keeps texting the clients a reminder.

---

## 1. A stylist taken off the roster takes her whole forward book off every screen — M, and it is silent

A stylist gives notice on a Friday. The owner opens `/staff/providers` and
unticks her, which is the one action the product provides for "she does not
work here any more" and the one thing that must happen, or the website keeps
selling her. A-041 does the right thing at that moment: it refuses the first
click and shows the list of everybody still booked with her, with phone
numbers, behind a "Deactivate anyway" button.

**That list is the last time anyone in the salon ever sees those clients.**

Run on the demo book as `db:reset:test` produces it, deactivating Tess and
changing nothing else:

```
BEFORE  /staff/day?day=2026-09-08  ->  Dana(13) Priya(8) Marcus(2) Tess(7)
AFTER   /staff/day?day=2026-09-08  ->  Dana(13) Priya(8) Marcus(2)
        /staff/conflicts?day=2026-09-08  ->  0 stranded
        /staff/opened                    ->  0 freed spans (unchanged)
        still in the database: 106 future appointments; chairs held: 106
```

`futureAppointments` over the same book, per stylist:

```
Dana     58 future appointments   worth $2,535.00
Priya    27                       worth $1,410.00
Marcus   26                       worth $1,755.00
Tess    106                       worth $2,870.00
```

The demo book only runs nine days forward. A real salon takes rebookings six to
eight weeks out at the till, so multiply.

**Four screens, one line each, and each is correct in isolation.**

- `day-view.ts:144` — `where: { businessId: args.businessId, active: true }`.
  The column is not empty; it is **absent**. Seven clients came off tomorrow's
  grid, and the printed day sheet renders the same `GridModel`, so they are off
  the paper too.
- `conflictsForDay` (`impact.ts:361`) derives a conflict two ways — outside
  resolved hours, and overlapping an absence. Deactivation writes neither. Her
  weekly windows are untouched and there is no `TimeOff` row, so **nothing is
  stranded** on any day.
- `unfinished.ts:94` — `provider: { is: { active: true } }`. Proved from both
  sides on the same rows, changing only the boolean: `listUnfinished` an hour
  after they ended returns **3 with the provider on the roster and 0 with her
  off it**. They can never be closed out, so `dashboard.ts`, `lapsed.ts` and
  `reliability.ts` are permanently wrong about every one of them — which is the
  exact harm D-46 and A-081 were built to end, arriving through a door neither
  of them touched.
- `opened.ts:217` — same filter. If one of those clients cancels, the freed
  Saturday never reaches the screen whose job is selling it.

**And the client is still being told to come.** `reminders.ts` has no provider
filter at all — correctly, on its own terms, since a reminder is about an
appointment. Run with the provider off the roster:

```
Marcus active = false
reminder job:  { due: 1, enqueued: 1, duplicate: 0 }
outbox:  appointment.confirmed  -> +15125559999
         appointment.reminder   -> +15125559999
```

So she gets "your appointment is tomorrow at 4:30". She taps the manage link to
move it, and the engine answers with an empty day, forever — same appointment,
same link, only the boolean changed:

```
with the stylist ON  the roster, her manage link offers  windowInstants:[{...}]  on 2026-09-16
with the stylist OFF the roster, the same link offers    windowInstants:[]  candidatesConsidered:0
```

She rings the salon. The desk opens the day. There is nothing at 4:30.

**The precedent for the right answer is already in this codebase, one axis
over.** A-046 asked the identical question about a chair and answered it
properly: `room.ts:116` is
`.filter((resource) => resource.active || resource.holds.length > 0)`, and the
confirm dialog says out loud *"they keep the chair until they are done, and
nothing new is seated here."* A retired chair keeps rendering until its last
hold ends. A retired stylist does not.

**Money/trust:** on my own book this is the single most expensive thing here.
A senior stylist leaving with six weeks of forward bookings is four figures of
work that the salon cannot see, cannot reassign, cannot ring about, and cannot
close out — and every one of those clients arrives to a receptionist who has no
row for her. That is not a bad afternoon; that is the salon's reputation on the
high street.

**Proposed row — A-098 (M).**

> **A stylist off the roster takes her whole forward book with her.** A-041
> shows the list once, behind "Deactivate anyway", and nothing ever shows it
> again: `day-view.ts:144` filters the column out (so the grid AND the printed
> sheet lose her clients), `conflictsForDay` derives nothing because
> deactivation writes no absence and moves no hours, `unfinished.ts:94` and
> `opened.ts:217` both drop her rows — while the appointments stay `booked`,
> keep their chairs, and keep getting a 24h reminder the client can act on. On
> the demo book: **106 appointments worth $2,870, 106 chairs still held, seven
> of them on tomorrow's grid, and `/staff/conflicts` says 0 stranded.** The
> answer already exists on the resource axis — `room.ts:116` renders a retired
> chair until its last hold ends and says so in words — and the same shape is
> right here: **a provider with live holds keeps her column, marked "off the
> roster", until her last appointment is done**, and deactivation joins the
> AVAIL-05 family so her clients are DERIVABLE as stranded rather than merely
> listed once. The regression test asserts the SAME rows through all four
> readers with only `active` flipped; a test that only checks the grid passes
> against three quarters of the bug. **Do not solve it by refusing the
> deactivation** — D-2's rule is that recording "she has gone" must always
> succeed — and do not cancel anything automatically.

Depends on: — . After A-097.

**Confidence: high.** Reproduced end to end against the seeded book, both
directions, on four independent readers plus the reminder job.

## 2. An absence longer than one day makes `/staff/conflicts` lie on every day of the year — M

Dana is off all week with flu. The desk writes one `TimeOff` row and gets back
the sentence A-041 built and one link.

Five clients, one each on five different days, one week of time off:

```
Dana off 2026-09-09 .. 2026-09-15.
the desk is told: "5 appointments now stranded"  ->  /staff/conflicts?day=2026-09-09

  /staff/conflicts?day=2026-09-09  ->  5 rows: "09:00 · Mrs Kerr" "09:00 · Ada Chen" "09:00 · Ellie Dunn" "09:00 · Sam Okafor" "09:00 · Tom Byrne"
  /staff/conflicts?day=2026-09-11  ->  5 rows: (identical)
  /staff/conflicts?day=2026-09-15  ->  5 rows: (identical)
  /staff/conflicts?day=2027-03-15  ->  5 rows: (identical)
  a year later, all five COMPLETED: /staff/conflicts?day=2027-03-15 -> 5 rows (completed,…)
```

**`?day=` does nothing on the absence axis.** `conflictsForDay`
(`impact.ts:361`) loads every `TimeOff` and `AdHocBlock` row the provider has
ever had, with no date predicate of any kind, and calls `appointmentsInRange`
over each absence's own span. A week-long absence therefore returns the whole
week, on whatever day you asked about.

**And the rows do not say which day they are.** `impact-actions.ts:192` sets
`when: label.time` — bare time — under a comment at `:58` that states the
premise explicitly:

```
listConflicts above is scoped to one already-known day, so shape()'s `when` is
bare time; this spans months, so the day has to be in the label or a Tuesday
and a Thursday both read "14:15".
```

A-041 wrote that comment while fixing the *other* caller, and it is exactly
right about the risk and exactly wrong about which function has it. Five
clients on five days all read "09:00".

**What that does on the morning it matters.** The desk works down a list where
every row looks like every other row, so it cannot tell what it has finished,
re-rings people it already sorted, and selects rows for the bulk "reassign to
Priya where qualified" believing they are today's — moving four other days'
clients to a different stylist in one click. The one thing the screen must be
able to say — *which of these have I dealt with* — it cannot say at all. Then
the week passes, the appointments complete, and the rows are **still there on
every day forever**, because a completed appointment is in `ACTIVE_STATUSES`
(D-7, correctly) and nothing ages the absence out.

That is how a screen stops being read. The desk writes the flu week on a Post-it
and the conflicts screen becomes the tab nobody clicks.

**Money/trust:** small in dollars, large in adoption. This is the screen the
whole AVAIL-05 story rests on and the one the operator brief calls the
highest-stress event in the business. A wrong list here is worse than no list,
because it is trusted for exactly one Saturday.

**Proposed row — A-099 (M).**

> **`/staff/conflicts?day=` ignores its own day, and its rows do not say which
> day they are.** `conflictsForDay` (`impact.ts:361`) reads EVERY absence the
> provider has ever had with no date predicate and reports everything each one
> overlaps, so one week of flu puts all five days' clients on every day of the
> year — proved: identical five rows on `?day=2026-09-09`, `?day=2026-09-15`
> and `?day=2027-03-15`, and still there a year later with all five
> `completed`. `impact-actions.ts:192` labels each row with bare TIME under a
> comment at `:58` claiming the list "is scoped to one already-known day",
> which is the premise the function does not hold: five clients on five days
> all read "09:00". Three changes and they are one idea — **clip the absence to
> the day being asked about**, **put the day on the row whenever the set spans
> more than one**, and **give the screen a date box and prev/next** so a
> multi-day absence is walkable instead of needing five hand-typed URLs (the
> absence action can only ever link to the earliest day, `impact-actions.ts:52`).
> The fixture is the item: **every existing conflicts test writes a SAME-DAY
> absence**, which is the one shape where the bug is invisible. Assert the row
> count on a day the absence covers AND on a day it does not.

Depends on: A-098 (it touches the same derivation).

**Confidence: high.** Reproduced with a transcript; the code's own comment
states the false premise.

## 3. The knowingly double-booked hour draws one client on top of the other — M

D-8 is the decision this product's staff-side credibility rests on, and its
last clause is a promise about a screen: *"an override booking writes
`blockedStart = blockedEnd` plus `overriddenFromRange` for display, so the
constraint never lies and **the day view renders the true collision**."*

It does not. Two clients, same stylist, same instant, the second booked through
BOOK-05 with a typed reason — what the grid positions each chip from:

```
Dana's column on /staff/day?day=2026-09-09
  top=60min  height=55min   Mrs Kerr   override=false
  top=60min  height=55min   Ada Chen   override=true
```

Identical box. And the horizontal extent is not per-item: `CHIP_SHELL`
(`appointment-chip.tsx:89`) is `absolute inset-x-1` for every chip in the
product, and `GridItem` (`view-model.ts:23`) carries only `top` and `minutes` —
there is no lane, no offset and no width anywhere in the day surfaces. The
later chip in DOM order paints over the earlier one, opaque, `overflow-hidden`.

**So the client who was already in the book is the one that disappears**, and
the chip left visible is the one wearing the override marker — which reads as
one deliberately-overridden booking rather than as two people at ten o'clock.
The desk that typed the reason five minutes ago can see it. The stylist reading
her column at nine cannot.

The same geometry swallows A-069's whole point: a released no-show keeps her
booked extent on the chip, so the walk-in sold into her freed tail draws over
her. A-069's own left-behind says exactly this and calls it legible; it is not,
because there is no lane.

**A-093 fixed this on paper and only on paper.** The printed sheet now carries
the override marker and the typed reason precisely because *"a list cannot say
'at once'"* — and the finding that produced it was that the sheet's SORT put a
09:30 override above the 09:00 colour it overlaps. The grid says it with
position, and the position is wrong in a way a table's sort is not: a wrong
sort is visible, a chip drawn underneath another one is not there at all.

**Money/trust:** the override is what the desk reaches for on the Saturday it
has to. If the grid hides one of the two people it just committed to, the desk
stops trusting the grid to be the whole day, and the whole day is what a day
grid is for.

**Proposed row — A-100 (M).**

> **Two clients in one stylist's hour draw as one chip.** D-8 promises the day
> view renders the true collision and it renders one of them: proved on a
> BOOK-05 override booked at the same instant as its host —
> `top=60 height=55` for both, and `CHIP_SHELL` (`appointment-chip.tsx:89`) is
> `absolute inset-x-1` for every chip with no per-item horizontal offset
> anywhere, so the later `<li>` paints over the earlier one, opaque. The client
> ALREADY in the book is the one that vanishes, and the surviving chip wears
> the override marker, so the collision reads as a single overridden booking.
> The same geometry hides the walk-in sold into a released no-show's tail
> (A-069's own left-behind, which calls it legible). **Lanes for overlapping
> appointment chips only** — split the column into N tracks over each
> overlapping cluster, narrower chips, both names readable — never for gaps
> (A-030 gives those `z-10` deliberately) and never for the room strip, which
> stays on the do-not-build list. The accessible name is already right; this is
> geometry. The fixture is a column with an override on top of its host AND a
> released no-show with a walk-in in its tail, because those are the only two
> ways this state is reachable and **no fixture in the suite has ever created
> either** — which is why A-090's alignment work measured chrome and never
> collision.

Depends on: A-090.

**Confidence: high on the geometry** (proved by running the loader and reading
the one CSS constant); **medium on the priority**, because how often a salon
knowingly double-books is a matter for the owner and I am reasoning from my
own book, where it is a few times a month.

## 4. The perishable-supply screen cannot see the biggest source of perishable supply — S

`/staff/opened` is the right screen and A-067 made it derive from four sources.
It still cannot see the one that happens most: **a no-show whose time nobody has
given back.**

```
booked Colour, 120 min, 09:00–11:00
marked no-show at 09:20.  releasedAt = null,  blockedEnd = 11:20
minutes of the salon's day still blocked by somebody who is not coming: 120
/staff/opened rows: 0
```

That is correct by construction and it is the gap: `listOpenedSlots` reads
`SLOT_FREEING_STATUSES` and the event log, and an unreleased `no_show` frees
nothing (D-7, right) and writes no `time_released` event. So the two hours only
become visible to the screen that sells them **after** a human has already
found them and pressed the button.

**And the button is on one screen while the no-show is marked on three.**
`ON_THE_CHIP` (`view-model.ts:517`) includes `no_show`, and
`provider-day.tsx:70` renders the whole move set — so the stylist's own list
marks a no-show in one tap, and `ReleasePanel` lives only on
`/staff/appointments/[id]`. Mark it from the list and nothing anywhere ever
mentions those two hours again.

D-44 is right that releasing must never be automatic — she may be eight minutes
away in traffic. That is an argument against a timer, not against a list.

**Money/trust:** this is the product's stated purpose. Two hours of a Saturday
colour at my rates is $180–260, and the leak is one missed prompt wide. A
salon takes three or four no-shows a week; the ones marked from the stylist's
own screen are pure loss today.

**Proposed row — A-101 (S).**

> **A no-show's dead time is invisible until somebody has already found it.**
> Proved: a 120-minute colour marked `no_show` at 09:20 leaves `blockedEnd`
> untouched at 11:20 (correct, D-7) and `/staff/opened` at **0** — the list
> reads `SLOT_FREEING_STATUSES` and the event log, and an unreleased no-show
> writes neither. The release is A-069's one-tap `ReleasePanel` and it exists
> on `/staff/appointments/[id]` alone, while `ON_THE_CHIP`
> (`view-model.ts:517`) puts `no_show` on the stylist's own list
> (`provider-day.tsx:70`), which marks it without ever passing the panel. Two
> halves, both small: **surface today's unreleased no-shows on `/staff/opened`
> as their own kind** — "45 min still blocked, nobody came — give it back?" —
> with the same one-tap action, and **offer the release wherever a no-show is
> marked**. Bounded to today and the future by the same three bounds A-043
> established; a no-show from last Tuesday is not supply. Still never automatic
> (D-44 unchanged), and it must not touch `blockedEnd` until a person presses
> it. `releasedAt` stays the only mechanism.

Depends on: A-069, A-067.

**Confidence: high.** Reproduced; the two code paths are three greps wide.

## 5. The walk-in nobody is free for is a dead end, and it is the walk-in worth the most — S

`booking-panel.tsx:550`, the whole of the walk-in refusal:

> *"Nobody is free for that today. Book a time from the day view instead."*

Two things are missing and they are the two answers a front desk actually gives.

**"We could squeeze you in."** BOOK-05 exists for this and A-042 built the door
— but only on the time axis: a per-column *Book with Dana* link, a typed time,
a refusal, then the override box. The walk-in panel has no override path at
all, which A-042 recorded as its own left-behind and nothing has closed. So the
answer the salon gives out loud on a Saturday takes two screens and a hand-typed
time, with the client standing at the counter.

**"The soonest we can do you is 9:30 tomorrow."** `walkInOptions`
(`walk-in.ts:37`) takes a single `day` and asks each qualified stylist for her
earliest slot on it. When the salon is full today it returns `[]`, and the panel
turns a client who is physically in the building into "book a time from the day
view instead" — which is a sentence about a screen, said to somebody who came
in for a haircut.

**Money/trust:** a walk-in the software cannot book is the first thing that goes
on paper, and the walk-in that goes on paper is the one the reports never see.
The conversion is real: on my own desk, "not today, but I can do you at half
nine tomorrow" turns roughly half of them into a booking.

**Proposed row — A-102 (S).**

> **The walk-in panel dead-ends when nobody is free today.**
> `booking-panel.tsx:550` says *"Nobody is free for that today. Book a time
> from the day view instead."* and offers nothing else, because
> `walkInOptions` (`walk-in.ts:37`) asks one day and returns `[]`. Two answers,
> both of which the desk gives out loud: **the next day anybody can take her**
> (walk forward with the same per-provider `computeDaySlots` the function
> already calls, capped at a handful of days, staff audience so D-21/D-25 do
> not apply), and **BOOK-05's override on this axis** — "who would you like to
> squeeze her in with, and why" — which A-042 built on the TIME axis and
> explicitly left unbuilt here because the walk-in's choice is *which stylist*
> rather than *which time*. Reuse `staff-actions.ts`'s existing override
> plumbing; add no second write path. The refused option must name the person
> and the reason in the salon's words (`scheduling-words.ts`), and the override
> must carry a typed reason exactly as every other one does, or the marker
> D-8 rests on gets cheaper again.

Depends on: A-042.

**Confidence: high on the facts, medium on the size** — the "next day" half is
an S, the override half may reach an M once the two-axis UI is drawn.

## 6. The three small ones already known, and what to do with each — XS/S

None of these is worth a session of its own; all three want a caller.

- **`/staff/dashboard/overruled` has no e2e spec at all.** It is the only
  surface that keeps A-060's escape hatch honest — an exception nobody can see
  the size of stops being an exception — and it renders an empty list without
  `from`/`to`, so a scan of it would pass for the wrong reason. It needs a
  fixture with a genuinely overruled cancellation, which A-095's seed can now
  produce. **Ride it along with A-099**, which is opening the same conflict
  machinery.
- **`sameTimeWithSomebodyElse` asks the room's question anonymously.**
  `public-actions.ts:258` calls `anyProviderAt` with no `holderKey` at a point
  where `confirmAppointment` has resolved the client five lines above. Strict
  direction, so it can only under-offer — but it is A-083's shape on the public
  flow, and A-083's lesson is that the caller to grep for is the one that HAS
  the answer. One argument. **Ride it along with anything that opens
  `public-actions.ts`.**
- **`/staff/design` returns 50 axe `incomplete` results in both schemes.**
  Gallery-only, on a page that renders one primitive many times, and
  `incomplete` is not `violation`. Leave it. Revisit only if one of those
  shapes reaches a real staff route.

## 7. Tested and CLEAN — recorded because a measured "no" is worth the same as a measured "yes"

- **The forward-facing half of deactivation is right.** `qualification.ts:59`
  filters `provider: { active: true }`, so a departed stylist is correctly
  never offered for a new booking, never on the walk-in list, never on
  "anyone", and `computeDaySlots` returns `windowInstants: []` for her. Finding
  1 is entirely about the book she already has, not about the book she might
  get.
- **`conflictsForDay` does NOT filter on `active`.** It loops over every
  provider row. That is what makes finding 1's fix cheap: if deactivation
  produced something the absence derivation can see, her stranded clients would
  reach `/staff/conflicts` with the phone numbers and the four AVAIL-05 actions
  already built.
- **The chair follows a deactivated provider's appointments unchanged** — 106
  holds on 106 rows, still enforced by both exclusion constraints. The room is
  telling the truth about a stylist the screens have forgotten, which is the
  right way round and is why nothing double-books.
- **The room/holder agreement is still clean on a real book.** Not re-run here;
  checkpoint 7 measured 201 offers booked with 0 refused, and 1,288
  anonymous-vs-holder comparisons of which 3 widened and 0 narrowed. A-095 has
  since made the room genuinely bind (0 → 39 `no-resource-free` on the sweep),
  so this is worth one fuzz round at checkpoint 8 rather than an item.

## What Phase 10 left behind that is load-bearing

- **Every staff page costs about 570 ms**, uniformly, because the shell asks
  `listOpenedSlots` — a per-candidate derivation over a fortnight — on every
  render. A-085 named the ceiling and the upgrade path (a cached count still
  derived from `listOpenedSlots`, never a cheaper predicate). Not a finding
  yet; it becomes one the first time a desk says the tablet is slow, and the
  measurement to take then is the badge query alone.
- **`ON_THE_CHIP` is a fourth hand-typed status list** (`view-model.ts:517`),
  correctly left out of A-086's `CONSUMED_STATUSES` because it answers a
  different question. It still wants a name and a home in the status module;
  ride it along with A-100, which is in that file anyway.
- **`/staff/unfinished` is oldest-first**, so the six-o'clock errand is at the
  bottom of the list. Recorded at checkpoint 7 and still true. It is a product
  call, not a defect: clearing a backlog oldest-first is defensible. Worth one
  line of thought whenever that file is next open.
- **Waitlist entries never expire.** A-023 said so and nobody has asked. With
  A-095 seeding three of them the screen is finally demonstrable; revisit when
  a real book grows a stale one.
- **A-053 stays blocked.** All five findings were scoped so they need no real
  notification channel — but finding 1 is the first one where the missing
  channel makes the harm WORSE rather than merely unmeasurable: the reminder
  that goes out for a departed stylist's appointment is the thing that puts the
  client on the doorstep. The Resend/Twilio account remains the owner's most
  valuable non-engineering action.

## What NOT to build

- **Do not refuse a deactivation with a full book, and do not cancel anything
  automatically.** D-2's rule is that recording "she has gone" must always
  succeed, and a bulk cancel of thirty clients on a boolean toggle is the
  silent change AVAIL-05 forbids. Finding 1 wants the column kept and the
  clients derivable, not a gate.
- **Do not lane-split the room strip.** Unchanged from the Phase 6 do-not-build
  list. Finding 3 is about the provider column only.
- **Do not add a revenue tile or a "what your no-shows cost" number.** It is
  one join and it leads nowhere: deposits are a stated non-goal, so the number
  changes no decision the owner can act on. The counts and the twelve-month
  client flags already are the lever.
- **Do not build a week or month grid** to solve finding 2. The fix is a date
  box and prev/next on the conflicts screen, which is the shape A-039 already
  established for the day and A-073/A-081 for the reports. A second answer to
  "what does Dana have on" can disagree with the first.
- **Do not build a self-serve waitlist yet.** Unchanged from the Phase 9
  review, and the probe that would change the answer is still the one in §5 of
  that document.
- **Do not re-open D-7, D-8, D-30, D-44, D-45, D-46, D-47, D-48, D-49 or D-50.**
- **Everything on the Phase 6, 7, 8 and 9 do-not-build lists stands unchanged** —
  no auto-completion on a timer, no client-axis conflict check, no `no_show`
  freeing its own slot, no third role, no series rule editor, no multi-provider
  chains, no second reminder touch, no call-down re-ranking, no close-the-day
  report for the owner.

## The process note

Phase 10's own rule — *a check that only ever runs one way is the default shape
of the assertion, and patching the rooms that noticed leaves the door open* —
fired correctly and was applied at the helper (A-096). The one this phase adds
is its sibling on the FIXTURE rather than on the assertion:

> **A PERIOD MODELLED AS A STATE HAS NO FIXTURE THAT CAN SEE IT.** Findings 1
> and 2 are one shape: an absence is a range, and neither of the two ways this
> product records one is scoped to the range it covers. `Provider.active` has
> no range at all, so nothing derived from ranges can see it. `TimeOff` has one
> and the screen that resolves it never reads it. **Every conflicts fixture in
> the suite writes a SAME-DAY absence, which is the single shape where the two
> agree** — exactly as A-097's fixture rule ("make the day where only one
> person can take the instant") and A-084's ("the gap between her bodies and
> the gap between her envelopes have to be DIFFERENT spans"). The general form
> is now three-for-three: *when two things agree in the simple fixture, the
> test is written in the shape where they cannot disagree.*

And its cheaper companion, which is what actually found finding 1: **when a
boolean turns something off, ask what it turns off that nobody meant to.**
`active` was written to stop new bookings, and it also quietly answers "does
this person appear on the day grid", "is she in the conflict derivation", "can
her visits be closed out" and "does her freed time reach the sell-it screen" —
four questions nobody asked it, in four files, each one line long.
