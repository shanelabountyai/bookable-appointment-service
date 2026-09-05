# Demo checkpoint 7 — the walk through the new shell

**Walked 2026-09-04, at the Phase 10 boundary — the first walk since A-085 put
one persistent nav row on every staff screen.**
**Result: one defect, found twice in one afternoon, in two unrelated files, for
the same reason. Every axe run in this suite has looked at an empty screen.**

Checkpoints 1–6 each found a defect sitting inside an item already marked ✅
and invisible from within the item that introduced it. Checkpoint 6 needed a
busy room to see anything at all. This one needed a **worked** book: a day the
desk has been through, rather than a day with an appointment on it.

Four scenes, named by A-087's own row and chosen at the seams between items.
The walk was partly clicked (Playwright against a production build on the
seeded density book) and partly scripted; the scripts have been deleted, and
what they found lives on as three fixes and four assertions.

---

## The book it was walked on

`db:reset:test` — `seedSetup` then `seedDensity`, the demo install:

```
4 providers   8 services   8 clients   453 appointments   4 chairs
book: booked 339  completed 85  checked_in 22  no_show 4  cancelled 1  cancelled_late 2
shell after sign-in:  Day | Opened up 1 | Still open 43 | Waitlist
                      Call-down | Conflicts | Messages ‖ Dashboard | Setup
landed on /staff/day, not /staff  (D-50)
```

Twenty-five staff routes crawled at 1024×768: **every one 200, the shell on
every one, no console error and no page error anywhere.** Axe clean on
twenty-three of the twenty-five. The two it was not clean on are the finding.

---

## Scene 1 — the six-o'clock close-out

*Does the desk find `/staff/unfinished` without the badge?* Before A-085 that
screen had one door, behind a number that hid at zero.

```
shell:  "Still open 43"   →  /staff/unfinished  →  43 rows
badge == list, exactly, and the door is there at zero as well  (D-50)
```

**Walked and found clean.** The count in the chrome and the list on the screen
are one query with one `where` (`unfinishedWhere`), which is what makes that
equality structural rather than lucky.

One thing recorded rather than fixed: the list is `startAt asc`, so a desk
closing out at six lands on rows from three weeks ago and scrolls to reach
tonight. Defensible either way — clearing oldest-first is how a backlog is
meant to be worked — and it is a product decision, not a defect, so it is
written down here and not changed on a walk.

## Scene 2 — the phone call about Mrs Kerr

*Client from the day, in one hop.* §5.5's headline gap: this used to be day
grid → `/staff` → Clients → search, while she waited.

```
/staff/day → type "Dunn" in the shell → /staff/clients?q=Dunn
   Ellie Dunn  +15125550107
   Marcy Dunn  +15125550107      ← D-17's household, both of them, one number
"0107" finds the same two.
```

The shell's box does what it was built for. **But the other half of the scene
does not**, and only a walk could say so: the desk usually has her chip on the
screen already, taps it, and lands on the appointment. On that page the client's
name is an `<h1>` and **the only link to her record was the reliability flag**,
which renders only when she has a black mark against her:

```
/staff/appointments/<id>  → links to /staff/clients/… :
   ["⚑ 1 late cancel in the last 12 months"]
```

So the client with nothing on her record — most of them — had no door at all,
and the way through was to retype a name the screen was already showing. The
flag's guard is correct in itself (an empty link is invisible to the eye and
announced as a link with no name); the consequence is that the door was
attached to the wrong thing. **Fixed:** her name is the link when there is a
record behind it, `Walk-in, no name` stays plain text when there is not.

## Scene 3 — the freed-Saturday sale

*`/staff/opened` → waitlist → book.* This is the scene that could not be walked.

```
/staff/opened      Saturday 5 September 09:30 · 15 min
                   Fringe trim · Dana
                   Cancelled by Sam Okafor · +15125550103
                   [Who wants this slot?]
        ↓
/staff/waitlist?providerId=…&serviceId=…&at=…&minutes=15&key=cancelled:…
                   "Nobody on the waitlist fits this one."
                   WAITING (0)
```

On the demo install:

```
WaitlistEntry 0   ClientCallMark 0   CallDownAttempt 0
AdHocBlock 0      ProviderRunningLate 0
```

**The whole sell-the-freed-slot loop is dark on a fresh install.** WAIT-01 to
WAIT-04, A-021's call-down, A-023's matcher, A-043's opened-up list and A-072's
call marks all render their empty state on a book with 453 appointments in it —
and A-081's own header is the argument for why that matters: *"twelve weeks past
`SEED_ANCHOR_DAY` … every date-relative surface rendered its EMPTY STATE on a
freshly seeded database … that is CLAUDE.md's 'dormant on a fresh install' trap
wearing a demo hat."* A-081 fixed the surfaces it measured. The waitlist was not
one of them, and it is the one screen whose entire subject is money the salon
would otherwise lose.

