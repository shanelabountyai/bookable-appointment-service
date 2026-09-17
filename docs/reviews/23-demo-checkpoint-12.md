# Demo checkpoint 12: the flag the chip has no room for

**Walked 2026-09-17, at the Phase 14 close. This is the first walk since
A-121 stopped short gaps overprinting the next chip and A-122 laned a
cancelled chip beside the time it freed.**
**Result: Phase 14 holds everywhere it was walked. The walk found one
defect, one axis over from A-120: a chip clips its lines at its bottom
edge, and the lines it clips are the ones the desk acts on.**

Checkpoint 11 left a rule behind: look at a screenshot before measuring
anything. This walk did. Today's screenshot had no text printed over other
text anywhere. It also had Dana's 09:00 override chip, which is laned beside
Leo Dunn as A-099 intended, **with no OVERRIDE marker on it**, and Nadia
Rahman's four Treatments, **none of them showing the late-cancel flag that
her Blow-dry chips carry the next day**.

The walk ran against a production build on a **freshly created database,
`bookable_cp12`**. `bookable_cp11` was dropped first. `bookable_dev` and
`bookable_test` were not touched. The scripts lived in a scratch directory
and are deleted; what they found is transcribed below.

**The machine before the walk.** The load average was 269 on 10 cores. Five
vitest runs in `alongside` and `storage business` had been running for 3.5 to
4.3 hours, and three orphaned vitest workers (parent PID 1) had been running
for 16 hours. The seed made no progress for about 8 minutes. The owner
approved killing the five runs, and the three orphans were killed as the same
class. The load fell and the seed finished. This is the third checkpoint in a
row whose environment note is a CPU-bound neighbour.

---

## The book it was walked on

`seedSetup` then `seedDensity` on an empty, freshly migrated schema:

```
[seed] 4 providers, 8 services, 719 appointments, 13 clients (spring-forward 10, fall-back 3;
       19 days around today, 132 left open; 3 on the waitlist, 2 call marks, 2 call-down
       attempts, 5 lapsed; 746 messages sent, 1 double-booked by override;
       32 reminders swept, 3 left by the skipped band)
```

**Today is Thursday 17 September**, walked from 10:21 CDT. The future book
runs Thu 17 … Fri 25 September, seven working days and **224 appointments**,
reconciled against the table day by day (36, 39, 41, 24, 34, 24, 26).

---

## The crawl

Forty routes at 1024×768, **each in both colour schemes**, with transitions
frozen. The staff routes include eight days of the grid, the cancelled
appointment (Jordan Fairweather-Okonkwo, 09:00 today), the override (Dev Iyer,
09:00 today), four client records, two client searches, and every other staff
screen. The public routes are `/`, `/services`, `/stylists`, `/visit` and
`/book`.

```
80 route×scheme pairs:  80 × HTTP 200
                        0 axe violations, in either scheme, on any of them
                        0 console errors, 0 page errors
                        0 bounced to /staff/login: every row printed the URL it landed on, its <h1>
                          and its body length
gendered pronouns in the rendered text of 40 routes:  0
document scrolls sideways:  0 of 80
```

**Two checks are new this walk, both from checkpoint 11's rule:**

- **Collision.** For every pair of visible text nodes that are not ancestor
  and descendant, do their `Range` rectangles intersect in page coordinates?
- **Pointer.** For every link, button, summary and input, does
  `elementFromPoint` at its centre, after scrolling it into view, land on the
  element itself?

The first pass reported hundreds of both, and nearly all were the script's
fault. **Content inside a closed `<details>` still has layout rectangles in
Chromium.** Every day column's closed *Push the column* form, and every closed
edit form on `/staff/services`, was "colliding" with the chips under it.
Filtering with `checkVisibility({ contentVisibilityAuto, visibilityProperty,
opacityProperty })` left:

```
buried controls (pointer check)             0 on every route
text-over-text, grid days Thu 17 … Fri 25   every remaining hit is text CLIPPED by
                                            overflow-hidden, whose box runs past the
                                            chip's bottom edge into the next item
```

