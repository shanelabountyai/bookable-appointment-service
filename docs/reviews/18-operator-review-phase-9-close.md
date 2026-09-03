# Operator review — Phase 9 close

**Run 2026-09-02, after A-082 closed Phase 9 and emptied the backlog for the
tenth time.**

Phase 9 was two live crashes, two decisions and a walk, and every one of them
landed. The error mapper knows all three constraint names and both error shapes
(A-078). The push plans against the whole column instead of only the rows it is
moving (A-079). `now` stops being a measurement two hours past `endAt` (D-47),
and the only door to fixing the numbers opens as wide as the owner types
(D-48). Then checkpoint 6 found the one that needed a busy room to exist at
all: the room's read model and the room's chooser had been asking different
questions since A-032, and `canSeat` now mirrors `findFreeResource` line for
line.

**The fix in A-082 is the best structural work in the log** — a cardinality
collapsed into busy intervals was the wrong *shape*, and it was deleted rather
than corrected. `computeSlotsIn` is now the only way to run the engine on a
built query, and the reviewer checked that claim rather than taking it: seven
offering surfaces route through it, including two A-082 did not name (the
walk-in list, `walk-in.ts:53`, and "anyone", `any-provider.ts:86`). Nothing
calls the pure `computeSlots` except the adapter.

The shape found this time is the same one, one door further along, and it is
inside the fix itself:

> **A-082 gave the room's question an input — WHO would be sitting in the chair
> — and threaded it through every path where the APPOINTMENT already exists
> (`reschedule.ts:449`, `change-services.ts:430`, `book.ts:208`/`:518`). It was
> not threaded through the two paths where the CLIENT exists and the
> appointment does not yet: `staffSlotsFor` and `anyoneTimesFor`, the desk's
> own booking panel. `null` is the strict question, and the desk is now asking
> it about a client it has already named on the same page, five lines below
> where it looked her up.**

The consequence is A-082's defect with the sign flipped: the offer is now
*stricter* than the write, and the desk's only way through is a BOOK-05
override — which, by D-30, holds **no chair at all**. So the workaround does
not merely mislabel an ordinary booking; it puts a real client in a real chair
that the room believes is empty, and the next offer is computed against a room
that is wrong.

**Two of the four findings were proved by RUNNING code** against the local
test database; transcripts are quoted verbatim below and the throwaway tests
were deleted (the tree is clean). Two more hypotheses were tested the same way
and came back CLEAN — they are recorded in §5 because a measured "no" is worth
as much here as a measured "yes".

**Verdict: the book is correct, the room is correct, and the desk still has no
building to walk around in.** The most consequential *defect* is finding 1 and
it is an hour's work. The most consequential *gap* is the interface, named for
the fourth time — §2 stops arguing for it and asks for a decision instead.

---

## 1. The desk names the client, and then asks the room the anonymous question — S, and it is A-082's own fix with the sign flipped

`canSeat` takes `holderKey` because A-063 lets one client's own overlapping
envelopes share a chair: her cut's after-buffer and her colour's before-buffer
are two holds on one chair, and the room must not count them as two. `null`
means "nobody has said who she is", which makes the first arm match every row —
the strict question, and the right one for an anonymous visitor.

**The staff booking panel passes `null`.** Both of its list actions do:

- `staff-actions.ts:399-406` — `staffSlotsFor(providerId, serviceIds, day)`
  calls `computeDaySlots` with `audience: 'staff'` and no holder.
- `staff-actions.ts:467-474` — `anyoneTimesFor(serviceIds, day)` calls
  `anyProviderTimes`, whose argument type (`any-provider.ts:61-70`) has no
  client field at all, so the "anyone" path cannot pass one even if its caller
  wanted to.

And the client is not merely knowable — she is already resolved, in scope, on
the same page:

```
app/staff/book/page.tsx:91   const prefillClient = requestedClientId ? await resolvePrefillClient(...) : null;
app/staff/book/page.tsx:95   const initialSlots =
app/staff/book/page.tsx:96     !walkIn && provider && prefillServiceIds.length > 0 ? await staffSlotsFor(provider.id, prefillServiceIds, day) : [];
```

Five lines. `booking-panel.tsx` has the same pair at runtime: the chosen client
is state (`:105`) and the two re-list calls (`:158`, `:168`) do not read it.
The route into this is `/staff/clients/[id]` → "book her again"
(`clients/[id]/page.tsx:140`), which is the desk's normal rebooking path and
the one where the client is certain.

