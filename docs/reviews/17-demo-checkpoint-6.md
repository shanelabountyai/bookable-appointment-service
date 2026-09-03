# Demo checkpoint 6 — the walk

**Walked 2026-09-02, at the Phase 9 boundary (A-081 closed the last built row
and the scoped backlog ran out for the tenth time).**
**Result: one defect, and it is the offered-then-refused class for the fourth
time — this time between the room's READ MODEL and the room's CHOOSER, which
have been asking two different questions since A-032.**

Checkpoints 1–5 each found a defect sitting inside an item already marked ✅
and invisible from within the item that introduced it. This one is a purer
version still: nothing in Phases 7–9 touched the code that is wrong. What
Phase 9 did was **make it visible** — A-081 lit up a book with 411 appointments
in it, and the defect needs a genuinely busy room to appear at all.

The walk was scripted rather than clicked, so what follows is transcript. The
scripts have been deleted; what they found lives on as one fix and sixteen
tests, three of them verified to FAIL against the code as it stood.

Scenes were chosen at the **seams between** items rather than down the middle
of any one, as before — and this time two of the four were chosen because
A-081 had just made them runnable for the first time.

---

## Scene 1 — the surfaces, on a full book

`npm run db:reset:test`, then every date-relative surface Phases 6–8 built,
read at `now`:

```
book: booked=280 completed=97 checked_in=27 no_show=4 cancelled=1 cancelled_late=2
unfinished (21d)  54 rows, statuses {checked_in, booked}
opened up          1 row  (a future cancellation, 75 minutes, Dana)
today's grid       4 columns, 23 appointments, 7 gaps
the room           4 chairs, holds on all four
```

A-081 did what it said. Twelve weeks ago every one of these rendered its empty
state on a fresh install; they now render a salon. **Every scene below is a
scene that could not have been walked on 2026-09-01.**

One thing worth recording rather than fixing: the seeded released no-show sits
in the *past* by construction (`density-seed.ts` picks today's last STARTED
row), so `/staff/opened` shows the cancellation and not the release. The seed's
own comment already says so and gives the reason — the cut range is what the
day grid needs, and the cancellation is what keeps the list non-empty either
way. Left alone.

## Scene 2 — the push, over the whole book

The Phase 9 opener (A-079) rebuilt the column push's model of the day. Walked
by fuzzing it rather than by reading it: every provider × every seeded day ×
four shifts (+20, −20, +45, −15) × two `fromAt` choices, taking each preview
and, wherever it said `canPush`, actually pushing.

```
previews 408   pushes 271   disagreements 0
```

Not one preview promised a push the transaction then refused, and not one
`canPush: true` moved zero rows. **A-079 holds.** That is the assertion its own
row was written for — the 500 in the middle of the running-late workflow — and
271 real pushes against a book it was never tested on is the strongest thing
the walk can say about it.

## Scene 3 — the release, end to end

A-069's cut, A-074's chair, A-075's push and A-078's error shapes all meet on
one appointment. Walked as one sequence on a real future booking:

```
subject   Priya, Root touch-up, 09:00-10:30, 90 minutes
no_show at 09:15, released at 09:15
  appointment blocked  08:55 .. 09:15      (was ..10:45)
  chair hold           08:55 .. 09:15   body 09:00 .. 09:15
  /staff/opened        90 minutes, freed by 'released'
  engine offers        09:30 09:45 10:00 10:15
  booking 09:30        OK
```

