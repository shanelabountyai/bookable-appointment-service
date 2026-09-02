# Operator review — Phase 8 close

**Run 2026-09-02, after A-076 closed Phase 8 and emptied the backlog for the
ninth time.**

Phase 8 was three corrections and one hole, and the corrections were right. The
chair's body now follows the cut (A-074), the push no longer moves a client who
never came (A-075), the way back from a release exists (D-45), and the day
finally closes without lying about when she sat down (A-076/D-46).

**D-46 in particular is the best decision in this log — *nothing derives
attendance from silence* — and the reviewer checked it end to end rather than
taking the word for it.** `dashboard.ts:89`, `lapsed.ts:87`/`:164` and
`reliability.ts:68`/`:140` are the only status-derived readers in the product;
all four still count `completed`/`no_show`/`MISSED_STATUSES` only,
`clientHistory` (`clients/clients.ts:134-149`) shows the raw status per row, and
no timer exists anywhere. **The refusal holds.**

The shape found is the same one, one door further along:

> **A-075 changed what the push MOVES and never told the push's model of what
> the day OCCUPIES — and the proof is inside one function: the provider axis
> asks `PUSHABLE_STATUSES` (`push-column.ts:119`) and the chair axis asks
> `ACTIVE_STATUSES` (`push-column.ts:372`). Two lists for one fact — "who is in
> this column" — in the same file, 253 lines apart.**

That is the new CLAUDE.md rule firing exactly as written: the reader to grep for
was not a reader of the new constant, it was the thing holding its own copy of
the same fact under a different name. And underneath it, a second one:
**A-063 added a third exclusion constraint and never told the error mapper**, so
the sentence D-45 promised the desk ("her time has been sold to somebody else")
is a raw Prisma stack trace on the exact scenario D-45 was written for.

**Three of the five findings were proved by running code, not by reading it.**
Throwaway tests were written against the local test database, run, quoted
verbatim below, and deleted; the tree is clean. Everything else is grep-verified
twice and cited by file:line.

**Verdict: the book is now correct and the desk still cannot get around it.**
The functional holes are closed; what is left is one live crash on the
running-late workflow, one blind error mapper behind eight write paths, and the
fact that nobody has ever seen these screens on a full book — the seeded demo
shows **zero** on every one of them. The most consequential *defect* is finding
1. The most consequential *gap* is now the interface, argued with evidence in §3
rather than as an opinion.

---

## 1. The column push plans against only the rows it is moving, and the rest of the column is invisible to it — S–M, and it is a 500 on Dana's worst hour

Saturday, quarter past twelve. The ten o'clock never came, so there is an empty
hour in Dana's column and she has caught up. The desk does the thing every desk
does with a bought hour: *"pull everyone forward twenty."*

Verified by running it — a 13:00 booked appointment that starts **before**
`fromAt`, and the 14:00 pulled back 30:

```
PULL PREVIEW canPush= true candidates= 2026-06-09T18:30:00.000Z ok
PULL OUTCOME: PrismaClientUnknownRequestError isSlotTaken= false
  | ERROR: conflicting key value violates exclusion constraint
    "appointment_block_no_overlap"
```

And the same root cause the other way, with a terminal row standing in the
middle of the column — she came early, was seen early, and her row still says
15:00:

```
PREVIEW: { "canPush": true, "candidates": [ { "id": "A(booked)", "problem": null } ] }
PUSH OUTCOME: PrismaClientUnknownRequestError name=PrismaClientUnknownRequestError
  code=undefined constraint=undefined isSlotTaken=false has23P01=false
AFTER: A booked 19:00Z | B no_show 20:00Z          ← nothing moved
```

Three independent layers, each of which alone would produce this:

- **`previewPush` selects at `push-column.ts:119-124`** with `PUSHABLE_STATUSES`
  *and* `startAt >= fromAt`. Everything else in Dana's day — the 13:00 that is
  still running, the no-show still occupying its ninety minutes, the visit
  finished early — occupies provider time (D-7) and is simply **not in `rows`**.
  The cascade at `push-column.ts:252-266` builds its `staying` set from
  `rows.filter(r => r.problem)`, i.e. only from the move set, so it cannot see
  any of them. D-26's whole promise — "an appointment left behind still occupies
  its old time" — is true only of appointments the push happened to select.
- **The chair axis already gets this right** (`push-column.ts:372` loads holds
  in `ACTIVE_STATUSES`). One function, two axes, one of them told.
- **`confirmColumnPush` (`apps/web/lib/day/actions.ts:171-174`) catches
  `RangeError` and rethrows everything else** — it has no `SlotTaken` arm at
  all. So even A-034's mapping, if it fired, would still crash the day grid. The
  desk gets an error boundary, nothing has moved, and the feature that exists to
  save the busiest hour of the week has just cost it.

What it needs:

- The planner loads **everything occupying the provider's day in
  `ACTIVE_STATUSES` across the whole affected span** — `min(fromAt, fromAt +
  shift)` to the last shifted end — not just the rows it may move.
- Rows outside the move set enter the cascade as permanently immovable, with
  their own `problem` word, so the preview says *"the 13:00 is still in the
  chair — 14:00 can only come forward to 14:00"* instead of promising a clean
  pull.
- Immovable rows are measured from the **stored `blockedStart`/`blockedEnd`**,
  never re-derived from `endAt + bufferAfter` the way `push-column.ts:229` does
  today — otherwise the fix re-breaks A-069, because a released no-show's cut
  lives in `blockedEnd` and nowhere else. (That line is a second copy of the
  blocked range living inside the planner; it is harmless only because A-075
  removed released rows from the move set.)
- `confirmColumnPush` grows a `SlotTaken` arm with words: *"Somebody booked into
  that time while you were deciding — nothing has moved."*
- A test with a **stationary occupied row on both sides of `fromAt`** — before
  it for a pull-forward, after it for a push. `push-chairs.test.ts` has no such
  fixture and there is no `push-column.test.ts` at all.

**Money/trust, the reviewer's own numbers:** a failed pull-forward is not a lost
booking, it is the desk deciding the push button is broken and moving five
appointments by hand while the phone rings — twenty minutes of the busiest
person in the building, and after the second time nobody presses it again. That
is A-018, A-034, A-059 and A-075 all becoming dead code at once.

**Confidence: high — both halves were run.** Medium on which arrives first in a
real week; the reviewer's money is on the pull-forward, because "we're ahead,
bring everyone up" is said most Saturdays and the +push case needs a client seen
out of order.

## 2. The error mapper knows two constraint names and one error shape; the database has three names and two shapes — S, and it is the sentence D-45 promised

D-45 says it in the decision log: *"the exclusion constraint refuses it the
moment anything has been sold, and the desk is told so IN WORDS."* It is not.
Verified by running D-45's own scene — she no-shows her 10:00 colour, the desk
releases the time, she walks in at 10:35 and **Priya** squeezes her in (Dana's
next client is already in the chair), one chair in the room, so the rebooking is
the same holder in the same chair:

```
REBOOKED chair = the same one chair
UN-RELEASE OUTCOME:  PrismaClientUnknownRequestError | mapped SlotTaken=false
                     | isSlotTakenError=false | has23P01=true
RAWMSG>>> exclusion constraint "appointment_resource_body_no_overlap"
CORRECTION OUTCOME:  PrismaClientUnknownRequestError | mapped SlotTaken=false
```

Both halves of D-45 crash: the un-release (`release-time.ts:261`) and the
APPT-06 correction behind it (`transition.ts:134`). Two causes, both in
`errors.ts`:

- **`OURS` (`errors.ts:65`) lists `appointment_block_no_overlap` and
  `appointment_resource_no_overlap`.** A-063 added a **third** —
  `appointment_resource_body_no_overlap` — and the mapper was never told. The
  message carries `23P01`, the name is not on the list, so `isSlotTakenError`
  returns **false**. The only test that touches it
  (`booking/shared-chair.test.ts:182`) asserts
  `rejects.toThrow(/23P01|appointment_resource_body_no_overlap/)` — it pins the
  *raw* error, which is why nine items went by without anyone noticing the app
  cannot read it.
- **A deferred violation is a different error shape entirely**, and `errors.ts`'s
  header comment was verified only against the immediate one. Same collision,
  two ways:

```
IMMEDIATE  isSlotTaken=true   has23P01=true
           ConnectorError(... PostgresError { code: "23P01", ...
DEFERRED   isSlotTaken=false  has23P01=false
           Error in connector: Error querying the database: ERROR: conflicting
           key value violates exclusion constraint "appointment_block_no_overlap"
```

`push-column.ts:558-560` is the only place that defers, which means
**`push-column.ts:677`'s `isSlotTakenError` catch has never once fired** — the
genuine lost race A-034 wrote it for reaches the desk exactly as raw as it did
before A-034.

Eight call sites share this function: `book.ts:253`, `reschedule.ts:303`,
`change-services.ts:370`, `reassign.ts:155`, `transition.ts:134`,
`release-time.ts:168` and `:261`, `push-column.ts:677`. `reassign.ts` is the
sick-stylist bulk move — the highest-stress event in the business — and a
body-axis refusal there is a 500 on that morning.

What it needs:

- `OURS` derives from one list of our constraint names, in the module that owns
  them, with the three that exist today; and a test that asserts the list
  matches the constraints actually present in the database, the way the status
  predicate already does.
- The message check accepts **the constraint name alone** — the SQLSTATE is
  absent from the deferred form and a name of ours is sufficient evidence on its
  own.
- One test per shape, both provoked for real: an immediate violation and a
  deferred one inside `SET CONSTRAINTS … DEFERRED`.
- While in there: `shared-chair.test.ts:182` stops asserting the raw string and
  asserts the mapped error, which is what the desk actually meets.

**Money/trust:** this is the "never trust a screen that can't explain itself"
rule failing at the one moment it matters — a client standing at the desk being
told nothing, twice, on the two screens built specifically to explain this
refusal in words.

**Build this FIRST** — it is under an hour, and finding 1's error path depends
on it.

**Confidence: high on the mechanism and on all three transcripts.** Medium on
how often the body constraint is reached through `reschedule`/`reassign` rather
than through the release path.

## 3. The interface is now the most consequential gap, said plainly — L, design track

Named twice before and softened twice. Phase 8 closed the last missing
capability, so it is not softened again. The evidence, not the opinion:

- **`apps/web/app/staff/layout.tsx:22-25` renders exactly one piece of
  persistent chrome: the desk-switcher bar.** No navigation. Every route below
  it is an island.
- **`/staff` is thirteen underlined links in a column**
  (`apps/web/app/staff/page.tsx:36-74`). That is the product's menu.
- **`/staff/unfinished` — Phase 8's headline screen — is reachable from exactly
  one place**, the day toolbar, and the badge **hides at zero**
  (`day/page.tsx:175-186`). The hiding is right. The consequence is that a desk
  that has never seen the badge does not know the screen exists, and there is no
  other door.
- **The phone still rings and there is still no route to a client from the
  day.** The toolbar is Walk-in, Anyone, Conflicts, Call-down, Print sheet,
  Opened up, Still open — no client search. "It's Mrs Kerr, can I move Thursday"
  is day grid → `/staff` → Clients → search, while she waits.
- The design brief already has this right (`01-design-brief.md:106`, §5.5) and
  this review will not duplicate it. Two things to fold in: **`/staff/unfinished`
  is missing from the brief's own surface inventory** because it was built after
  the brief, and the shell's badge list needs a third count, *Still open (N)*.

**Money/trust:** nothing here loses a booking. It loses the staff, which is
worse and slower. Four people sharing a terminal learn a product by finding
things; a product with no shell is learned by one person and worked around by
three, and the workaround is the paper book.