**Proved by running it.** Two chairs active, Nadia's cut with Dana at 13:00
(envelope 13:00–13:55, her chair), Ben's cut with Marcus at 13:30 (the other
chair), then the panel asked for her colour with Priya:

```
13:45 offered without a holder: false [ 'no-resource-free' ]
13:45 offered with her holder : true
the write accepted it        : true
slots offered anonymously 9, with her holder 11
```

Two of eleven offers withheld, and the write takes the withheld one without
complaint. What the desk is told is `scheduling-words.ts:25` — *"every chair is
taken then — she is free, the room is not"* — about a chair that is hers and
that nobody else is in.

**Why the workaround is worse than the refusal.** The refused candidate is
still tappable (A-042), and `staff-actions.ts:348-355` offers the RES-04
override on `NoResourceFree` precisely so "we'll do her at the backwash" is
sayable. Taking it here is a lie in both directions: it marks an ordinary
booking as a deliberate double-book, which is what makes the override marker
meaningless (the panel's own comment at `staff-actions.ts:389` says so about a
different case), and by D-30 an override **holds no chair**. The room then has
a client sitting in it that it cannot see, and every subsequent `canSeat` on
that day is computed against a room with a phantom empty chair. One wrongly
refused offer becomes one appointment invisible to the room.

**Money/trust:** small and precisely aimed. It bites when the room is otherwise
full at that instant, which is Saturday afternoon, and it bites on the client
who is *already in the building* — the add-on sale, which is the highest-margin
thing a salon does.

**Size S.** `staffSlotsFor` and `anyoneTimesFor` take an optional client id;
`anyProviderTimes` gains the parameter it never had and hands it to
`computeDaySlots`; the panel re-lists when the client changes. The regression
test is the transcript above, and it must be written as an AGREEMENT test — the
same offer computed twice and compared against what the write accepts — not as
two separate assertions, which is checkpoint 6's whole lesson.

**Confidence: high.** Reproduced, and the code path is four greps wide.

## 2. The interface, for the fourth time — L, and this time it needs a decision rather than another argument

Named at the Phase 6 close, the Phase 7 close, and plainly at the Phase 8 close
("the most consequential *gap*"). Phase 9 shipped five items and none of them
was this, for a defensible reason each time: a live 500 on the running-late
workflow outranks a menu. That reason is now exhausted — Phase 9's defects are
closed and finding 1 is an hour.

The facts, re-verified today rather than copied forward:

- **`app/staff/layout.tsx:22-27` still renders exactly one piece of persistent
  chrome**, the desk-switcher bar. Every route below it is an island.
- **`/staff` is twelve links in a column** (`staff/page.tsx:36-74`). That is
  the product's menu, and it names twelve of the twenty-three staff routes.
- **Inbound-link count for the desk's own screens**, counted across `app/`,
  `components/` and `lib/`:

| Screen | Doors into it | From |
|---|---|---|
| `/staff/unfinished` | **1** | the day toolbar, badge hidden at zero (`day/page.tsx:175-186`) |
| `/staff/opened` | 2 | the day toolbar, and one appointment's status controls |
| `/staff/conflicts` | 2 | the day toolbar, the availability screen |
| `/staff/waitlist` | 1 | `/staff` |
| `/staff/messages` | 1 | `/staff` |
| `/staff/clients` | 1 | `/staff` |

  Phase 8's headline screen has one door, behind a badge that is correctly
  invisible on a good day. A desk that has never had an unfinished appointment
  does not know the screen exists.
- **There is still no route to a client from the day**, and the phone still
  rings. "It's Mrs Kerr, can I move Thursday" is day grid → `/staff` → Clients
  → search, while she waits.

The design brief already specifies the answer — `01-design-brief.md` §5.5 names
the three badges (*Opened up*, *Still open*, failed messages), says the day
grid is the home screen in practice, and forbids a hamburger. §6's surface
inventory is current. **What is missing is not a specification, it is a
decision about whether to wait for the design pass the brief was written for.**

Recorded as **OQ-22**, to be answered as a D-number before the row is written:

> Does the staff shell wait for the design deliverable (§5.5 is a brief
> addressed to a designer), or does it ship now — plain, using the tokens and
> primitives that exist — and get restyled when the design lands?

