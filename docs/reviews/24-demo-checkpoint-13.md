# Demo checkpoint 13: D-59's chip, walked

**Walked 2026-09-17, at the Phase 15 close. This is the first walk since A-123
put the markers on line one and drew the lines below in priority order.**
**Result: Phase 15 holds. Every flagged chip and the only override chip on
the future book carry their marker inside the chip. Nothing was scoped.**

The walk ran against a production build on a **freshly created database,
`bookable_cp13`**. `bookable_cp12` was dropped first. `bookable_dev` and
`bookable_test` were not touched. The scripts lived in a scratch directory
and are deleted.

**The machine before the walk.** The first seed failed with `P2028`: the
interactive transaction timed out after 31.6 s against a 5 s budget, and the
run used 15% CPU over 6 minutes. Load average was 157 on 10 cores. The cause
was `alongside/backend`, with 28 vitest processes: two live runs and eight
orphaned workers (parent PID 1). The owner chose to kill the orphans and let
the live runs finish. The re-seed took 1.5 minutes. **This is the fourth
checkpoint in a row whose environment note is a CPU-bound neighbour.**

---

## The book it was walked on

```
[seed] 4 providers, 8 services, 753 appointments, 13 clients (spring-forward 10, fall-back 3;
       19 days around today, 130 left open; 3 on the waitlist, 2 call marks, 2 call-down
       attempts, 5 lapsed; 782 messages sent, 1 double-booked by override;
       34 reminders swept, 1 left by the skipped band)
```

The walk covers Thu 17 … Fri 25 September, whole days, seven working days.
**227 grid chips, one per `href`**, matching the `Appointment` table day by
day (48, 24, 37, 33, 20, 30, 35, including one cancelled).

## The crawl

27 routes at 1024×768 in both colour schemes: seven grid days, every staff
index screen, and `/`, `/services`, `/stylists`, `/visit`, `/book`.

```
54 route×scheme pairs:  54 × HTTP 200, 0 bounced to /staff/login (every row printed its URL and <h1>)
                        0 axe violations (wcag2a/aa, 21a/aa), 0 console errors, 0 page errors
                        0 documents that scroll sideways
```

## Phase 15, walked

Each chip's lines and markers were measured against the tighter of the
`<li>` padding box and the link's own box, which is A-123's helper.

```
day          chips   ⚑ expected / inside   OVR expected / inside   rows cut
Thu 17 Sep     48        26 / 26                 0 / 0                1
Fri 18 Sep     24        15 / 15                 1 / 1                0
Sat 19 Sep     37        19 / 19                 0 / 0                0
Tue 22 Sep     33        15 / 15                 0 / 0                0
Wed 23 Sep     20         7 / 7                  0 / 0                0
Thu 24 Sep     30        19 / 19                 0 / 0                0
Fri 25 Sep     35        16 / 16                 0 / 0                0
             ----      --------                -------              ----
              227     117 / 117                 1 / 1                1
```

"Expected" comes from the accessible name (`note: `, `no-show`,
`late cancel`, `booked as an override`), independent of the markup being
measured. No chip carried a `⚑` it should not have.

**At checkpoint 12, 14 of 92 flagged chips showed the flag. Now 117 of 117 do.**
On the screenshot, Friday's override chip (Jordan Fairweather-Okonkwo, 09:00,
laned beside Dev Iyer) reads `09:00 Jordan Fairweath… ⚑ OVR` with `OVERRIDE`
whole on line two.

### The one cut row: a line box, not glyphs

`Thu 17, 12:00–12:10 Jordan Fairweather-Okonkwo, Fringe trim, no-show, time
given back from 12:05`. Line one's box runs from 745.5 to 762.5 px, and the
chip's clip ends at 761.5.

- This chip is drawn at the **18 px floor** (`MIN_LABELLED_PX`), because its
  extent is short once the time is given back. Every other Fringe trim is
  22.5 px.
- **Line one is 17 px when a status word is on it, and 16 px when not.** The
  10 px uppercase word is baseline-aligned (`items-baseline`), which adds a
  pixel to the line box. A 22.5 px chip has 21 px inside its border, so the
  extra pixel only matters at the 18 px floor.
- At 2×, the glyphs are whole: `12:00 Jordan Fair… ⚑ NO-SHOW`. The clipped
  pixel is below the descenders. The hatched released-time chip painted over
  it is A-069's deliberate overprint.

Recorded, not scoped. D-59 (4) says line one is whole on a Fringe trim, and
the glyphs are. It would become a defect with a larger caption size.

### Tom Byrne's pinned note

This is the first walk where CLIENT-03's pinned note exists on the demo book:
*"Allergic to PPD — patch test before any colour."*

```
Tom Byrne's chips   height    note words shown   ⚑ only
Treatment           37.5 px          0              12
Fringe trim         22.5 px          0               8
Blow-dry            52.5 px          5               0
Cut                 82.5 px          1               0
Cut & finish       112.5 px          1               0
Root touch-up       165 px           1               0
```

**The words are on every chip where the note matters.** PPD is a colour
concern, and every colour service (Root touch-up 90 min, Colour 120,
Balayage 180) is tall enough to show the note on line two. On a Treatment or
Fringe trim the chip shows `⚑` only, which looks the same as a late-cancel
flag. That is D-59's stated cost (*"the `⚑` on line one does not say
WHICH"*). On this book no client has both a note and a flag, and the service
where confusing the two would matter always shows the words. Not re-opened.

## Smaller things, worth a line each

- **Override chips show both `OVR` on line one and `OVERRIDE` on line two**
  when there is room. That is redundant but harmless, and it follows D-59
  (1) and (2) as written.
- **At 1024 px the grid clips Marcus's column and hides Tess's.** It scrolls
  inside its own container, and the document does not scroll sideways.
  Unchanged since earlier checkpoints.
- **The room strip still clips `Dev Iyer / Marcus · …`** when one client's
  envelopes lane in a chair (checkpoint 12's note, D-17).

---

## The rule this checkpoint leaves behind

> **COUNT THE EXPECTATION FROM A DIFFERENT SOURCE THAN THE THING MEASURED.**
> This walk took "which chips should carry `⚑`" from the accessible name and
> measured the marker in the markup. Had it counted `⚑` spans and checked
> they were inside the chip, a chip that lost its marker entirely would have
> dropped out of both sides of the ratio, and the result would still have
> read "all present".