Two more shapes of the same gap, from the same read:

- **Two of the four columns are empty from today onwards.** `seedDensity`'s
  `now`-anchored book fills Dana at 0.7 and Priya at 0.4 and nobody else; Marcus
  and Tess appear only in the fixed `DEMO_WEEK`, which is now three months past.
  Future book: **Dana 108, Priya 35, Marcus 0, Tess 0.**
- **The room therefore never binds.** Across the whole seeded book, on every
  single day, the number of distinct chairs in use is exactly the number of
  stylists working — chair assignment is a shadow of the provider axis. Read-only
  over the future book: **21,184 offers, 0 that the write would refuse, 0
  candidates refused for `no-resource-free` at all.** Checkpoint 6's defect, and
  A-063's shared chair, and RES-04's override, are all unreachable from a demo
  nobody has booked into.

Not fixed here. `seedDensity` is pinned by an idempotence test that compares
every column of every table and by A-024's exact utilization constant over
`DEMO_WEEK`; widening it is an item, not a ride-along. Written into the backlog
as one.

## Scene 4 — a Saturday afternoon add-on for a client already in a chair

A-083's fix, on a real book rather than the two-chair fixture it was written
against. Checkpoint 6's property, re-run: *a slot on the screen is a slot the
write path will accept.*

Fuzzed in two rounds with a staggering pass between them, because checkpoint 6
established that **something has to MOVE** before chairs fragment — bookings
alone cannot reach a staggered room:

```
round 1   offered 141   booked 141   REFUSED 0
stagger   116 visits shifted 15-25 min earlier, 8 accepted
          chairs in use per day: 2 → 4 on every day of the book
round 2   anonymous   offered 40   booked 40   REFUSED 0
          with holder offered 20   booked 20   REFUSED 0
                                   ─────────────────────────
                        total      201 offers, 201 booked, 0 refused
```

And the holder's own half, which is what A-083 is actually for — the offer must
be no *stricter* than the write once the desk has named her:

```
1,288 anon-vs-holder comparisons over the full book
   3 slots WIDENED by naming the client, all 3 accepted by the write
   0 slots narrowed
```

**Walked and found clean, in both directions.** Three real add-ons a desk could
sell that the anonymous question refuses, and not one time offered that the
room then took back.

---

## The finding

**`/staff/day` and `/staff/clients/[id]` both fail WCAG AA on a real book, and
the axe run that covers each of them is green — because each renders a screen
with no data on it.**

### The day grid, on a day that has been worked

```
<span class="block truncate opacity-80">Cut & finish · +15125550103</span>
  light   #72727b on #f4f4f5 = 4.33:1     (needs 4.5:1 at 12px)
  dark    #878790 on #27272a = 4.18:1
  six chips on the first screenful; every closed-out visit in the salon
```

Three decisions, each defensible alone, and their product is the defect.
`completed` paints a **darker ground** (`bg-zinc-100`). It also paints a
**lighter ink** (`text-zinc-600`) — 7.0:1 on that ground, correct. And then the
chip's detail line multiplied that ink by **0.8**.

**A-088's contrast guarantee is a computed one, and an opacity is the same fact
written a second time under another name.** `tokens.test.ts` reads each token
and asserts it against its own ground at its real bar, precisely so a contrast
number in a comment cannot rot. `opacity-80` changes the colour the eye receives
without changing the token, so every contrast assertion in the repo still
passes — and the product it renders exists only in the compositor, where nothing
in this repo was looking. That is this project's most-found defect shape (A-069's
`bodyStart`, A-078's constraint names, A-086's status pair) one layer down: **a
fact proven in one place and silently re-derived in another.**

**Why the suite could not see it.** `day-grid.spec.ts` runs axe on this exact
page, twice, and is green. It seeds **one** appointment and it is `booked`,
whose ground is `bg-white` — where the same 0.8 lands on **4.66:1** and passes
by a hundredth of a point. The violation needs a chip somebody has closed out,
which is what an evening's book is made of and what no fixture had ever
rendered.

### The client record, on a client who has been in before

```
<h3 class="… text-zinc-400">Upcoming</h3>   #9f9fa9 on #ffffff = 2.62:1
<h3 class="… text-zinc-400">Past</h3>       same
```

Same rule, different file, found ten minutes later. `clients.spec.ts`'s axe test
searches for Ada Chen and opens her record — **a client the spec creates and
never books.** Neither heading renders until she has a future visit (`Past` is
guarded on `upcoming.length > 0`), so the axe run measured the chrome.

### And the half of the palette nothing has ever rendered

Playwright's default colour scheme is light, and no spec in this suite has ever
changed it. So on a palette built to flip with `prefers-color-scheme`, **half
of it has never been measured.** Emulating dark over the seeded book:

```
dark  /staff/day                 6 nodes   (the chip, above)
dark  /staff/clients/<id>       124 nodes  (text-zinc-500 on #0a0a0a = 4.1:1)
dark  /staff/appointments/<id>    2 nodes
dark  /staff/dashboard/appointments  2 nodes
```