**No text is drawn over other text.** The remaining hits are text boxes a
chip has already clipped, so they do not overprint. What they do show is
which lines are missing, and that is Scene 1.

**Horizontal overflow** is unchanged from checkpoint 11 in kind: *Jordan
Fairweather-Okonkwo* on ordinary and laned chips (A-120, deliberate), and
short room-strip chips (`Priya · Blow-dry` 85 in 69, `Tess · Fringe trim` 93
in 69). Recorded, not scoped.

---

## Scene 1: the OVERRIDE marker and the flag are cut off at the chip's bottom edge

*Today, `/staff/day`, Dana's column. From the screenshot at 2×:*

```
┌──────────────────────────┬──────────────────────────┐
│ 09:00 Dev Iyer           │ 09:00 Leo Dunn           │   ← the laned pair A-099 draws
│ Treatment · +15125550102 │ Treatment · +15125550107 │
└──────────────────────────┴──────────────────────────┘
  OVERRIDE                                                ← line 3: 513–531 px, chip ends at 512
```

The chip's own comment calls the override marker *"the single most important
visual in the product. It means a human deliberately booked over the rules and
typed a reason."* On the only override on the book, it is **below the chip's
bottom edge**. The accessible name says *"booked as an override"*, so axe and
`getByRole` are satisfied.

Measured on every appointment chip of the future book, one chip per
appointment: which lines have a bottom edge past the chip's bottom edge?

```
day          chips  flagged   flag wholly hidden   flag partly cut   override hidden
Thu 17 Sep     36      15            13                   0                1 of 1
Fri 18 Sep     39      15            10                   2
Sat 19 Sep     41      19            16                   0
Tue 22 Sep     24       9             8                   0
Wed 23 Sep     34      14             8                   4
Thu 24 Sep     24       8             2                   5
Fri 25 Sep     26      12             8                   2
             ----    ----          ----                ----
              224      92            65                  13
```

**Of 92 flagged chips, 14 show the flag whole.** The other 78 are 25-minute
Treatments, 30-minute Blow-dries and 10-minute Fringe trims. That is most of
this salon's book, and it is where *"⚑ Desk books only"* (D-57) was supposed
to be read. Examples, each a line box against its chip box:

```
11:00–11:20 Nadia Rahman, Treatment   "⚑ 1 late cancel"     line 691–707   chip 654–692
09:15–09:25 Alice Hall, Fringe trim   "⚑ Desk books only"   line 548–564   chip 511–533
09:00–09:30 Nadia Rahman, Blow-dry    "⚑ 1 late cancel"     line 525–541   chip 488–541   (cut through the glyphs)
```

The same measurement also sees the ordinary lines: **91 chips have the
service and phone line cut through horizontally** (the top half of the glyphs
drawn, the bottom clipped), and **54 have it wholly hidden** (every Fringe
trim, which is floored at 18 px). The cut-in-half line is visible in the
A-122 screenshot below.

### Why

`appointment-chip.tsx` renders the lines in a fixed order, and the chip is
`overflow-hidden` at the height of its time:

```
line 1   time · name · STATUS WORD     (status word shrink-0, A-120)
line 2   detail: service · phone
line 3   → likely 10:20                (running late)
line 4   ⚑ pinned client note          (CLIENT-03, the safety line)
line 5   ⚑ Desk books only / 3 no-shows (CLIENT-04, D-57)
line 6   ✎ visit note
line 7   OVERRIDE
line 8   time back from …
```

At 1.5 px/min a 25-minute chip is 37.5 px tall, which is two lines. **Every
line after the service is decided by order, and the order puts the lines the
desk acts on last.** A-120 fixed the flag's *width* (386 px of text in 185)
and measured `scrollWidth` against `clientWidth`, which is the check it asked
for. Nothing measured the other axis. A-035 already counts lines
(`linesInUse`) to decide whether a *button* fits. It never decides which
*text* fits.

**The pinned note is in the same position, and the demo cannot show it.**
`Client.notes` is null on all 13 seeded clients, so CLIENT-03's safety line
("allergic to PPD", say) has never been on the demo book. By the order above,
on a Treatment it would be clipped exactly like the flag. That is inference
from the render order, not a measurement, because there is nothing to measure.

