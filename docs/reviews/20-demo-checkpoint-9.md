# Demo checkpoint 9 — the walk on the book Phase 11 taught to keep a leaver

**Walked 2026-09-09, at the Phase 11 close — the first walk since A-098 made a
stylist who has left keep her column, A-099 gave the day view lanes, A-101 put a
forward number beside the frozen one, and A-105 taught the public rescue to ask
the room about the client by name.**
**Result: three defects. The first is a control the product hides from the one
column it went to great lengths to keep drawing.**

Checkpoints 1–8 each found a defect sitting inside an item already marked ✅ and
invisible from within the item that introduced it. Checkpoint 8 found three
screens answering a question nobody asked. This one is the first walk where a
whole Phase 11 item could be **exercised by flipping one boolean and diffing
every screen in the salon** — so that is what it did, and the finding is not
that A-098 failed. A-098 is the best item in the phase and it holds on twelve of
the thirteen surfaces measured. The finding is on the thirteenth: **the same
boolean that stopped meaning "does she render" went on meaning "may the desk act
on her", and nobody separated those two.**

The walk was scripted against a production build on the seeded density book, in
a separate database (`bookable_dev`) so the operator review could read
`bookable_test` at the same time. The scripts have been deleted; what they found
lives on as three findings and the measurements below.

---

## The book it was walked on

`db:seed:dev` — `seedSetup` then `seedDensity`, the demo install, on a freshly
dropped, recreated and migrated schema:

```
4 providers   8 services   8 service segments   13 clients   4 chairs
718 appointments   booked 477  completed 172  checked_in 62
                   no_show 4  cancelled_late 2  cancelled 1
3 on the waitlist   2 call marks   2 call-down attempts   1 time off   11 date overrides
710 chair holds    735 worked blocks    718 service lines    713 outbox rows

book spans 2025-09-10 … 2026-11-01 over 29 days with appointments on them
future book: 2026-09-09 … 2026-09-18, EIGHT working days, four columns on every one
```

**Today is Wednesday 9 September and the salon is open** — checkpoint 8's "today"
was a shut Monday, which is what made its Scene 1 possible. This walk had a
working today, which is what made *this* one's Scene 1 possible.

**The seed alone: 17 s**, against checkpoint 8's 16.8 s on 640 appointments. The
120 s hook budget stands and needs no change.

**Phase 11 is visible on the demo install, with one exception.** A-098's
off-roster column, A-101's forward number, A-102's release rows and A-104's
honest empty states are all reachable from the seeded book. **A-099's lanes are
not**: the seed contains **zero overlapping same-provider pairs** —

```sql
select count(*) from "Appointment" a join "Appointment" b
  on a."providerId" = b."providerId" and a.id < b.id
 where a.status in ('booked','checked_in','completed','no_show')
   and b.status in (...)
   and a."startAt" < b."endAt" and b."startAt" < a."endAt";
 → 0
```

— so the one Phase 11 item that is purely a rendering promise is the one the
demo cannot demonstrate. That is checkpoint 7's waitlist complaint again, one
feature over, and it is a backlog row rather than a defect. The lane code itself
is right and is single-sourced: `lanes.ts` is used by `view-model.ts:515`, the
room strip (`room-strip.tsx:125`), the grid (`day-grid.tsx:236`) **and by the
design gallery's fixture** (`day-fixtures.ts:79-83`, which builds through
`withLanes` rather than typing lane numbers into a fixture) — the mistake that
would have made the gallery lie about the grid.

---

## The crawl

Twenty-six staff routes at 1024×768, **each one in both colour schemes** —
A-096's loop:

```
52 route×scheme pairs:  52 × HTTP 200
                        0 axe violations, in either scheme, on any of them
                        0 console errors, 0 page errors
                        0 bounced to /staff/login
```

Every line of that table printed **the URL actually landed on**, the `<h1>` and
the body character count, because checkpoint 8's rule is that a green run over
the wrong page looks exactly like a green run. Six routes came back under 700
characters and each was re-fetched with `waitUntil: 'networkidle'` to prove the
number was the page and not a streamed shell; all six were identical settled and
unsettled. `/staff/clients` really is 231 characters — it is a search box.

