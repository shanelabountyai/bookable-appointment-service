# Demo checkpoint 11 — the walk that looked at the grid instead of reading it

**Walked 2026-09-16, at the Phase 13 close. This is the first walk since A-114
made a client one person however she types her number, A-118 stopped
`/staff/messages` claiming delivery, and A-120 put the never-reminded list, a
long name and a flagged client on the demo install.**
**Result: one defect, in two halves, on the screen every other screen hangs
off. Phase 13 itself holds everywhere it was walked.**

Ten checkpoints have measured the day grid by what it SAYS: axe, text, the
accessible name, and since A-113 `scrollWidth` against `clientWidth`. Every one
of those reads an element on its own. None of them asks whether **two elements
are drawn in the same place**. This walk took a screenshot of today first and
read it with eyes before measuring anything, and the first thing on it was text
printed on top of text.

The walk ran against a production build on a **freshly created database,
`bookable_cp11`**. `bookable_cp10` was dropped first. `bookable_dev` and
`bookable_test` were not touched. The scripts lived in a scratch directory and
are deleted; what they found is transcribed below.

---

## The book it was walked on

`seedSetup` then `seedDensity` on an empty, freshly migrated schema:

```
[seed] 4 providers, 8 services, 719 appointments, 13 clients (spring-forward 10, fall-back 3;
       19 days around today, 124 left open; 3 on the waitlist, 2 call marks, 2 call-down
       attempts, 5 lapsed; 733 messages sent, 1 double-booked by override;
       19 reminders swept, 5 left by the skipped band)
```

**Today is Wednesday 16 September and the salon is open.** The seed ran at
10:48 CDT. The future book runs Wed 16 … Fri 25 September, eight working days,
245 appointment chips.

The seed log now reconciles: A-120 made `appointmentsCreated` count every
function that inserts, and the log says 719.

---

## The crawl

Forty-three routes at 1024×768, **each in both colour schemes**, with
transitions frozen. The staff routes include today, tomorrow, tomorrow's print
sheet, Dana's list and sheet, the booking panel, the override appointment, a
cancelled appointment, a late cancel, four client records (Alice Hall, Jordan
Fairweather-Okonkwo, Rae Núñez, Marcy Dunn), three client searches (`0101`,
`nunez`, `okonkwo`) and every other staff screen. The public routes are `/`,
`/services`, `/stylists`, `/visit` and `/book`.

```
86 route×scheme pairs:  86 × HTTP 200
                        0 axe violations, in either scheme, on any of them
                        0 console errors, 0 page errors
                        0 bounced to /staff/login — every row printed the URL it landed on, its <h1>
                          and its body length
gendered pronouns in the rendered text of 43 routes:  0
```

**Horizontal overflow** (`scrollWidth > clientWidth` under `overflow: hidden`
or `text-overflow: ellipsis`), leaving out the 1 px `sr-only` labels:

```
Jordan Fairweather-Okonkwo   157 in 144/145   ordinary chip, every day it appears     A-120: deliberate
Jordan Fairweather-Okonkwo   157 in 110 / 89  chips beside a DONE / NO-SHOW word       A-120: deliberate
Priya · Root touch-up        113 in 69        room strip, Chair 2, Thursday           narrow short chip
Tess · Treatment              89 in 69        room strip, Chair 2, Thursday           narrow short chip
```

A-120 moved the claim of legibility off the chip's name on purpose (the time
is `shrink-0`, and the whole name is in the accessible name, the stylist's
list and the sheet), so the first two rows are the product behaving as decided.
The room-strip pair is a short service drawn in a busy chair, and the chair and
client are the chip's first line; it is recorded, not scoped.

**The crawl was clean, and the defect below was on every day it covered.**

---

## Scene 1 — "5 min free" is printed across the time and the client's name

*Today, `/staff/day`, 1024×768. Dana's column, from the screenshot at 2×:*

```
┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
┆ 5 min free                 ┆      ← the gap's dashed box, 18 px tall
┆ 10:00 Jordan Fairweath… DONE      ← the chip's first line, starting 7 px lower
└┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
  Cut · +15125550103
  ⚑ 1 no-show and 1 late cancel
```

The two strings overprint. The text reads as *"5̶ ̶1̶0̶:̶0̶0̶ ̶m̶i̶n̶ ̶J̶o̶r̶d̶a̶n̶"*,
and the time and name are the two things the desk reads a column for.