The 124 are not this item's defect: they are the raw-zinc debt A-090 to A-094
exist to retire, and **one value repeated** — `text-zinc-500` is 4.6:1 on white
and 4.1:1 on `#0a0a0a`, so it passes in the scheme every axe run had ever
rendered and fails in the other. What *is* this item's business is that nobody
knew the number, because nothing had ever asked. The day grid — the one screen
this walk repaired — now asserts **both schemes**, its seven `text-zinc-500`
uses are swept onto the house muted idiom, and the rest is written into the
backlog with the measurement attached.

**Two things the dark assertion cost on the way in, both worth recording.**

- **`emulateMedia` alone is not a scheme change, it is a scheme change in
  flight.** Switching the media query on a live page leaves every control
  mid-`transition-colors` — A-089's primitives animate on purpose — and axe
  sampled the blend: **583 nodes** of colours like `#b4b4b4 on #5d5d5f`, which
  exist for 150 ms and belong to neither scheme. The assertion reloads.
- **The one real dark failure it then found was `<p>Not today.</p>`** — which
  renders only when the desk is looking at a day that is not today, and my own
  read-only sweep had measured `/staff/day` dark as clean because every page I
  loaded was today's. **The finding caught me writing it.** So the sweep is all
  seven of the day surfaces' quiet-text uses, not the one the fixture happened
  to render — fixing only that one is the defect this checkpoint is about,
  performed on the fix for it.

---

## What it changed

- **`day-grid.tsx`** — `opacity-80` off the chip's detail line and its visit
  note. Weight already separates them from the title above; the ✎ glyph already
  separates the note from the pinned one. Same removal on
  `column-controls.tsx`'s struck-through scheduled time (12px mono, on a card
  nobody has ever run axe over with a late column on it) and on
  `people-list.tsx`'s inactive row, which dimmed a person's name with it and
  says *"· off the roster"* in words regardless.
- **`clients/[id]/page.tsx`** — the two section headings onto the house muted
  idiom (`text-zinc-600 dark:text-zinc-400`), which is 7.0:1 and 8.9:1. The same
  swap over all seven bare `text-zinc-500` uses in the day surfaces, so the new
  dark assertion covers the states this fixture does not happen to render.
- **`packages/design/opacity.test.ts`** — no unprefixed `opacity-*` anywhere
  under `app/staff`, directory walked rather than listed. `disabled:` and
  `hover:` variants are allowed, and the exemption is WCAG's own: 1.4.3 does not
  apply to disabled controls. Verified by mutation — putting `opacity-80` back
  fails it.
- **`day-grid.spec.ts`** — the axe fixture now seeds one chip of every status
  that repaints the chip (`booked`, `completed`, `cancelled`, `no_show`),
  asserts the detail line is actually on the page so the fixture cannot go quiet,
  and runs axe **in both colour schemes**.
- **`clients.spec.ts`** — the axe fixture gives her one visit behind and one
  ahead, and asserts both headings are visible before measuring.
- **`appointments/[id]/page.tsx`** — her name is the door to her record.
- **`dashboard/appointments/page.tsx`** — reached with no week, it said
  *"0 appointments · Nothing matches this filter"* on a full book, which reads as
  a salon with no appointments in it. It now says *"Pick a week from the
  dashboard."*, which is what `overruled` next door has always said.

## What it recorded and did not change

- **The demo book has no waitlist, no call marks and no call-down attempts**,
  and two of its four columns are empty from today onwards — so the room axis
  never binds and the freed-slot loop is dark on a fresh install. Backlog.
- **`/staff/unfinished` is oldest-first**, so the six-o'clock errand is at the
  bottom of the list.
- **Three seeded `no_show` rows hold no chair and no time** — raw inserts with
  `blockedStart = blockedEnd = 'epoch'`, deliberate, in the past, and documented
  in the seed. They exist to give one client a CLIENT-04 history. Harmless, and
  worth knowing about before somebody reads them as a D-7 violation.
- **Every staff page costs about 570 ms**, uniformly, including the ones with
  almost nothing of their own — the shell's three queries, one of them
  per-candidate over a fortnight. That is the ceiling A-085's own `ponytail:`
  comment named, now with a number against it.
- **The shell at tablet landscape**: 113 px of nav, 150 px of chrome before the
  grid starts, and no horizontal overflow at 768, 1024 or 1440.

## The rule this leaves behind

**An accessibility assertion over a screen with no data on it is an assertion
over the chrome.** Both instances here were green tests on pages that fail; both
fixtures were written by the item that built the screen, which is exactly when
nobody has a real book to hand. The fix is not to run axe harder — it already
ran, twice, on both pages. It is that **the fixture under an axe run has to
contain the states the screen actually renders**: every status that repaints the
element, every section that is guarded on data existing, and both colour schemes.