Two `incomplete` counts, neither a violation: `/staff/design` returns **4** and
`/staff/day` returns **2** under the WCAG 2.0/2.1 A+AA tag set. (Checkpoint 8's
53 and 32 were counted over axe's full rule set, not this one — the two numbers
are not comparable and neither is a regression.)

### What the crawl cost to get right, and it is A-096's rule with a number on it

The first pass of this crawl was written the obvious way — flip
`emulateMedia({ colorScheme })`, scan — and reported violations in dark that the
suite has never seen. They are not real. Isolated deterministically:

```
                          UNFROZEN                 FROZEN (A-096's helper)
/staff/design   dark      color-contrast × 18      0 violations
/staff/day      dark      color-contrast × 15      0 violations
/staff/design   light     0                        0
/staff/day      light     0                        0
```

**Thirty-three phantom colour-contrast nodes, dark only, both times.** axe
samples the palette mid-transition after the scheme flips, exactly as
`axe.ts:71`'s comment says, and `FREEZE` is what makes the measurement the
settled palette rather than whichever frame the flip landed on. A-096 shut this
door inside the suite with `no-restricted-imports` on `@axe-core/playwright` in
`e2e/**/*.spec.ts`; this walk is outside the suite, which is precisely how it
walked into it. **Worth recording because the failure is asymmetric:** the
unfrozen scan is loud and wrong in dark, so it would have been diagnosed. The
one that would not have been diagnosed is the mirror — a freeze that silently
made something pass — and this measurement is the evidence that the helper is
doing work rather than being ceremony.

---

## Scene 1 — Tess left on Monday, she is in the building until the 18th, and the desk cannot tell the screen she is running late

*The walk's method here was mechanical: snapshot the rendered text of thirteen
staff routes and four public ones, flip `Provider.active = false` for one
stylist, snapshot again, diff. Everything A-098 promised holds. One thing
nobody promised or refused broke.*

Tess is taken off the roster on Wednesday. She has

```
123 future appointments, over EIGHT working days, 2026-09-09 … 2026-09-18
```

still in the book, which is the entire premise of A-098: she is not gone, she is
**working her notice**, and `room.ts:116`'s rule — *"they keep the chair until
they are done, and nothing new is seated here"* — was extended to her.

**What the diff proves A-098 got right**, on a book rather than in a test:

```
                                          before  →  after
public "/"          "4 stylists"          4 stylists → 3 stylists, her card gone
public /stylists    her BOOKS FOR block   present    → gone
/staff/availability her name              present    → gone      (she is not a target)
/staff/waitlist     her checkbox          present    → gone      (a link the write cannot honour)
/staff/day          her COLUMN            present    → present, marked "off the roster — still booked"
/staff/day          "Book with Tess"      present    → gone
/staff/unfinished   her past visits       present    → present   (closeable, D-46's harm averted)
/staff/opened       her freed spans       present    → present   (sellable)
/staff/conflicts    stranded clients      0 on every day → 16 / 27 / 27 / 7 mentions on
                                                          10th / 11th / 12th / 15th
```

`/staff/conflicts` going from *"Nothing stranded on Thursday 10 September"* to
a worked list with phone numbers, **Keep / Cancel / Find another time** per row
and a bulk *"Move N where qualified"*, is the single largest behavioural
improvement in Phase 11 and it is exactly what A-098's row asked for.

**And then the thing nobody looked at.** `day-grid.tsx:159`:

```tsx
{/* Neither control means anything for somebody who is not in the
    building: she is not running late, and pushing her column moves
    appointments nobody is doing. */}
{column.closed || column.offRoster ? null : (
  <ColumnControls … runningLateMinutes={…} pushFrom={…} />
)}
```

**That comment is falsified by the comment twelve lines above it**, which reads
*"SHE IS HERE BECAUSE HER CLIENTS ARE"*. On this book she is in the building for
another eight working days with 123 people booked in. Her column is drawn for
exactly that reason. The two controls the desk uses to keep a real day honest —
**"Behind by [ ] Set"** and **"Push the column"** — are removed from it.

Three things make this more than a hidden button:

**The write path accepts both.** Neither `running-late.ts` nor `push-column.ts`
contains an `active` check anywhere. Run directly against the off-roster
provider:

```
setRunningLate(… Tess, day 2026-09-10, 25 min)
  → ACCEPTED  {"minutes":25,"setByActor":"staff", …}
previewPush(… Tess, day 2026-09-10, +20 from her first appointment)
  → ACCEPTED  canPush computed, runningLateMinutes 25 → after 25
```

This is the **offered-then-refused class inverted**, and CLAUDE.md already names
the direction: *"A reader stricter than the constraint does not fail safe; it
refuses work the salon needs."* Every previous instance of this shape in the
repo has been the read model offering what the write refuses. This one is a read
model refusing what the write accepts, on the busiest, most chaotic week a
stylist's book ever has.

**The whole downstream chain works for her.** With the delta stored, her column
renders it:

```
/staff/day?day=2026-09-10
  Tess  off the roster — still booked
    09:00  Sam Okafor    Treatment · +15125550103   → likely 09:25
    09:30  Alice Hall    Treatment · +15125550101   → likely 09:55
```

The projections are correct, D-43's `deltaAfterPush` is intact, the print sheet
reads `column.runningLateMinutes` the same way it always did. **The only thing
missing is the door.** `ColumnControls` at `day-grid.tsx:161` is the sole
inbound reference in the repo — grepped — so there is no second way in.

**Which means a delta can be stranded.** Mark Tess 25 behind at ten o'clock,
take her off the roster at half past — a plausible Wednesday — and the +25 is
now on her column with no control to clear it. Every projected chip in her
column is wrong for the rest of the day and the desk cannot do anything about
it from any screen.

**Why no test could see it.** `off-roster.spec.ts` asserts the column renders and
that "Book with Tess" is gone; it asserts the presence of the marker, not the
absence of a control that was never in its fixture's mind. The unit suite has no
notion of a screen. And the seeded book has no stylist off the roster at all,
so nothing in the demo install has ever rendered this column — the whole scene
requires the boolean flip that this walk performed and no fixture performs.

**The fix is a distinction, not a boolean.** `offRoster` currently answers
"may I seat somebody new here?" and is being read as "is she in the building?".
Those are the same question only on the day her last appointment ends.

---

## Scene 2 — the desk taps "She came" for Tom Byrne, thirty-three times on one screen

*Found by reading the rendered text rather than the code, which is the only way
this one is visible: every string is grammatical and every test passes.*

`/staff/unfinished` is the screen the desk works at close of business. It says
what it is for in one line — *"These have been and gone and nobody said what
happened. Two taps each, and the week's numbers are right again."* On this book:

```
124 appointments · $3540.00 of work the week's figures cannot see
```

and under every one of them, two buttons (`close-out-buttons.tsx:32`, `:44`):

```
    She came        She didn't
```

The seeded client list is thirteen people and **two of them are men**:

```
Alice Hall   Bea Lindqvist   Corinne Adeyemi   Ellie Dunn   Harriet Vance
Jenny Moore  Joyce Tabora    Marcy Dunn        Nadia Rahman Nell Fairweather
Rae Whitfield             →  Sam Okafor        Tom Byrne  ←
```

They are not scenery. Tom Byrne and Sam Okafor hold **171 of the 718
appointments (23.8%)**, and of the 127 rows on `/staff/unfinished` right now,
**33 are theirs — 26%**. The screen renders

```
248 occurrences of "she"/"her"  on /staff/unfinished alone
```

and a quarter of them are about a man. It is not a bug in `unfinished`. It is
the product's default voice, and it is on the verbs:

| where | what it says |
|---|---|
| `unfinished/close-out-buttons.tsx:32,44` | **She came** / **She didn't** |
| `appointments/[id]/status-controls.tsx:125` | She gave us proper notice, or this one's on us — don't count it late |
| `appointments/[id]/status-controls.tsx:177` | Her remaining time went back on the market at … |
| `appointments/[id]/status-controls.tsx:240` | She's here after all — put her time back on the book |
| `appointments/[id]/who-was-this.tsx:85` | This wasn't her — take it off the record |
| `appointments/[id]/visit-panel.tsx:136` | Change what she is having |
| `appointments/[id]/page.tsx:317`, `:394` | What she is having · Was she told? |
| `appointments/[id]/move-panel.tsx:108` | Pick a day to see her free times. |
| `appointments/[id]/end-series-panel.tsx:37,82,88` | The ones she has already had … · do not count it against her · I have already rung her |
| `clients/[id]/page.tsx:96,97,120` | **She cannot book online — the desk can.** · Booking her from here still works. · she comes about every N days |
| `opened/page.tsx:78` | A no-show keeps her time on the book … she may be eight minutes away |
| `settings/settings-form.tsx:98` | … a client can book a slot she is already unable to cancel |

