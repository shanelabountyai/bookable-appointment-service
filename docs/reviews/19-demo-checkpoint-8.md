# Demo checkpoint 8 — the walk on a book that finally pushes back

**Walked 2026-09-07, at the Phase 10 close — the first walk since A-095 gave the
demo install a waitlist, call marks, call-down attempts and four working
columns instead of two.**
**Result: three defects, none of them a coding mistake. Each one is a sentence
the product says with confidence about a question nobody asked it.**

Checkpoints 1–7 each found a defect sitting inside an item already marked ✅ and
invisible from within the item that introduced it. Checkpoint 6 needed a busy
room; checkpoint 7 needed a *worked* book and found that every axe run in the
suite had been looking at an empty screen. This one is the first walk where the
**room actually binds** and the **freed-slot loop has rows in it** — so the two
scenes checkpoint 7 wrote down as unwalkable were finally walked, and both are
clean. What broke instead was the layer above: three screens that answer a
question they were not asked.

The walk was scripted against a production build on the seeded density book, in
a separate database (`bookable_dev`) so the operator review could read
`bookable_test` at the same time. The scripts have been deleted; what they found
lives on as three findings and the measurements below.

---

## The book it was walked on

`db:seed:dev` — `seedSetup` then `seedDensity`, the demo install, on a freshly
migrated empty schema:

```
4 providers   8 services   8 service segments   13 clients   4 chairs
640 appointments   booked 443  completed 146  checked_in 50
                   no_show 3  cancelled_late 2  cancelled 1
3 on the waitlist   2 call marks   2 call-down attempts   1 time off   11 date overrides
637 chair holds     663 worked blocks     645 service lines     640 outbox rows

book spans 2025-09-08 … 2026-11-01 over 28 days with appointments on them
future book: 2026-09-08 … 2026-09-16, EIGHT working days, four columns on every one
```

**Today is Monday 7 September and the salon is closed Sundays and Mondays**, so
the walk's "today" is a shut day — which turned out to matter (§ Scene 1).

**The seed alone: 16.8 s.** NEXT.md asked for this number, because A-095's note
records "~15–18 s" and A-097 measured `density-seed.test.ts` at 76.9 s for a
file that seeds three times. The two reconcile: 3 × 16.8 s is 50 s, and the
remainder is the file's own setup and assertions. **The 120 s hook budget stands
and needs no change.**

**A-095 delivered what it said it would.** Checkpoint 7's two complaints:

```
                        checkpoint 7        checkpoint 8
future columns          Dana + Priya        all four, on all 8 days
waitlist entries        0                   3
call marks              0                   2
call-down attempts      0                   2
no-resource-free        0 in 21,184 offers  44
```

---

## The crawl

Twenty-five staff routes at 1024×768, **each one in both colour schemes** —
A-096's loop, now the only way the helper can be called:

```
50 route×scheme pairs:  50 × HTTP 200
                        0 axe violations, in either scheme, on any of them
                        0 console errors, 0 page errors
```

