# Demo checkpoint 3 — the walk

**Walked 2026-08-22, at the Phase 3 boundary (A-044 closed it, and closed the
scoped backlog for the third time).**
**Result: it ran, and it found one real defect — a feature that has been
switched off in every environment that starts clean since A-031 shipped.**

The two previous checkpoints each found defects that sat inside items already
marked ✅ and were invisible from within the item that introduced them (D-28,
and rental's checkpoint-1 before it). This one is the same shape again, and
more so: the defect is not in the feature's code at all. The feature is
correct. It was never turned on.

The walk was scripted rather than clicked, so what follows is transcript. The
script has been deleted; what it found lives on as a one-line fix and a
regression test.

The scenes were chosen at the **seams between** Phase 3's items rather than
down the middle of any one of them — segments × gap-booking × resources ×
cross-provider moves. Every item in Phase 3 has passing tests; what nothing
owned was the place where two of them meet.

The seed anchors to a fixed week (`2026-06-09`..`13`). The walk books into the
following Wednesday and injects `2026-06-10 08:00` as `now` — every write path
takes `now` as a parameter precisely so that is possible.

---

## The defect: four chairs that nothing ever asked for

**A-031 modelled the salon's chairs. A-032 made a full room visible to the
engine instead of a crash. A-034 made the chair follow a reschedule. D-30 gave
the whole thing an exclusion constraint of its own, because a client developing
colour is not using her stylist and is certainly using the chair.**

**On a freshly seeded database, none of it was doing anything.**

```
services requiring a resource: 0 / 8
resource types: 1   resources: 4
appointments with resourceId: 0 / 230
resource holds: 0
```

Four chairs, one chair type, and not one service that requires either. Every
appointment in a 227-appointment seeded book held no chair at all, so the
constraint defended an empty table and the room could never be full.

### The cause is four lines in the wrong place

`packages/db/settings/setup-seed.ts` created the chair type, created the four
chairs, and then said "every service happens in a chair":

```ts
await prisma.service.updateMany({
  where: { businessId: business.id },
  data: { requiredResourceTypeId: chairType.id },
});

const serviceIds: string[] = [];
for (const s of SERVICES) { /* ...the services are created HERE... */ }
```

The `updateMany` ran **before** the loop that creates the services. On a clean
database it matched zero rows.

### Why nothing caught it — and this is the part worth keeping

The seed is idempotent, so the statement is harmless on a re-run: the second
time through, the services already exist and the requirement is applied
correctly. That single fact is the whole reason this survived four items and
two full test suites:

```
after ONE seed run (what db:reset:test leaves):        0 / 8 services require a chair
after a SECOND seedSetup (every e2e beforeEach):       8 / 8
```

- **Every e2e spec** calls `seedSetup()` in `beforeEach`, on top of a database
  `db:reset:test` has already seeded. That is always the *second* run. E2E has
  therefore only ever tested the healed state.
- **Every unit test** for A-031/A-032/A-034 builds its own fixtures and sets
  `requiredResourceTypeId` by hand — correctly, since they are testing the
  resource logic, not the seed.
- **`db:reset:test`, `db:seed:dev`, and a first deploy** each run the seed
  exactly once, on an empty database. That is the *first* run, and it is the
  configuration nobody tested and every real environment starts in.

A green suite was not merely failing to notice; the way the suite seeds is
what hid it. The one arrangement never exercised is the one every deployment
begins with.

### The fix, and the test that would have caught it

The `updateMany` moved to after the service loop. One statement, no new code.

The regression test asserts the requirement **after a SINGLE run on a clean
database**, which is the only phrasing that catches this — and it names the
services rather than counting them, because `0 of 8` and `8 of 8` both satisfy
a length check against itself:

```ts
expect(services.filter((s) => s.requiredResourceTypeId !== chairType.id).map((s) => s.name)).toEqual([]);
```

Verified red before green: with the fix stashed, the new test fails and the
other fourteen in the file still pass.

---

## What the walk looked like once the chairs were real

The rest of the transcript is the product working, and Scene 1 is worth reading
in full because it is the first time D-30's invariant could actually occur.

### 1. A segmented Colour, and the gap the salon can sell — ✅

```
Dana 2026-06-17: 14 Colour slots, first 09:00
Colour 09:00-11:00, 2 block(s): 08:50-09:45 + 10:25-11:20
  ✅ the 40-minute develop gap is a hole in the provider blocks
  ✅ a Blow-dry is offered INSIDE the develop gap — first 09:45
Blow-dry booked into the gap at 09:45
chairs: Chair 2 09:45-10:20, Chair 1 08:50-11:20
  ✅ the developing client and the gap sale are in DIFFERENT chairs
```

One stylist, two clients at 09:45, two chairs. The colour's provider blocks
have a hole in them and its chair hold does not — which is exactly the
distinction D-30 exists to draw, and until this checkpoint it had never been
exercised on a seeded database.

### 2. The move, and what has to move with it — ✅

```
moved to 13:00; blocks now 12:50-13:45 + 14:25-15:20
  ✅ every segment block moved by exactly the reschedule delta — delta 240 min
  ✅ no block left behind at the OLD time
  ✅ the chair hold moved with it — 12:50-15:20
  ✅ the blow-dry sold into the old gap was not disturbed
```

The segment blocks are trigger-maintained (`AFTER INSERT OR UPDATE ON
"Appointment"`), so a move rewrites them by construction rather than by the
reschedule path remembering to. That is the right design and the walk confirms
it end to end: two blocks, both shifted by exactly the delta, nothing stale.

**A note on the first attempt, because it is the more useful half.** This
scene initially reported two failures. Both were wrong — the assertion checked
that `blockedStart >= the new start`, and `blockedStart` is the start *minus
the before-buffer*, so `12:50` for a `13:00` move is correct. A sloppy
assertion produced two confident false findings in a walk whose entire purpose
is to be believed. The rewritten check compares the *shift* rather than the
absolute value, which is the assertion that would actually fail if a block
were left behind.

### 3. Reschedule across providers — ✅

```
  ✅ the appointment is Priya's now
  ✅ every block says Priya too — 0 still on Dana
  ✅ a chair is still held after the stylist changed — Chair 1 08:50-11:20
```

### 4. She cancels, and the salon finds out — ✅

```
  ✅ the freed slot is on What's opened up — 150 min freed, 3 row(s) total
  ✅ freed minutes are the whole envelope, gap included — 150 min
```

150 rather than 120: the freed time is the whole envelope including both
buffers and the develop gap, which is what the salon can actually resell.

### 5. A two-line visit — ✅

```
10:30-11:45 = Cut + Blow-dry
  ✅ both lines stored, in order
  ✅ the visit is as long as both services — 75 min
```

### 6. The audit trail — ✅

```
booked → rescheduled → provider_changed → rescheduled → status_changed
  ✅ every event names an actor
outbox: confirmed=pending, rescheduled=pending, rescheduled=pending, cancelled=pending
  ✅ nothing claims delivery: every row is still pending
```

A-044's copy change is load-bearing here: four messages, none of them sent,
and the screens now say so.

---

## Verdict

**Phase 3's sixteen items hold up.** Segments, gap booking, cross-provider
moves, multi-service visits, the freed-slot list and the audit trail all did
what they promise, and nothing was silently cancelled, moved or double-booked
at any point in the walk.

**One defect, and it is the most valuable kind this exercise finds:** not
broken code, but correct code that was never switched on, in the exact
configuration every real deployment starts in and no test ever creates. Four
items' worth of resource machinery — a modelled pool, a room-full path, a
chair that follows a move, and a dedicated exclusion constraint — sat dormant
since A-031, behind a green suite, because the seed healed itself on the second
run and every test seeds twice.

**The lesson to carry forward is about the fixture, not the feature.** A suite
whose setup runs the seed on top of an already-seeded database cannot see a
first-run bug, and this project's suite does that everywhere. Worth asking of
the next seeded artefact: *what is only true the second time?*

**One methodological note.** Two of this walk's first three findings were the
walk's own bad assertions, not the product's defects. A checkpoint is only
worth running if its findings are trusted, and a false one costs more than a
missed one — so the working rule stands: when a walk reports a failure, prove
the assertion before reporting the defect.
