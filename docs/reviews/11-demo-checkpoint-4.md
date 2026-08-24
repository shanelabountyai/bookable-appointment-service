# Demo checkpoint 4 — the walk

**Walked 2026-08-24, at the Phase 5 boundary (A-052 closed the last built row
and the scoped backlog ran out for the sixth time).**
**Result: it ran, and it found three real defects — one of them created three
items ago by a feature that was itself a fix.**

Checkpoints 1, 2 and 3 each found a defect sitting inside an item already
marked ✅ and invisible from within the item that introduced it. This one is
the same shape three times over, and the second finding is the sharpest: **A-051's retry —
shipped this session to stop a client never being told — is what turned a
millisecond race into a two-and-a-half-hour window.**

The walk was scripted rather than clicked, so what follows is transcript. The
script has been deleted; what it found lives on as three fixes, a decision
(D-38), and seven regression tests plus one sharpened spec.

Scenes were chosen at the **seams between** items rather than down the middle
of any one of them, and the three the backlog row named were walked in full: a
chair retired mid-Saturday with clients in it, a weekly window deleted while
the room is full, and a reminder dispatched while a reschedule is in flight.
The third one is where the first two defects were; the third defect came out of the sweep.

---

## Finding 1: the reminder for the appointment she had just cancelled

`enqueueNotification` decides and records; `dispatchPendingNotifications`
sends. That separation is NOTIF-01's whole design and it is right. What
nothing owned is the gap between them — the dispatcher sent whatever was
queued, because a queued row was assumed to still describe reality.

Booked at 10:00 Tuesday, `now` set 24 hours earlier, the reminder job run, the
client rings and cancels a minute later, the dispatcher runs a minute after
that:

```
sendDueReminders: {"due":1,"enqueued":1,"duplicate":0}
appointment status now: cancelled
dispatch: {"sent":3,"failed":0,"retrying":0,"suppressed":0}
messages actually sent:
  -> appointment.cancelled  {"reason":"She rang and cancelled", ...}
  -> appointment.reminder   {"startAt":"2026-06-16T15:00:00.000Z", ...}
  -> appointment.confirmed  {...}

FINDING? reminder sent for a CANCELLED appointment: true
```

She is told her appointment is cancelled, and then reminded to come to it.
The rows dispatch oldest-first, so the reminder is the one she reads last.

**A-051 is what makes this worth fixing now rather than noting.** Before it,
the cron enqueued and dispatched back to back in a single request and the
exposure was milliseconds — real, but a genuine race. A transient provider
failure now legitimately holds a row for up to two and a half hours. Walked:

```
first dispatch: {"sent":0,"failed":0,"retrying":1,"suppressed":0}
reminder row: status=pending attempts=1 nextAttemptAt=2026-06-15T15:01:00.000Z
appointment moved to 2026-06-17T15:00:00.000Z
retry dispatch:
  -> appointment.reminder   {"startAt":"2026-06-16T15:00:00.000Z", ...}   <-- Tuesday
  -> appointment.rescheduled{"startAt":"2026-06-17T15:00:00.000Z", ...}   <-- Wednesday
```

A reminder naming Tuesday for an appointment that is now on Wednesday.

**The fix asks whether the message is still true, at the last moment before
the provider is called.** Only the reminder can go stale, and that is a
property of what it says rather than a shortcut: every other template reports
something that HAPPENED — booked, moved, cancelled, running late — and a fact
about the past is still true when it arrives late. The reminder is the one
message that makes a claim about the FUTURE, which is the only kind of claim
the world can falsify while the message sits in a queue.

The check reads `REMINDER_ELIGIBLE_STATUSES` — the same list `sendDueReminders`
selected on, asked a second time at a second moment, never a second copy of the
statuses. The row is marked `suppressed` with a reason a person can act on
(`stale:the appointment is cancelled`), not `failed`: nothing went wrong, and
it does not belong on A-051's "nobody was told" screen beside a dead phone
number. She is not left unreminded either — the dedupe key embeds the start
instant (P1-7), so the window catches the new time on its own.

---

## Finding 2: the link the reminder revoked, in a message nobody received

D-28 settled that the 24h reminder REISSUES the manage token, killing the link
the booking confirmation carried. Its argument ends:

> "The reminder always carries a fresh link, so nothing is left dangling."

That premise is about **delivery**. `sendDueReminders` runs at **enqueue**.

D-28 even states the correct test, one sentence earlier, when it explains why
reschedule is the one place that does not reissue: *"reschedule's own
notification carries no link at all — there would be nothing to replace the one
it broke."* Exactly so. And a reminder that is never delivered carries no link
either.

```
her confirmation link works before the reminder run: true
her confirmation link after the reminder run:        false
reminder dispatch: {"sent":0,"failed":1,"retrying":0,"suppressed":0}

FINDING? she now holds a DEAD link and never got the new one: true
```

This is A-048's harm arriving through a different door. A-048 fixed *two
concurrent reminder runs* — the loser's reissue revoked the winner's token, and
the winner's was the one in the message that actually went out. It rolled the
loser's reissue back. What it did not consider is the enqueue SUCCEEDING and
the SEND failing, which produces the identical outcome with no race at all.

