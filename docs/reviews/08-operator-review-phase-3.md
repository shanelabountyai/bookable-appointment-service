# 08 — Operator Review at the Phase 3 Boundary

**Reviewer:** service-business operator (4-chair salon + 6-room med spa owner; ex-ops manager, 14-van HVAC). **Reviewed:** 2026-08-20, at the close of the scoped Phase 3 backlog (A-029, A-030, A-031). **Lens:** operational — would this survive a Saturday. The requirements passes are `04-po-review-milestone-1.md` and `05-operator-review-milestone-1.md`; this does not repeat them.

> **Verification note (build session, 2026-08-20).** The two load-bearing claims were checked before this file was committed, and both hold:
> - **P-1** — `grep -rn 'rescheduleAppointment\|rescheduleOptions' apps packages` returns exactly one non-test caller: `apps/web/lib/manage/actions.ts:245`, the customer's manage link.
> - **P-2** — `NoResourceFree` is thrown at `packages/db/booking/book.ts:340` and caught nowhere in `apps/web`. Confirmed by grep, and fixed by A-032 in the same session.
>
> P-3's code path is likewise certain (`reschedule.ts`, `push-column.ts` and `reassign.ts` contain no resource references at all); what has *not* been proved is that the collision is reachable against the seeded Saturday, and building that fixture is the first thing its row should do.

---

## Verdict

The shape is right, and unusually so: the book is a real book, running late is first-class, overrides are modeled rather than refused, and conflicts stay derived so the sick-stylist screen cannot go stale. What is missing is not shape — it is the last inch on three shipped mechanisms. Each was built correctly at the write path and then handed to the next backlog row for its operator-facing half, and the handoff went round in a circle.

---

## P-1 — Staff cannot reschedule. The write path is shipped and has no button. (HALF-BUILT)

10:40 Saturday. Mrs. Hall rings: "can you push my 3 o'clock to 4?" Dana is free at 4. The desk opens `/staff/appointments/[id]` and finds status controls, a note field, an event log — and no way to change the time. The only paths are to tell a 58-year-old client to find the link in a text she deleted, or to cancel her and rebook. They cancel and rebook. That is inside the cancellation cutoff, so A-012 correctly reclassifies it `cancelled_late`, and Mrs. Hall — who did nothing wrong — now carries a late-cancel on her record showing on five surfaces (A-020) and in the owner's cancellation tile (A-024). Eight of those on a Saturday and by Monday the dashboard reports a cancellation problem the salon does not have.

**What a row must do.** A "move this appointment" control on the detail panel and on the day-grid chip, calling the existing `rescheduleAppointment` with `actor: staff`. The picker is `rescheduleOptions` — the same read the write path uses — never a second slot list. Staff are the unrestricted caller as in A-017: no lead time (D-25), no horizon (D-21), no cutoff (APPT-05), and an override path on refusal so "move her to 6pm, we'll stay late" is reachable. Provider change in the SAME action, not only time: "Dana's sick, put her with Priya at 2 instead of 3" is one operation to a human and two screens here. A-019's "offer a new time" link stops pointing at the day view and opens this picker. Regression test: a staff move produces a `rescheduled` event and **no** `cancelled_late` anywhere, and the manage token still resolves afterwards.

**Why it is orphaned.** A-014 built the mechanism and deferred the surface to "A-016's grid and A-027's detail panel"; A-016 deferred to A-027; A-027's own left-behind says "no staff reschedule picker"; A-019 deferred to the day view. Four rows each handed it to the next.

---

## P-2 — The engine was chair-blind and `NoResourceFree` was an unhandled crash. (CORRECTNESS RISK + HALF-BUILT) — **BUILT AS A-032**

11am Saturday, RES-05's own scenario: four colours developing, four blow-dries booked into their gaps, all four chairs held. A customer opened `/book`, was offered 11:15, submitted — and the server action threw out of the app, because neither action layer caught `NoResourceFree`. She saw a crash, not "sorry, that just went". The front desk booking a walk-in got the same crash, and RES-04's override — the thing D-30's decision rests on — was unreachable, because the override is only offered on `SlotTaken`/`SlotNotOffered`.

The deeper half: `packages/db/scheduling/` contained zero references to resources, so a full room removed no candidates. That is the offered-then-refused class this repo has already caught twice (the gap-vs-grid seam at demo checkpoint 2, the day-view clipping bug) — the class that trains staff not to trust the screen.

**Fixed in A-032, same session.** See `docs/PROGRESS.md`.

---

## P-3 — Moving an appointment never re-picks its chair. (CORRECTNESS RISK)

Dana is 38 behind and the desk pushes her column. `pushColumn` moves five appointments in one transaction with `SET CONSTRAINTS ... DEFERRED`, and every one keeps the `resourceId` it was assigned at booking. Appointment three lands on top of Priya's client, who is in that chair. `appointment_resource_no_overlap` fires at COMMIT naming no pair, and `push-column.ts` has **no** `isSlotTakenError` mapping at all — so the desk gets a raw database error in the middle of the highest-stress operation of the day. D-26's `leftBehind` list exists precisely so a push names what it could not move, and it is computed on the provider axis, so the preview promised a push that then blew up.

The same defect points the other way in reschedule: `rescheduleAppointment` also carries `resourceId` forward, and A-031 taught `isSlotTakenError` to recognise both constraints — so moving Mrs. Hall from 3 to 4 when *her* chair is busy at 4 returns "that time has just been taken" while Dana is free and three chairs stand empty. A refusal the desk can see with its own eyes is wrong is the fastest way to lose them.