**A-096 holds.** The dark half of the palette is measured everywhere and is
clean everywhere. Two `incomplete` counts are worth recording and neither is a
violation: `/staff/design` returns **53** in both schemes (50 at A-096; the
three new ones arrived with A-089's primitives gallery growing), and
`/staff/day?day=2026-09-08` returns **32**, all of them the grid's absolutely
positioned chips, which axe cannot resolve a background for.

---

## Scene 1 — Monday morning, and the dashboard says the week is empty

*The owner opens the product on the day the salon is shut and asks the only
question the dashboard exists to answer: how are we doing this week?*

```
/staff/dashboard        Monday 7 September – Sunday 13 September
                        Bookings         157
                        Cancellations      1        1 on time · 0 late
                        No-shows by provider  None this week.
                        Utilization      Dana: 0.0%
                                         Priya: 0.0%
                                         Marcus: 0.0%
                                         Tess: 0.0%
                        Clients who have stopped coming — who to ring to fill a quiet Tuesday →
```

**One hundred and fifty-seven bookings and nought per cent utilization, on the
same card, computed by the same function, for the same seven days.**

Run against the real `dashboardSummary` over four weeks:

```
week 2026-06-08..14  bookings=211  Dana=61.4% Priya=0.0% Marcus=0.0% Tess=0.0%
     mix: completed 43   booked 166   cancelled_late 2
week 2026-08-31..09-06 bookings=176  Dana=34.3% Priya=21.2% Marcus=27.9% Tess=35.8%
     mix: completed 88   checked_in 44   booked 44
week 2026-09-07..13   bookings=157  Dana=0.0%  Priya=0.0%  Marcus=0.0%  Tess=0.0%
     mix: booked 156   cancelled 1
week 2026-09-14..20   bookings= 58  Dana=0.0%  Priya=0.0%  Marcus=0.0%  Tess=0.0%
     mix: booked 58
```

The numerator is `CONSUMED_STATUSES` — `['completed', 'no_show']`, terminal
states only (`dashboard.ts:91`). Nothing that has not yet happened contributes,
so **every week that has not happened yet reads 0.0% for every stylist, and the
dashboard opens on the current week.**

**This is not a coding mistake, and the code is not wrong.** RPT-02 freezes the
formula in as many words:

> `Σ minutes of appointments in {completed, no_show} ÷ Σ (working minutes −
> breaks − time off)` per provider per business date; buffer minutes count in
> neither term; **zero denominator renders "n/a", never 0%**.

`dashboard.ts` implements that exactly. The denominator here is not zero — the
stylists have their hours — so `0.0%` is the spec-correct rendering. And it is
tested, twice, deliberately:

```
dashboard.test.ts:101  'utilization counts completed/no-show minutes only —
                        a merely-booked appointment contributes nothing'
dashboard.test.ts:95   'a provider with availability but nothing completed reads
                        0%, not n/a — those are different facts'
```

**What was never specified is which week the tile is shown for.** RPT-02 froze
a retrospective formula; RPT-01 put it on a dashboard; nothing decided that the
dashboard opens on the current week, and so nothing ever asked what a
retrospective number should say about a week that has not happened. **The
formula must not be re-opened** — it is frozen on purpose and the AC depends on
it. The question is what the tile renders when `toDay >= today`.

That second test is the finding stated by the code itself. **0% and n/a are
different facts — and the product uses 0% for both of them.** "We had thirty-five
hours available and sold none of them" is an emergency. "It is Monday and the
week has not happened yet" is Monday. They render identically, and the number
that separates them — 157 bookings — is sitting four lines above.

**Why no test could see it.** `utilization-constant.test.ts` pins Dana's
DEMO_WEEK figure to the exact seeded constant `1290/2100`. DEMO_WEEK is a
*fixed week in the past*, deliberately, so the constant cannot rot — and a past
week is the only week where a retrospective definition is the right one. The
default view is the *current* week, and no test has ever asked it anything.
Note that even the pinned week reads **0.0% for three of the four stylists**,
because only Dana's rows were ever closed out in it; the constant test asserts
Dana and looks no further.

**And it sits directly above the wrong action.** The line under the tile is
*"Clients who have stopped coming — who to ring to fill a quiet Tuesday →"*.
That is an action about a **future** Tuesday. The number above it, by
construction, can only describe a **past** one. The owner deciding whether to
run a lapsed-client round is reading the one figure that is guaranteed to say
0.0% about the week they could still do something about.

**Not fixed here.** A forward "how much of this week is sold" and a backward
"how much of it did we work" are two numbers, not one, and which the tile shows
— or whether it says *"not yet worked"* instead of `0.0%` for a week still
ahead — is a product decision with a D-number's worth of consequence. Written
into the backlog as the top row, with RPT-02's formula explicitly out of scope.

## Scene 2 — Marcy Dunn wants a blow-dry after the cut she is already sitting in

*The A-083 shape, on the caller A-083 did not reach — and NEXT.md predicted it.
The walk's job was to find out whether it can actually bite. It can.*

`confirmAppointment` resolves the client at `public-actions.ts:364`, then in its
own `catch` at `:429` calls

```ts
sameTimeWithSomebodyElse(input.serviceIds, startAt, input.providerId)
```

— which asks `anyProviderAt` with **no `holderKey`** (`:252-266`). The room is
therefore asked about a stranger, for a woman the same function created or
found sixty lines earlier.

It is the strict direction, so it can only ever offer *fewer* times than the
write would take. Measured over the future book — every day × service × client
who has something on that day, the anonymous answer against the named one:

```
472 comparisons
 23 instants the NAMED question offers that the anonymous one refuses
  0 instants the anonymous question offers that the named one refuses   ← safe direction holds
```

**The concrete one.** Tuesday 8 September, 13:45 local. Marcy Dunn is in Tess's
chair for a cut, body 13:00–13:45, envelope 13:00–13:55. Every chair in the room
has an overlapping envelope at that instant:

```
chair …t2000c   13:30–13:55   (someone else)
chair …t3000e   13:30–13:55   (someone else)
chair …t4000g   12:50–15:20   (someone else)
chair …t5000i   13:00–13:55   ← MARCY. Body ends 13:45.
```

To a stranger there is no fifth chair and the answer is `no-resource-free`. To
Marcy the answer is *the chair she is physically sitting in* — A-063's whole
point, half-open bodies meeting at 13:45, envelopes allowed to overlap for one
holder. So she books a blow-dry straight after her cut, online, having said she
does not mind who does it; the stylist gets taken while she is typing; and the
rescue that exists precisely so she is not dead-ended **does not fire**, because
it asked the room whether it could seat a fifth person. She is told to pick
another time, on a slot the write path would have accepted, while sitting in the
chair.

**Why it is invisible from inside A-083.** A-083 threaded `holderKey` through
every caller holding an appointment and through the desk's two client-holding
callers. This one holds a client *and* is inside a `catch` — it is not a
booking surface, it is a refusal handler, and refusal handlers do not read like
callers of the room's question. It is A-097's rule one door along: **the
fallback arm is a reader too**, and this fallback inherited the default
argument rather than the answer the function already had.

## Scene 3 — "has anyone been let off the late count lately?"

*The route NEXT.md flagged as having no e2e spec at all. It has a defect, and it
is the one its own sibling was fixed for.*

```
/staff/dashboard/overruled          (no from/to)

    Let off the late count
    Pick a week from the dashboard.
    None that week — every cancellation was classified by the cutoff.
```

**Both sentences, at once.** The page asks you to pick a week and then, in the
next line, reassures you about the week you have not picked. The reassuring one
is a claim about an empty query.

One door along, the same empty state was already fixed — by A-087, at the last
checkpoint:

```
dashboard/appointments/page.tsx:64
  {fromDay && toDay ? 'Nothing matches this filter.' : 'Pick a week from the dashboard.'}

dashboard/overruled/page.tsx:55-58
  {rows.length === 0 ? <p>None that week — every cancellation was classified by the cutoff.</p> : …}
```

A-087 found the bug on the screen it was looking at and repaired that screen.
The identical construction in the sibling directory was never opened. **That is
A-096's rule verbatim — "patching the rooms that noticed leaves the door
open" — and the room that did not notice is the one with no spec.**

**Two facts compose to make it reachable.** The only inbound link is on the
dashboard and is guarded on `summary.cancels.overruled > 0`, with a comment
saying so out loud: *"it disappears in a week with none."* So in most weeks the
screen has **no door at all**, and a desk that wants to check anyway arrives by
bookmark, by history, or by typing — every one of which lands on the bare URL,
which is the one state that lies. An invisible door and a falsely reassuring
room behind it.

`/staff/book` has the same shape and is worth fixing in the same row: reached
without a `provider` param it says **"That stylist is not on today."** — a
confident fact about a stylist nobody named (`book/page.tsx:120`, the branch is
`!walkIn && !anyone && !provider`). It says it on a Tuesday when all four are
in. The same branch also catches a *deactivated* stylist, who is not "not on
today" either.

## Scene 4 — the freed-Saturday sale, walked at last

*Checkpoint 7 could not walk this: `WaitlistEntry 0, ClientCallMark 0,
CallDownAttempt 0` on a book of 453 appointments. A-095 fixed the seed. This is
the first time the loop has been walked end to end.*

```
/staff/opened     Tuesday 8 September at 09:00 · 55 min
                  Cut · Tess
                  Cancelled by Marcy Dunn  +15125550107
                  Already asked
                    Alice Hall — thinking about it
                  [Who wants this slot?]  [Details]
        ↓  href carries the INSTANT, never {day, time}  (D-4)
/staff/waitlist?providerId=…&serviceId=…&at=2026-09-08T14:00:00.000Z&minutes=55
                &key=cancelled:…&appointmentId=…
        ↓  200
                  WHO WANTS THIS SLOT?
                  Cut with Tess, Tuesday 8 September at 09:00.
                  Alice Hall  +15125550101
                  [Book] [Fulfilled] [No answer] [Left a message] [Thinking about it] [Took it]
```

**Walked and found clean.** The matcher picks the one waitlisted client whose
service, provider preference and date window all admit the freed slot; the call
marks already recorded against her render as "Already asked · thinking about
it" on the source screen; the link carries the instant. WAIT-01…04, A-021's
call-down, A-023's matcher, A-043's opened-up list and A-072's call marks are
all live on a fresh install for the first time.

One correction worth recording, because it nearly became a finding: the first
scripted pass reported the CTA bouncing back to `/staff/opened`, which would
have been a dead sell-the-slot button. It was the script — a `click()` whose
`waitForLoadState` resolved before the navigation. Fetching the href directly
returned 200 on `/staff/waitlist` with the panel rendered. **A walk's own
instrument can manufacture a defect; the direct GET is what settles it.**

## Scene 5 — the room, and whether the screen still tells the truth about it

*Checkpoint 6's property — a slot on the screen is a slot the write path will
accept — re-run for the first time on a book where the room genuinely binds.
Checkpoint 7 ran it over 21,184 offers and found the room never bound once, so
the property was never actually under test.*

Every future day × provider × service, every offered slot put to
`findFreeResource` — the chair chooser the write path itself uses:

```
8 days × 4 providers × 8 services
OFFERED 1,609        OFFERED-BUT-NO-CHAIR 0
excluded 5,383       of which no-resource-free 44

exclusion reasons: overlaps-booking 4,366  inside-break 1,240
                   crosses-window-close 782  overlaps-buffer 109
                   no-resource-free 44
```

**Walked and found clean, and this time the test had teeth.** Forty-four
candidates refused for the room alone — the case checkpoint 6's defect lived in
and checkpoint 7 could not reach — and not one time offered that the chair
chooser then took back. `canSeat` and `findFreeResource` agree on this book.

---

## The finding

**Three screens state a fact about a question nobody asked, and all three are
confident and reassuring rather than blank.**

- The dashboard says **0.0% utilization** where the truth is "not yet worked",
  beside its own count of 157 bookings.
- `/staff/dashboard/overruled` says **"None that week"** where the truth is "no
  week was chosen".
- `/staff/book` says **"That stylist is not on today"** where the truth is "you
  named no stylist".

An empty state that says nothing is a screen a person interrogates. An empty
state that *answers* is a screen a person believes, and every one of these three
answers in the direction that stops the enquiry: the salon is empty, nobody was
let off, she is not in today. This is checkpoint 7's rule about fixtures moved
up a layer — **an assertion over a screen with no data on it is an assertion
over the chrome, and a SENTENCE over a screen with no data on it is a lie the
chrome tells.**

The second half is the one this project keeps re-learning: **A-087 fixed one of
two identical empty states and nothing in the repo knows the other exists.** The
sibling had no spec, and the fix was written from inside the screen that
happened to be on the walk rather than from the shape of the bug.

## What it recorded and did not change

- **The day grid on a closed day renders a full midnight-to-midnight axis** —
  00:00 through 23:00, all four columns "off today" — where an open day renders
  09:00–17:00. On a salon closed Sundays and Mondays that is the first screen
  after sign-in on two days in seven (D-50 lands on `/staff/day`). Cosmetic, but
  it is the product's first impression on 29% of mornings. The **"Book with
  Dana"** button beside "off today" was checked and is *not* a dead end — it
  opens the ordinary booking panel with a "Which day?" control, which is the
  right behaviour and the reason it is recorded here rather than filed.
- **`/staff/design` returns 53 axe `incomplete` results** in both schemes, up
  from A-096's 50. Not violations; gallery-only route; nothing asserts on them.
- **The seed alone is 16.8 s**, so A-095's "~15–18 s" is accurate and the
  120 s hook budget needs no revisiting.
- **The future book is eight working days deep** and then stops until the fixed
  fall-back day on 1 November. Nothing on the walk depended on more, but a
  horizon-related surface would find nothing past 16 September.
- **Every staff route answered in both schemes with no console error** — the
  first walk at which that is true of the dark half as well.

## The rule this leaves behind

**An empty state must not answer a question that was never asked.** Where a
screen's content depends on a parameter, its zero-row message has to distinguish
"you have not told me what to look at" from "I looked and there is nothing" —
`/staff/dashboard/appointments` already does exactly this and is the pattern to
copy. And the corollary, which is why this checkpoint found the same bug A-087
found: **when you fix an empty state, fix the shape, not the screen.** Grep for
the construction — a zero-row branch that does not read the parameter it was
filtered by — because the sibling that has no spec is the one that will still be
lying at the next checkpoint.