**The fix (D-38): the reminder mints its fresh token and leaves the previous
one live.** Every other caller still revokes on reissue — D-38 narrows D-28 to
one caller using D-28's own reasoning, it does not repeal it. Two working links
to one appointment cost nothing: same scope, same expiry, same page. And
revocation-by-reissue was never the security control here — TOKEN-01's
hash-at-rest, the expiry and the route's rate limit are.

The alternative, revoking when the send succeeds, was rejected: it would mean
the dispatcher hashing a token out of a message payload to decide which of them
to kill, which is provider plumbing reaching into auth.

---

## Finding 3: the answer that arrived last, not the question that was asked last

Found by the checkpoint's own sweep rather than by a scripted scene, which is
the argument for running the sweep as part of the walk.

`/staff/book`'s panel asks the server for times on every service tap and every
day change (A-039 let the desk change the day without going back to the grid).
Both writes land in the same two pieces of state, and nothing recorded which
request an answer belonged to — so the response that arrived **last** won,
rather than the one that was asked last.

```
Expected: "2026-09-01"
Received: "2026-08-25"

- link "← Tuesday 25 August"
- heading "Book with Dana"
- paragraph: Booked.
- link "Back to the day" -> /staff/day?day=2026-09-01
```

The panel's own state had moved to 1 September — its "back to the day" link
says so. The appointment was written on 25 August. Nothing anywhere said the
two disagreed.

This is not a test artifact. Change the day while the previous day's times are
still in flight and the older answer silently reselects a slot on the day the
desk has just left, under a heading naming the new one. The desk then taps
Book.

**Fixed with a monotonic request id**: an answer that is not the newest is
dropped. An empty list for a moment is recoverable; a slot silently selected on
the wrong day is not. The spec now waits for the new day's times before
booking, so it can SEE the defect rather than book whichever day happened to
win the race that run.

---

## What the walk confirmed (no defect)

**Seam 1 — a chair retired mid-Saturday with clients in it.** Four
appointments booked at one time, every chair held, then the chair holding one
of them retired while its client is in it:

```
Chair 1 has 1 future holds — retiring it anyway
holds still on the retired chair: 1 (kept on purpose — history is not rewritten)
findRoomFullIntervals after retiring: [{"start":...,"end":...}]
FIFTH booking succeeded, chair = Chair 2 active=true
FINDING? assigned to a RETIRED chair: false
```

Correct on every count, and the interesting part is that it is correct for the
stated reason: the hold stays on the retired chair (A-034 declines to rewrite
history), and `findRoomFullIntervals` drops the retired chair from BOTH the
capacity and the holds counted against it — so a retired chair shrinks the room
without also filling it, exactly as its comment claims. `countFutureHolds`
gives the desk the number before it decides.

**Seam 2 — a weekly window deleted while the room is full.** A-047's stranding
report and the room's own accounting are independent axes and stayed
independent; nothing double-counted and nothing was silently freed.

---

## Debt folded in, and one claim that was false

**`testing/reset.ts` said a new table would "fail loudly here (leftover rows in
an unlisted table)".** It would not, and the walk measured it: `TRUNCATE …
CASCADE` also truncates every table holding a foreign key INTO a listed one,
whatever that key's `ON DELETE` says.

```
AppointmentSeries before reset: 1
AppointmentSeries after reset (UNLISTED table): 0
```

`AppointmentSeries` has been absent from that list since A-049 and has been
cleared correctly the whole time — silently, which is the opposite of loudly.
The comment now says what actually happens: the list is an **inventory**, not a
safety net, and nothing will tell you if you forget to extend it.
`AppointmentSeries`, `AppointmentResourceHold` and `AppointmentBlock` added.

**`manage.spec.ts`'s hydration race — could not be reproduced, and that is
reported rather than fixed.** A-048 recorded a residual "click on a stylist's
name occasionally lost". The rule was explicit that it must not be papered over
with a retry, so the first job was to see whether it still happens: five full
sweeps this session plus four further isolated runs of `manage.spec.ts`, all
green. The evidence says the symptom was the *stepping* bug — clicking through
steps that all render the same `fieldset ul > li > button` list — which
`manage.spec.ts` had already been fixed for, and which this session fixed in
`no-show-block.spec.ts`, the last file still carrying it. Recorded as
unreproducible rather than closed by a fix nobody can show works.

**`resolvePrefill` deleted.** Owner confirmed at this checkpoint. A-015 built
the public `/book?service=&provider=` contract for "rebook last visit"; A-040
replaced that with the staff flow and nothing in the product has emitted the
public form since. Gone with it: the `Prefill` type, the flow's prefill
branches, `listDaysWithOpenings`'s now-unreachable `fromDay` argument and its
`startDayFor` helper. A pasted link starts the flow at the top, which is what
it already did for any link naming a retired service.

---

## Method note

Checkpoint 3 left a rule — *prove the assertion before reporting the defect* —
after two of its first three findings turned out to be the walk's own bad
assertions. Both findings here were re-walked against the fix before being
written down:

```
FINDING? reminder sent for a CANCELLED appointment: false
FINDING? she now holds a DEAD link and never got the new one: false
```

And both existing tests that asserted the OLD behaviour were rewritten under
names that say what changed, rather than deleted — `reissues the manage token —
the ORIGINAL confirmation link stops working, and that is intended` is now
`mints a fresh link WITHOUT killing the one she is already holding (D-38)`.
A test that quietly disappears is a decision that quietly disappears.