**The reviewer's recommendation is to ship it now.** Everything §5.5 asks for
is a `<nav>`, three counts and a search box; none of it is blocked on a token
layer, and the desk is not waiting for a colour palette, it is waiting for
doors. A shell built plain is also the honest input to the design pass: the
designer restyles something real instead of specifying against a screenshot.

**Money/trust:** nothing here loses a booking. It loses the staff, which is
worse and slower — four people sharing a terminal learn a product by finding
things, and what they cannot find they work around on paper.

## 3. The room's rule now lives in three places, and only two of them are pinned together — S

A-063 made the chair invariant two questions (envelopes may overlap for one
holder; bodies never overlap for anyone), and A-082 made the OFFER ask exactly
what the CHOOSER asks. Both of those mirrorings are deliberate and both are
commented as such. There is a third copy:

| Where | Written as | Reads |
|---|---|---|
| `booking/resources.ts:42-110` | a Prisma `where` | the chooser — what the write ACCEPTS |
| `scheduling/resource-load.ts:106-125` | a predicate over `ChairHold` | the offer — what the screen SHOWS |
| `day/push-column.ts:592-596` | a predicate over the push's own row shape | the planner — where the push SEATS the column |

The push's form is not the same expression:

```
push-column.ts:595   overlaps(envelope, held) && (held.holderKey !== holderKey || overlaps(body, held.body))
resource-load.ts:119 (hold.start < envelope.end && hold.end > envelope.start && hold.holderKey !== key)
                     || (hold.bodyStart < body.end && hold.bodyEnd > body.start)
```

`E && (D || B)` versus `(E && D) || B`. They agree **only** where `B` implies
`E` — where a body overlap cannot happen without an envelope overlap — and that
is true today because the hold trigger keeps the body inside the envelope,
including on the release branch that cuts `bodyEnd` to `releasedAt`
(`20260902020000_release_cuts_the_chair/migration.sql`) with a CHECK keeping
`releasedAt` inside the visit. So the three copies agree by virtue of an
invariant maintained in SQL, in a third file, asserted nowhere in TypeScript.