**Confidence: high on every fact above.** Medium on ranking it above finding 4 —
an operator who has just been crashed by finding 1 would put it lower.

## 4. Closing a `checked_in` visit on Monday writes a Monday finish time — S, plus a decision (OQ-20)

D-46 is emphatic and correct: a `completed` reached from `booked` or `confirmed`
leaves both timestamps NULL, *"because a missing timestamp is honest and a
Monday-morning one is a lie in the audit trail."*

`transition.ts:330` then reads:

```ts
return from === 'checked_in' || from === 'in_progress' ? { endedAt: now } : {};
```

And `/staff/unfinished` exists precisely to close **`checked_in` rows in bulk,
days later** — its own row copy calls that the confident case
(`unfinished/page.tsx:97-100`). So the primary path through Phase 8's new screen
writes exactly the lie D-46 refused: `checkedInAt` Saturday 14:15, `endedAt`
Monday 09:40, and the panel renders "Finished: Monday 09:40" against a Saturday
appointment. The visit reads as forty-three hours long in the one record that is
meant to answer "when did this actually happen".

**The rule was written for the *transition*, when it is a rule about the
*clock*:** `now` is only a measurement while the visit is still plausibly
happening.

What it needs:

- `endedAt` is stamped from `checked_in`/`in_progress` **only when `now` is
  still near the visit** — the same shape as the existing staleness rules, not a
  new concept.
- Beyond that bound it stays NULL, exactly as the two new edges do, and the
  event still records who closed it and when.
- A test that closes a `checked_in` row three days later and asserts `endedAt`
  is null while `checkedInAt` is untouched — the check-in time is a real
  measurement and must survive.

**Decision first (OQ-20): what is "still near the visit"?** (a) `now <= endAt +
one hour`; (b) same business day as `startDay`; (c) leave it, and accept the
Monday timestamp as the cost of one tap. The reviewer leans (a) and did not pick
it inside the item.

**Money/trust:** small in dollars. It matters because APPT-03's
actual-vs-scheduled split is what the running-late feature is built on, and a
screen that generates false finish times at eleven rows a week poisons the only
data that could ever tell the owner how long her colourist's colours really
take.

**Confidence: high on the code path. Medium on the harm size** — no report reads
`endedAt` today; the harm is the record and the panel.

## 5. Nobody has ever seen these screens on a full book, and the 21-day lookback is the only door — S–M, decision attached (OQ-21)

Two facts, measured against a freshly reset and seeded database:

```
TODAY                       : 2026-09-02
unfinished NOW              : 0
opened up                   : 0
on today's book             : 0
unfinished as-if 2026-06-15 : 166   by status {"booked":166}   value $3680.00
WHOLE SEEDED BOOK           : booked=179 completed=43 no_show=3 cancelled_late=2
PAST + STILL OPEN, any age  : 176
SEEDED DAYS: 2026-02-10:1 2026-03-08:10 2026-03-17:1 2026-04-21:1
             2026-06-09:52 2026-06-10:83 2026-06-11:44 2026-06-12:17
             2026-06-13:15 2026-11-01:3
```

**(a) The demo is dark.** The seed anchors to a fixed constant
(`density-seed.ts:28`, correctly — a `now`-anchored seed makes the DST fixtures
vanish in July). Twelve weeks later the entire book is in the past: today's grid
is empty, "Opened up" is zero, "Still open" is zero, and every date-relative
surface built in Phases 6–8 renders its empty state. The e2e specs pass because
`e2e/fixtures.ts` TRUNCATEs and seeds its own rows — this is CLAUDE.md's own
"dormant on a fresh install" trap wearing a demo hat, and it means **no human
has ever looked at `/staff/unfinished`, `/staff/opened` or the day grid against
227 appointments.** For a build whose whole purpose is judgement about density
and a busy Saturday, that is the most expensive thing on this page after finding
1.