Measured on every chip of the future book: does a gap label's text box
intersect the top 20 px of an appointment chip in the same column? Measured in
page coordinates, after one version of this script compared a rectangle taken
before scrolling with one taken after it and reported zero:

```
day          chips   first line overprinted by a gap label
Wed 16 Sep     21     11
Thu 17 Sep     36     12
Fri 18 Sep     39      3
Sat 19 Sep     41      7
Tue 22 Sep     24     17
Wed 23 Sep     34     21
Thu 24 Sep     24     11
Fri 25 Sep     26     17
             ----    ---
              245     99     40%
```

### Why

`day-grid.tsx:271` gives every item on the grid a floor:

```ts
height: Math.max(item.minutes * PX_PER_MINUTE, 18),
```

At 1.5 px/min, 18 px is **twelve minutes**. A gap shorter than that is drawn
taller than the time it stands for, so it runs down into whatever starts when
it ends. And `:292` paints gaps **above** appointments:

```tsx
<li className={`${CHIP_SHELL} ${item.kind === 'gap' ? 'z-10 ' : ''}…`}
```

That `z-10` is A-030's, and its reason is right: *"a gap can now fall INSIDE an
appointment — a colour's developing time is real bookable provider time — so
gaps paint above appointment chips rather than under them."* The floor is
A-016's, and its reason is right too: a 7 px band holds no text. Each was
decided on its own, and together they put a label over the next chip's first
line.

**The seed makes sub-twelve-minute gaps the ordinary case, because the salon
books the ordinary way.** A Cut is 45 minutes plus a 10-minute buffer, so a
book of cuts on the hour leaves 5 minutes free before each one. A Treatment is
20 + 5, so a book on the half-hour leaves 5 minutes every half-hour. Nothing
about that is a seed artefact. It is what a column looks like when the desk
fills it by the clock.

**It also lies about the time.** Nothing this salon sells fits in 5 minutes:
the shortest footprint is a Fringe trim, 10 + 5 = 15. The overprinting label is
a `Book 5 minutes free` link to a booking panel that cannot book anything into
it. That is a separate question from where the label is drawn, and it is the
first option in the row below, not a second defect.

### Why nothing caught it

Every check in the gate reads **one element at a time**. Axe asks about
contrast and names; `toBeVisible` asks about layout and visibility; A-113 and
A-120's `scrollWidth` rule asks whether an element's own text fits its own box.
**Both of these elements pass all of that.** The gap's text fits its box, the
chip's time fits its box, and they are in the same place. The accessible
name is whole on both. It is A-120's trap one dimension over: *a truncation is
invisible to every tool that reads `textContent`*, and **so is a collision**.

---

## Scene 2 — a cancelled appointment cannot be clicked from the grid

*Today, Tess's column. Marcy Dunn's 12:00 Cut was cancelled this morning, so
A-112's "Put it back on the book" is live on its page.*

```
Tess, 11:55–13:00:  "65 min free"   gap        745–842 px   z-10, a link to /staff/book
Tess, 12:00–12:45:  "12:00 Marcy Dunn — Cut — cancelled"   chip   752–820 px   under it
```

The gap covers the chip entirely. A grid of 25 points sampled inside the chip
finds the chip under **none** of them, and Playwright refuses to click it:

```
getByRole('link', { name: /Marcy Dunn, Cut, cancelled/ }).click()
  → TimeoutError: <a aria-label="Book 65 minutes free, 11:55–13:00, with Tess"
                     href="/staff/book?provider=…&at=2026-09-16T16:55:00.000Z…"> … intercepts pointer events
control, same page:  "11:00–11:45, Rae Núñez"  → /staff/appointments/…   (opens)
                     "09:00–12:00, Alice Hall" → /staff/appointments/…   (opens)
```

The page it would have opened:

```
/staff/appointments/{Marcy Dunn, 12:00, cancelled}
    Reason (needed for some changes)
    Text them to say it's back on — They were already sent a cancellation. …
    Put it back on the book
```

**The one place on the grid that shows a cancellation is a link to book over
it.** On the day it matters most, when a client rings back five minutes after
cancelling, the desk sees her name struck through on the column and clicks
it, and gets a booking panel for a stranger in her slot. The appointment is
still reachable from Marcy's client record. The grid, where A-112 was designed
to be found, cannot reach it.

### Why, and why it needs a decision