**The reliability line is the one that matters most.** *"She cannot book online
— the desk can"* is read down the phone, to the person it is about, and it is
the sentence a desk repeats aloud. Getting it wrong in front of the client is a
different order of error from getting a button label wrong.

This is not a style preference and it is not the copy about *stylists* — Dana,
Priya and Tess are named women and "her working hours" is correct about them.
It is the copy about **clients**, whose gender the product does not store, does
not ask for, and has no business asserting. Every one of these is a
gender-neutral rewrite that is *shorter*: **"Came" / "Didn't come"**, "Put the
time back on the book", "This wasn't them", "Was the client told?".

**Why nothing catches it.** It compiles. Every one of the 305 e2e assertions and
1,590 unit tests passes. axe does not read English. The design gallery renders
the same strings and calls them correct. It is only visible from **the rendered
text of a real book with a real client list in it**, which is what a demo
checkpoint is, and it took eight of them to notice — because the first thing
anybody does on this screen is check the numbers.

---

## Scene 3 — the screen whose whole subject is perishable money puts the unsellable row at the top

*A-102 taught `/staff/opened` about released no-show time, which is the right
supply. Nothing taught it to stop listing supply after it has decayed past
anything the salon sells.*

```
/staff/opened

    What's opened up
    Recently freed — cancelled, shortened, moved or handed over — still in the
    future, and nobody has taken it yet.  Soonest to expire first.

    ► Wednesday 9 September at 10:54 · 10 min
      Blow-dry · Marcus
      Sam Okafor never came — the rest of the time was put back
      [Who wants this slot?]

      Wednesday 9 September at 12:00 · 55 min
      Cut · Tess
      Cancelled by Marcy Dunn
      [Who wants this slot?]  Already asked  Alice Hall — thinking about it
```

The first row is a released no-show and its span is **live** — it starts at
`now` (`opened.ts:376-377`, `freedMinutes = minutesBetween(start, span.end)`),
so it counts down as the afternoon passes. Following its own link nine minutes
later:

```
/staff/waitlist?providerId=…&serviceId=…&at=2026-09-09T16:03:03Z&minutes=2&…

    WHO WANTS THIS SLOT?
    Blow-dry with Marcus, Wednesday 9 September at 11:03.
    Nobody on the waitlist fits this one.
```

**`minutes=2`.** And the shortest thing this salon sells is a Fringe trim: 10
minutes of body plus a 5-minute after-buffer —

```sql
select min("durationMinutes" + "bufferBeforeMinutes" + "bufferAfterMinutes")
  from "Service" where active;   → 15
```