### Why nothing caught it

It is A-120's trap one dimension over. `toBeVisible` asks about layout and
visibility, not about fit. The accessible name carries every line whole.
A-120's rule compared `scrollWidth` with `clientWidth`. **A line that fits
its width and sits below its container's bottom edge passes every check in the
gate.** A-120's own e2e (`no-show-block.spec.ts`) measured the flag on a 45-minute chip, where it fits.

---

## Phase 14, walked

| item | walked | holds? |
|---|---|---|
| **A-121** a short gap is drawn at its own height, without a label | every grid day, Thu 17 … Fri 25, both schemes | **yes.** The collision check found no gap label over any chip on any day, and Dana's 35-minute gaps still print *"35 min free"*. |
| **A-122** (D-58) a cancelled chip and its freed time are laned | today, Tess's column: Jordan Fairweather-Okonkwo's 09:00 Treatment, cancelled | **yes.** `Book 30 minutes free, 09:00–09:30, with Tess` sits at x=1327 beside the chip at x=1120, both 185 px wide. `getByRole('link', { name: /Jordan Fairweather-Okonkwo, Treatment, cancelled/ }).click()` opens `/staff/appointments/…` with the reinstate controls. Screenshot below. |

```
┌─────────────────────────────────────────┐ ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
│ 0̶9̶:̶0̶0̶ ̶J̶o̶r̶d̶a̶n̶ ̶F̶a̶i̶r̶w̶…̶  CANCELLED           │ ┆ 30 min free     ┆
│ Treatment · +1512555010̲3̲  ← cut in half │ ┆                 ┆
└─────────────────────────────────────────┘ └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
```

## What was checked and is clean

- **80 route×scheme pairs** clean (The crawl).
- **No control on any route is under another element** at its centre, once
  closed `<details>` content is excluded. That covers every gap link, chip
  link and status button on seven grid days.
- **D-17 on the room strip.** Tom Byrne is at 13:00 today with Dana in Chair 1
  and with Tess in Chair 3, and Dev Iyer holds two chairs on Friday. The
  screenshot reads like a double-booking. It is not one: D-17 allows one
  client to hold overlapping appointments, and the seed exercises that.
  Not re-opened.

## Smaller things, worth a line each

- **The never-reminded list grows with the wall clock on an install with no
  scheduler.** The badge says 14 (the seed reported 3 left by the skipped
  band). *"The reminder job last ran Wednesday 16 September at 18:09"*, 16
  hours before the walk, because nothing runs the job locally. The page is
  truthful and prints the timestamp, but only at the bottom. In production a
  dead cron would look identical, and the only thing saying so is that
  sentence. A staleness sentence (*"it should run every N minutes"*) would
  turn a timestamp into an alarm. Not scoped. It becomes a candidate when a
  real driver lands.
- **Tom Byrne is listed twice at 13:00** in the never-reminded list: two
  appointments, one phone call. This is checkpoint 11's Leo/Marcy Dunn note
  again, and still not scoped.
- **The room strip clips `Nadia Rah…` and `Dev Iyer / Priya · Blo…`** when
  the same client's envelopes lane in one chair (A-063). Recorded.

---

## The rule this checkpoint leaves behind

> **A LINE THAT FITS ITS WIDTH CAN STILL BE BELOW THE BOTTOM EDGE.** A-120
> asked whether text fits its box horizontally, and the chip passed. Its
> container is `overflow-hidden` at a height set by the clock, so the lines
> past the second are decided by **render order**, and render order is not a
> priority. **Where a container clips on a height it does not choose, assert
> that every line the design calls load-bearing has `bottom <= container
> bottom`, and print both.** Assert it on the SHORTEST thing the salon sells,
> not on the fixture's comfortable 45-minute default. And measure every chip
> **once**: this walk's first count doubled to 446, because the room strip
> links the same appointments and a DOM query does not know a grid chip from
> a chair chip. The count reconciled only after deduplicating by `href` and
> checking the total against the table.