This is not Scene 1's floor. The gap is 65 minutes long and drawn at exactly
its length. Both facts are true: the time **is** free (D-53, a cancellation
frees its time) and the appointment **is** there (A-112, it can come back).
A-030's `z-10` decides which one wins the pointer, and it decided that before
a cancelled appointment had anything to click for. Only 1 chip in 245 on this
book is buried, because the seed cancels one appointment in the future. In a
real salon every same-day cancellation is this chip.

Three ways out, and they build different screens:

- **(a) Cancelled chips paint above gaps** and the gap stays clickable around
  them. That is a 45-minute chip over a 65-minute gap, leaving 20 clickable
  minutes the desk has to find.
- **(b) The gap splits around a cancelled chip into lanes** (A-099's
  machinery): the struck-through visit on one side and the bookable time on the
  other, both whole.
- **(c) Cancelled appointments leave the grid** and the reinstatement door
  moves to `/staff/opened`, which already lists this exact slot (*"Cancelled by
  Marcy Dunn"*) with no link to the appointment.

---

## Phase 13, walked

| item | walked | holds? |
|---|---|---|
| **A-114** (D-55) one client however she types | `/book` as `Alice Hall` / `(512) 555-0101`; as `alice  HALL` / `512.555.0101`; as `Rae Nunez` / `512 555 0104`; as `Marcy Dunn` / `5125550107`; as `Rae Núñez` / `+44 512 555 0104` | **yes.** Both Alices are refused at step 5 and no client is created. Unaccented Rae and Marcy book onto their own records. `+44…` is a new client, correctly, since it is a different number. The desk search `nunez` finds Rae. |
| **A-117** the badge | shell | **yes.** *Messages 5* matches the 5 never-reminded appointments. |
| **A-118** "nothing has actually been sent" | `/staff/messages` | **yes.** *"NOTHING HAS ACTUALLY BEEN SENT (733)"*, and the never-reminded section lists 5, with *"The reminder job last ran Wednesday 16 September at 10:43."* |
| **A-119** an entry is a visit | `/staff/opened` | **yes** on the demo book: Marcy's freed 55-minute Cut offers Alice Hall, who is waiting on a Cut. No two-service entry is seeded, so the composed footprint was not exercised. `waitlist.test.ts` owns that. |
| **A-120** the flag, the long name, the missed list | today's grid, `/staff/messages` | **yes.** Alice's chips read *"⚑ Desk books only"*, Jordan's read *"⚑ 1 no-show and 1 late cancel"*, the long name is on the book on 8 days, and the missed list has rows. |
| **A-115**, **A-116** | not walked | both carry pinned e2e specs written from the measurement. This walk spent its time on Scene 1. |

## What was checked and is clean

- **The grid scrolls, it does not overflow the page.** At 390, 1024 and 1280 px
  the document never scrolls sideways; the column grid is its own `overflow-x`
  container (1072 in 976 at 1024 px today).
- **86 route×scheme pairs** clean (The crawl).
- **Clicking an ordinary chip under a short gap still opens it.** The gap covers
  the top 7–11 px of the chip, and the name's centre is below that. Scene 1 is
  a reading defect, not a pointer one. Scene 2's chip is the only one of 245
  whose whole box is covered.
- **D-55's display rule**: every phone renders `+15125550101`, as D-55 records
  (*"Display is unchanged"*). Not re-opened.

## Smaller things, worth a line each

- **Two of the five never-reminded rows are one phone call.** Leo and Marcy
  Dunn share `+15125550107`, both at Thursday 09:00, listed as two rows each
  saying *"ring them"*. D-17 keeps them as two people, correctly. The list
  could say *"same number as Leo Dunn"*. Not scoped.
- **`/staff/opened` names who cancelled and does not link to the cancellation.**
  It is the one surface besides the grid that shows Marcy's slot, and it is
  option (c) above.

---

## The rule this checkpoint leaves behind

> **A COLLISION IS INVISIBLE TO EVERY CHECK THAT READS ONE ELEMENT.** Axe, `toBeVisible`,
> `getByText`, the accessible name and A-120's `scrollWidth` rule all ask a
> question of a single box, and two boxes that each pass can be drawn on top of
> each other. The grid positions everything absolutely from minutes, so its
> layout is arithmetic nobody sees until two rules each hand it a different
> number: A-016's 18 px floor and A-030's `z-10`, both right, decided five
> items apart. **Where a surface places elements by computed position, assert
> that the text boxes of neighbours do not intersect**, in page coordinates,
> and print both rectangles in the failure. **And look at a screenshot before
> measuring anything.** The crawl's numbers were clean on every day the defect
> was on. The screenshot showed it in the first column.