This is not a live defect and is not being reported as one. It is the exact
precondition of checkpoint 6: two correct-looking halves of one operational
question, each tested alone, agreeing for a reason nobody wrote down. The
cheap fix is the one A-082 already chose once — **one predicate, three callers**
(the push's row shape maps to `ChairHold` in four fields), plus one test that
puts a room in a state and asserts all three answers are equal.

**Confidence: high on the facts, medium on the priority.** It buys no feature.
It is on this list because the last three phases each spent an item on a
disagreement between two models of the same fact, and this is the only one
still standing that we can see from here.

## 4. `dashboard.ts:88` is the last hand-typed status list — XS, and it was flagged a phase ago

The Phase 8 close recorded it as *"one constant, next time the file is open"*.
Phase 9 never opened the file, so it is still there:

```
reports/dashboard.ts:87-91   status: { in: ['completed', 'no_show'] },
```

Every other status reader in the product derives from the status module —
`lapsed.ts` uses `MISSED_STATUSES`, `opened.ts:202` uses `SLOT_FREEING_STATUSES`
and says why, `resources.ts:91` uses `ACTIVE_STATUSES`. This one is right today
and is the one that will be wrong when a ninth status arrives, which is
CLAUDE.md's first structural rule. It is two lines and it should ride along with
whatever item opens the reports directory next; if nothing does, it is its own
five-minute row.

## 5. Tested and CLEAN — recorded because a measured "no" is worth the same as a measured "yes"

- **The public picker's cost on a full book.** A-082 left `canSeat` as
  O(chairs × holds) per candidate and flagged it as the number to watch.
  Measured against a freshly seeded and density-loaded book (411 appointments):
  `anyProviderDays` over **60 days × 4 providers = 549 ms**; the flow's real
  horizon is 28 days (`public-actions.ts:65`). One provider-day is 6 ms, one
  "anyone" day 13 ms. **Nothing to do.** Revisit at fifty chairs, not before.
- **Does the public flow dead-end on a busy book?** `booking-flow.tsx:260`
  ("No appointments available in the next few weeks. Please call us.") and
  `manage/[token]/reschedule-form.tsx:42` are dead ends with no capture — a
  client who finds nothing is gone, and the waitlist that would have caught her
  has exactly one door, `/staff/waitlist`'s entry form, which is staff-only.
  So the question is whether the dead end is reachable. Measured over the
  seeded book: **28 qualified (service, stylist) pairs, zero dead ends** in the
  next 28 days; "anyone" offers 20 of 29 days for every service, and the nine
  dark days are the salon's closed Sundays and Mondays. **The dead end is not
  reachable on anything we can currently demo**, so a self-serve waitlist is
  an opinion, not a finding. It is on the do-not-build list below with the
  condition that would change that.
- **D-47's containment.** `isVisitMeasurable` (`core/scheduling/transitions.ts:60`)
  has exactly one caller (`transition.ts:220`), and `checkedInAt`/`startedAt`/
  `endedAt` are written in exactly one function (`transition.ts:330-358`). No
  second path stamps them; no report reads them. The rule cannot be bypassed.
- **The running-late delta after a push.** CLAUDE.md still lists A-018's
  standing delta among the Phase 6 state-change misses. It was closed by D-43:
  `push-column.ts:455-460` computes `runningLateAfter` via `deltaAfterPush`,
  `:790-796` writes it through `setRunningLate`, and `lib/day/actions.ts:200-207`
  says it out loud. **The trap note is now out of date on that clause.**

## What Phase 9 left behind that is load-bearing

- **A-079's bystander model** — a staying row is one envelope where the
  constraint is really over its `AppointmentBlock` rows, so a colour's
  processing gap reads as occupied and a legal push into it is refused as
  `blocked-by-one-that-stays`. Marked `ponytail:`, conservative in the safe
  direction, and correct to leave. It becomes worth fixing the first time a
  desk says "there is obviously room, why won't it move".
- **A-081's widened list is not paginated.** 730 days on a real book is a very
  long page. Unchanged from its own note; still not worth code.
- **`seedDensity` is now `now`-dependent by construction.** Any future test
  that seeds density and asserts a count must freeze `now`. This is the kind of
  fact that costs an afternoon when it is rediscovered rather than read.
- **A-053 stays blocked.** All four findings were scoped so they need no real
  notification channel. The Resend/Twilio account remains the owner's most
  valuable non-engineering action.

## What NOT to build

- **Do not make the public booking page ask who she is** in order to fix
  finding 1. The public flow takes her name last on purpose, and the strict
  question is the correct one for a visitor who has not said who she is. This
  is a desk fix, not a product-wide one.
- **Do not build a self-serve waitlist yet.** Measured above: the dead end it
  would catch is not reachable on the seeded book. Revisit when a real salon's
  book shows a (service, stylist) pair with no offerable day inside the
  horizon — that is the trigger, and it is checkable with the probe in §5.
- **Do not "unify" the three room predicates by making the push call the
  database.** The push plans a whole column in memory on purpose; the fix in
  finding 3 is one shared pure predicate, not one shared query.
- **Do not let the shell become a design system.** §5.5 is a nav bar, three
  counts and a search box. A token layer is a different, later item, and
  bundling them is how the shell stays unbuilt for a fifth phase.
- **Do not re-open D-7, D-30, D-44, D-45, D-46, D-47 or D-48.**
- **Everything on the Phase 6, 7 and 8 do-not-build lists stands unchanged** —
  no auto-completion on a timer, no client-axis conflict check, no `no_show`
  freeing its own slot, no lane-splitting room strip, no week or month grid,
  no third role, no series rule editor, no multi-provider chains, no second
  reminder touch, no call-down re-ranking, no close-the-day report for the
  owner.

## The process note

The Phase 8 rule ("a narrower list is a new fact") fired correctly and was
applied. The one this phase adds is its sibling, and it is about the *input* to
a predicate rather than the predicate:

> **A new PARAMETER is never one edit either — and the callers to grep for are
> the ones that HAVE the answer, not the ones that already pass it.** A-082
> added `holderKey` and threaded it through every caller that holds an
> APPOINTMENT. The two it missed hold a CLIENT and no appointment yet, which is
> what a booking panel is. The default is the strict question, so a caller that
> keeps the default compiles, passes every test, and silently asks a question
> it already knows the answer to.

The reason this is worth a rule rather than a fix: the compiler is no help —
`holderKey` is optional because the anonymous case is real — and neither is a
test of either half, because both halves are individually correct. What catches
it is the same thing that caught checkpoint 6: **an assertion that the two
answers to one operational question are EQUAL**, run against a room that is
interesting enough for them to differ. Finding 1's regression test must be
written that way, and finding 3 asks for the same shape one layer down.