— so the row was already unsellable at **10 min**, before it decayed to 2. The
only guard anywhere is against zero (`opened.ts:226`, *"its `freedMinutes` of 0
matches nothing"*), so **every span from one minute upward is listed, with a
call-to-action, forever.**

Three things compound it, and the third is the one that makes it a defect rather
than noise:

- **The heading names the whole service.** *"Blow-dry with Marcus at 11:03"* — a
  30-minute service, offered in a 2-minute hole. The desk reads a service name
  and a time, not a duration.
- **`matchFreedSlot` is right and says so.** *"Nobody on the waitlist fits this
  one."* The matcher bounds correctly by footprint; the **listing** does not.
  One half of the loop knows and the other half is still selling.
- **"Soonest to expire first" sorts the dead row to the top.** A span that has
  decayed to two minutes is by construction the soonest to expire, so the
  ordering *guarantees* the row nobody can buy occupies the position the screen
  reserves for the most urgent thing. Confirmed empirically: the 2-minute row
  was link 1 of 2 on the page. The screen's own subject is money the salon would
  otherwise lose, and it opens on the one row that is already lost.

The fix is one predicate in the listing — drop a span shorter than the shortest
sellable footprint — and it is the same predicate `matchFreedSlot` already
applies one function over.

---

## What was checked and is clean

Recorded so the next checkpoint does not spend the pass.

- **A-101 holds, and `now` really is a parameter.** Four weeks through
  `dashboardSummary`: `2026-09-01` worked 25.2% / booked 60.5% `weekIsAhead=false`;
  the current week worked 12.9% / booked 63.8% `false`; `2026-09-16` worked 0 /
  booked 42.4% **`weekIsAhead=true`**; `2026-09-23` 0 / 0 `true`. `booked >=
  worked` on every row, both `null` never diverged, and checkpoint 8's
  four-zeroes card is gone.
- **A-098's report widening works.** Every provider with a row that week keeps a
  row, active or not (`dashboard.ts:105`).
- **A-104's empty states are honest on this book.** `/staff/conflicts?day=` with
  no strandings says *"Nothing stranded on Thursday 10 September"* — it names the
  day it was asked about.
- **A-100 holds on a real absence.** The seed's one `TimeOff` row produces
  conflicts on its own days and nowhere else; `?day=2027-03-15` is clean.
- **Chair holds and worked blocks reconcile**: 710 holds and 735 blocks against
  718 appointments — segmented services carry more than one block, cancelled
  ones carry no hold, which is what those two numbers should look like.
- **The lane helper is single-sourced** (`lanes.ts` → grid, room strip, gallery),
  so the design page cannot disagree with the day view about lanes.
- **`/staff/messages` blindness, independently confirmed.** The operator review
  found `listStuckNotifications`'s `attempts > 0` filter on `bookable_test`; the
  identical state exists on `bookable_dev` — **713 outbox rows, all `pending`,
  all never attempted, screen reads "Everything has gone out. Nothing is waiting
  and nothing has been given up on."** Two databases, same sentence. It belongs
  to the operator review (its finding 2) and is recorded here only as
  corroboration.

## Two smaller things, worth a line each

- **The waitlist day-part form offers Sunday and Monday**, the two days this
  salon is shut (`/staff/waitlist`, *"Which days (none checked = any)"*). A
  client waitlisted for Sundays only can never be matched. The checkbox list is
  the seven weekdays rather than the days the business opens.
- **`/staff/availability?provider=` loads every `TimeOff` and `AdHocBlock` that
  provider has ever had**, `orderBy: startAt asc` and no date predicate
  (`availability/page.tsx:32,35`). Not the A-100 defect — this list is *supposed*
  to be all of them — but it is the one query left with the shape, it grows
  without bound, and the oldest absence is at the top forever.

---

## The rule this checkpoint leaves behind

> **WIDENING WHO IS RENDERED IS NOT THE SAME EDIT AS WIDENING WHO CAN BE ACTED
> ON, AND THE SECOND HALF IS THE ONE WITH NO TEST.** A-098 did the hard half
> perfectly: it found six readers of `Provider.active` that were each using one
> boolean to answer a different question, and gave each its own. What it did not
> do is ask the same question of the **controls** on the surface it had just
> taught to keep drawing her. `day-grid.tsx:159` hides "Behind by" and "Push the
> column" for an off-roster column under a comment reasoning that *"she is not in
> the building"* — twelve lines below a comment stating that **she is here
> because her clients are**. Neither write path checks `active`; both accept.
> The projections her column already renders (`→ likely 09:25`) prove the whole
> chain works for her. So this is the **offered-then-refused class inverted** —
> a read model stricter than the write, refusing work the salon needs on the
> eight busiest days a departing stylist's book ever has — and it can strand a
> delta with no control able to clear it. **When an item makes something render
> that used to vanish, grep for the CONTROLS on that surface, not just the
> data**: a control is a reader too, its filter is usually the same boolean, and
> a screen that renders a row it will not let you touch fails no test, because
> the assertion everybody writes is that the row is there.

Its companion, from Scene 2: **a demo book is the only place the product's
voice is audible.** 305 e2e tests, 1,590 unit tests, forty axe runs and eight
prior walks all read `She came` and none of them read it *about Tom Byrne*. The
thing that made it visible was thirteen named clients and a screen with 124 rows
on it — which is an argument for the seed having people in it who are not all
the same, and it is the same argument A-095 won about waitlist entries.