**What a row must do.** `rescheduleAppointment`, `pushColumn` and `reassignAppointment` re-run `findFreeResource` for the destination envelope and write the new `resourceId` in the same transaction — the chooser is still not the enforcer (D-30). `previewPush` runs the same chair check the action executes, per A-018's own rule that preview and action share one function. `pushColumn` maps `isSlotTakenError` and reports the blocked appointment through `leftBehind` instead of throwing. A reschedule that finds no free chair returns `NoResourceFree`, not `SlotTaken` — different question, different answer. First test to write: push a column into a cross-provider chair collision and assert a named `leftBehind`, not an exception.

---

## P-4 — The day grid is read-only on the screen that is open all day. (HALF-BUILT)

The 10:00 arrives at 10:12. To check her in the desk finds her chip, clicks through to the detail page, waits for a server render, clicks "Check in", navigates back. Four interactions and two page loads for the most frequent action in the salon. Marking the 11:30 a no-show — the event the whole of Milestone 4 counts — costs the same. `provider-day.tsx` renders "Checked in" as a *label*; it has no `changeStatus` call.

No dollars attach to this, which is why it will get deferred again — wrongly. It is the adoption gap: a read-only grid is what makes staff keep a paper sheet beside the terminal "just for check-ins", and once the paper is out it holds the walk-ins too.

**What a row must do.** Check in / start / complete / no-show on the chip itself, calling the existing `changeStatus` with the same `expectedFrom` optimistic lock A-027 uses. Buttons derived from the §7 table asked with the real actor and clock, exactly as `StatusControls` does — a chip must never offer a move the write path refuses. Keyboard-reachable in the chip's existing DOM order; the chip stays a link to the detail page. Reuse `StatusControls`' logic rather than forking it: two surfaces disagreeing about what is allowed is the failure mode here.

---

## P-5 — Cancel and bulk-reassign are the only mutations that tell nobody. (MISSING)

Dana calls in sick. The desk opens `/staff/conflicts`, reassigns three to Priya and cancels six. Six clients are cancelled, three now have a different stylist, and the system sends **zero** messages: `reassign.ts` has no `enqueueNotification`, and neither does the staff cancellation path. Book, reschedule and push-the-column all notify; these two do not — and these two happen on the worst day of the quarter. The intent is clearly "the desk rings them", and the `tel:` links are right, but three clients silently moved to a different stylist is the silent change AVAIL-05 says never happens, and the first one finds out when she walks in and Dana is not there.

**What a row must do.** `reassignAppointment` enqueues "your appointment is at the same time, with Priya"; `reassignMany` enqueues one per moved appointment, in its own write's transaction. A staff cancellation enqueues a notice carrying the reason A-019 already requires, keyed for idempotency like every other row. Both stay suppressible — a client the desk has already phoned must not get a text contradicting the call. The conflicts screen shows which of the nine have been told, from `NotificationOutbox.appointmentId` (the lookup R-4 added and demo checkpoint 1 fixed).

**Ask before building the cancel half.** Some desks deliberately do not auto-text cancellations, because the call must come first. Build the reassign half regardless.

---

## On the unscoped list

**Multi-user staff auth belongs earlier than it sits — but for IDENTITY, not roles.** Every mutation is stamped `actor: 'staff'` from one shared credential, so the event log renders "by the front desk" for all four people who use that terminal. The brief's own rule is that "who moved this appointment and when" always has an answer, and today the answer is "somebody". That matters the first time a client insists nobody told her, and more the first time an appointment is cancelled that should not have been. Not more urgent than P-1..P-3, which cost money on a specific Saturday, but ahead of everything else unscoped. The cheap version is the right one: `actorRef` already exists on the availability tables from R-8, so this is a named-staff column and a PIN, not Auth.js and an RBAC matrix — D-9 is explicit that the minimal shape is deliberate.

**Real Resend/Twilio adapters: correctly ranked.** The scheduling logic is not dishonest without them — the outbox records every decision, dispatch runs on a schedule, and the seam is proven. Leave it a non-goal.

**Multi-provider chains: less urgent than listed.** Cut with Dana then colour with Priya is real but rare, and unlike VISIT-01 the workaround is not refused by the database in the common case — two appointments with different providers do not collide on the provider axis at all. Staff can already book it as two.

## Do not build

**Recurring appointments ("every 4 weeks").** A salon does not book a standing series; it rebooks at checkout while the client is still in the chair, which A-015's rebook-last-visit plus the natural-interval suggestion already does well. Real recurrence buys a whole class of problems — the series versus the occurrence, edit-one-versus-all, what happens to occurrence seven when the stylist leaves — for a business that reschedules constantly. Every platform I have used that had it, we used it for the standing 9am staff meeting and nothing else.

**A chair-visualisation screen.** A-031's left-behind suggests showing which chair each client is in and the room filling up. D-30 already settled that nobody at the desk ever picks a chair, and it is right: the only chair fact anybody needs is "the room is full at 11:15", and that belongs in the slot list and the refusal message — which is what A-032 built — not on a floor plan. A screen showing Chair 3 is decoration that will be maintained forever.

**Automated waitlist offers, until OQ-4 is answered by a person.** The backlog already has this right and A-023's staff panel is the correct v1.