**(b) 176 past appointments are open, the screen offers 0 of them, and after 21
days there is no list at all.** `UNFINISHED_LOOKBACK_DAYS = 21`
(`unfinished.ts:49`) is a sensible desk bound. But D-46's entire argument is
*"the reports become right because they are being told the truth"* — and the
only surface that lets the desk tell it goes blind at day 22, permanently. A
fortnight's holiday, a broken week, or three weeks of not knowing the screen
existed, and those rows are wrong in `dashboard.ts`, `lapsed.ts` and
`reliability.ts` forever.

What it needs:

- **The seed grows a demo week anchored near `now` as well as the fixed DST
  days** — the DST fixtures stay exactly where they are, and both idempotence
  rules hold. Include a handful of deliberately unclosed past rows and a
  released no-show, so the two Phase 7–8 features are visible on a fresh install
  rather than dormant.
- The unfinished list keeps its 21-day default and gains **one control** — the
  same shape as the lapsed report's `weeks`.
- No auto-anything. D-46 stands.

**Decision (OQ-21): what happens to rows older than the window?** (a) a
widen-the-window control on the page; (b) an "older than three weeks" collapsed
section, always present; (c) nothing. The reviewer leans (a) — cheapest, and it
matches A-073.

**Confidence: high on both measurements — they were run.** Medium on how much
the demo half matters to this project's goals.

---

## What Phase 8 left behind that is load-bearing

Almost nothing, and that is a change worth noting: A-074, A-075 and A-077 all
recorded "nothing new", truthfully. Two items only:

- **A-076's "no bulk close-out"** is correctly sized and correctly deferred.
  It stops being true if finding 5(b) lands and somebody opens a three-week
  backlog; revisit then, not now.
- **`dashboard.ts:89` hand-types `status: { in: ['completed', 'no_show'] }`**
  instead of deriving it from the status module — the only status list in the
  product typed out at its call site. Right today, and the one that will be
  wrong when a ninth status arrives. One constant, next time the file is open.

## What NOT to build

- **Do not add a timer, a job, or a derivation to fix finding 5.** D-46 is the
  best decision in the log; 176 unclosed rows is an argument for a wider door,
  never for a guess.
- **Do not make `previewPush` a separate "check" function** to fix finding 1. It
  is right that the preview and the push share one selector; the bug is that the
  selector is not the occupancy model, and both should read the wider one.
- **Do not put the unfinished list on `/staff/dashboard`.** It is a desk errand.
- **Do not re-anchor the seed to `now`** to fix finding 5(a). The fixed anchor is
  why the DST tests exist in September; add a second, rolling week beside it.
- **Do not re-open D-7, D-44, D-45 or D-46.**
- **Everything on the Phase 6 and Phase 7 do-not-build lists stands unchanged.**
- **A-053 stays blocked.** All five findings were scoped so they need no real
  channel.

## The process note

The rule added at the Phase 7 close worked — it just was not applied to the item
that added a *list* rather than a *column*:

> When a new column changes what a range means, grep for everything that stores
> or derives the same fact under a different name.

A-075 added no column. It added `PUSHABLE_STATUSES`, and the fact under a
different name was `ACTIVE_STATUSES`, sitting 253 lines below it **in the same
function**. The generalisation:

> **A narrower list is a new fact.** `PUSHABLE_STATUSES` answers "whose time may
> this action move"; `ACTIVE_STATUSES` answers "whose time is occupied". The
> moment those stop being the same set, every reader that used one as a stand-in
> for the other is wrong — and the compiler cannot see it, because both are
> lists of the same type.

And the cheaper habit underneath it, which is A-074's lesson repeating: **A-063
added a third exclusion constraint and the error mapper still knows two.** The
status enum has a migration test comparing the live constraint predicate against
the TypeScript list. The constraint *names* have nothing equivalent — so the
database grew an invariant the application cannot read, and the only test that
touched it asserted the raw error string, which is a test written from the
outside of a bug rather than from the inside of a workflow.