The envelope is cut, **the body is cut with it** (A-074's finding, holding),
the freed span reaches the sell-it screen, the engine offers it and the write
accepts it. **Walked and found clean.**

## Scene 4 — every time the salon offers, can it seat her?

The invariant, stated as a property: *a slot on the screen is a slot the write
path will accept.* Fuzzed against the seeded book — 400 random
provider × service × day draws, public audience, taking one offered slot at
random from each and booking it immediately, with nothing else running.

```
offered 169   booked 166   REFUSED 3
REFUSED an offered slot: 2026-09-11 Priya  Treatment 14:15 -> NoResourceFree
REFUSED an offered slot: 2026-09-08 Tess   Cut       16:00 -> NoResourceFree
REFUSED an offered slot: 2026-09-11 Priya  Cut       14:15 -> NoResourceFree
```

---

## The finding

**`NoResourceFree` on a time the public page had just offered, with nothing
else booking. Not a race — the same time, refused again, every time.**

The diagnostic dump for the first one:

```
wanted 14:15-14:40   (Treatment, 20 minutes + a 5-minute after-buffer)

 Chair 1                        ▓▓▓▓▓▓▓ 14:30-15:05
 Chair 2          ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 14:15-14:40
 Chair 3   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 14:05-16:35
 Chair 4  ▓▓▓▓▓▓▓▓▓▓▓▓                   13:45-14:20
 wanted           ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

 full spans over the envelope: []
```

Three chairs occupied at every instant of those twenty-five minutes, and never
four. So the room was never *full* — and there is no ONE chair free from 14:15
to 14:40, so `findFreeResource` returned `null` and the write refused.

**The two halves of the room have been asking different questions since A-032.**

| | question | lives in |
|---|---|---|
| the read model | are all four chairs occupied at some instant inside the envelope? | `fullSpans` / `findRoomFullIntervals` |
| the chooser | is there ONE chair free for the whole envelope? | `findFreeResource` |

The first is **necessary and not sufficient**. It is the answer you would get
if the room could be reshuffled — and in the transcript above it can be: move
Chair 4's 13:45 client onto Chair 1, which is empty until 14:30, and Chair 4
opens up. **A real client is in a physical chair and stays in it**, so the
count is measuring a room the salon does not have.

`resource-load.ts`'s own header claimed the opposite, in the file that was
wrong:

> *Until this module existed, the refusal arrived at SUBMIT, on a time the
> screen had just offered — the offered-then-refused defect this repo has
> already caught twice.*

It still arrived at SUBMIT. A-032 closed the case where the room genuinely
fills and left open the case where it merely fragments — and fragmentation is
what a salon's afternoon IS.

**Why nothing caught it.** Three reasons, and each one is a lesson rather than
an excuse:

- **It needs a busy room to exist.** Every fixture in the suite fills the room
  by *booking* into it, and first-fit assignment cannot reach this state:
  bookings that force each other onto separate chairs must pairwise overlap,
  and pairwise-overlapping intervals always share a common instant (Helly), at
  which the room IS full and the old model refuses correctly. **Something has
  to MOVE** — a reschedule, a shortened visit, a release — for the chairs to
  end up staggered. The regression fixture therefore books four and then moves
  one, which is what a Saturday does before lunch.
- **A-032's tests asked the read model, and A-063's asked the chooser.** Both
  were right about their own half. Nothing asked whether the two agreed —
  which is checkpoint 5's finding 3 exactly one axis over, and it is the reason
  the fix below makes them literally the same predicate.
- **The refusal had already been mistaken for a race.** `public-actions.ts`
  catches `NoResourceFree` and tells the customer *"that time has just gone,
  here are some others"* — a comment there records that before it was caught
  *"she saw a crash on a time the page had just offered her."* The crash was
  fixed; the cause was read as concurrency. It is not concurrent, and the
  wording is a lie the third time she picks the same slot.

**The harm, in the salon's terms.** A stylist standing idle, a chair standing
empty at every instant, and a customer told twice that a time on the screen is
unavailable. The slot never sells. On the seeded book it is **1.8% of offers**,
and it concentrates exactly where the money is: the fragmented middle of a busy
afternoon.

---

## The fix

**The room's read model now asks the chooser's question, in the chooser's own
words.**

- `fullSpans` and `findRoomFullIntervals` are **deleted**. A cardinality
  collapsed into intervals was the wrong shape, not a wrong constant.
- `canSeat(seating, envelope, body, holderKey)` replaces them, and mirrors
  `findFreeResource`'s two arms line for line — envelopes may overlap for ONE
  holder, bodies never overlap for anyone (A-063) — for the same reason A-063
  made those two arms mirror the two exclusion constraints.
- It **cannot** be a busy interval, and that is provable rather than a matter
  of taste: in the transcript above the infeasible starts are a fifteen-minute
  window while the envelope is twenty-five minutes long, so no interval the
  engine subtracts by overlap can name it. So it is a filter over candidate
  slots, and the `resource-full` busy kind is gone.
- **`computeSlotsIn` is now the only way to run the engine on a built query**,
  and it is the thing that applies the room. The five places that offer a time
  — the day list, the date picker, the reschedule options, A-055's
  change-services check and the booking re-check — all route through it. That
  was not optional: three of them read the `no-resource-free` exclusion reason
  to say *"she is free, the room is not"* and to reach RES-04's override, and a
  slot that merely vanished would have arrived as `SlotNotOffered` with no
  reasons at all.
- **The offer now knows who would be sitting in the chair.** A-063 lets one
  client's own overlapping envelopes share a chair, so the room's answer
  differs for a client already in it. The chooser has had that input since
  A-063; the offer did not ask, and could get away with it only while it was
  asking the weaker question. `holderKey` is threaded from reschedule,
  change-services and the booking re-check; `null` — the strict question — is
  the default and the right one for an anonymous visitor who has not said who
  she is yet. Without it, this fix would have been *stricter than the
  constraint*, which CLAUDE.md is explicit does not fail safe.

**Sixteen tests where there were thirteen.** Ten unit on `canSeat` — the
staircase itself, the seven old `fullSpans` cases re-stated as seating
questions (checkpoint 5's shared chair among them), and A-063's two-arm pair:
she keeps the chair she is in even in a one-chair room, and two BODIES never
share one however the phone number reads. Six integration on a four-chair room
built by booking four and moving one. **Three of the six fail against the code
as it stood**, verified by stashing the fix and running them; the other three
are the guard against over-correcting — each of the four lands on its own
chair, the afternoon is still offered where the room can seat it, and the write
still agrees with the offer.

---

## The process note

**A READ MODEL THAT PREDICTS A CHOOSER'S ANSWER MUST ASK THE CHOOSER'S
QUESTION, NOT A WEAKER ONE THAT HAPPENS TO IMPLY IT.**

Checkpoint 5 found `fullSpans` counting the wrong *things* (holds, not chairs).
This one found it asking the wrong *question* — and the second is the harder
one to see, because a weaker question is right in every simple fixture and
wrong only where the room is interesting. "All chairs busy at once" implies "no
chair free start to finish"; the converse is what a salon lives in, and the
implication running one way is exactly what makes it survive a test suite.

The generalisation, for the next one: when two pieces of code answer the same
operational question and one of them is allowed to be an approximation, the
approximation has to be **conservative in the direction that is safe**, and
somebody has to say which direction that is out loud. Here the safe direction
was "refuse to offer", the code took "offer anyway", and no test could tell
because no test asked them the same question.

Added to CLAUDE.md beside the constraint-reader rule it generalises.
