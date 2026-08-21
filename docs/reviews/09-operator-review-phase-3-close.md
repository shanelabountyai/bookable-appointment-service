# 09 — Operator Review at the Close of Phase 3

**Reviewer:** service-business operator (4-chair salon + 6-room med spa owner; ex-ops manager, 14-van HVAC). **Reviewed:** 2026-08-21, with rows 1–39 of `06-backlog.md` built and only the unscoped list left. **Lens:** operational — would this survive a Saturday. Continues `08-operator-review-phase-3.md`; its P-1..P-5 are built as A-032..A-037 and are not re-raised. Findings are numbered **P-6..P-10** so the two reviews read as one sequence.

> **Verification note.** Every finding below was checked against the code before it was written, and each one carries its greps and its file:lines. Where only half of a claim is proved, the finding says which half. The three load-bearing greps:
> - **P-8** — `grep -rn "listDeactivationImpact" apps packages` returns **exactly one line, its own definition** (`apps/web/lib/availability/impact-actions.ts:55`). The provider-deactivation impact preview A-025 deferred and A-019's backlog row claims to own has **zero callers**. `apps/web/lib/settings/actions.ts:94` still carries the comment saying the preview "is A-019's" and the action below it calls `setProviderActive` and nothing else.
> - **P-9** — `grep -rn 'type="date"' apps/web/app` returns four matches: the waitlist range, the move panel, the availability form. **None is on `/staff/day` or `/staff/book`.** The day grid's navigation is three links — Previous / Today / Next (`apps/web/app/staff/day/page.tsx:70-81`).
> - **P-7** — the only e2e that exercises BOOK-05's override from the browser reaches it with a hand-built URL (`apps/web/e2e/staff-booking.spec.ts:149-158`: `page.goto('/staff/book?provider=…&at=18:00…')`). No link in the product emits an instant like that.
>
> What is **not** proved: P-10's claim that the conflicts list grows without bound is proved from the query (no lower time bound anywhere in `appointmentsInRange`), but I have not run the seed forward far enough to watch it happen. That is the fixture its row should write first.

---

## Verdict

This is now a book a real salon could run, and the last review's pattern — mechanism shipped, operator surface deferred to the next row — has genuinely been closed on all five of its instances. What remains is one pattern with a different shape: **the desk can only act on today, and only on the times the engine is willing to sell.** Every write path in the build takes an arbitrary day and an arbitrary instant; every staff *screen* hands it either today's grid or a slot the engine already offered. That is why the same defect reappears as four different symptoms — no way to book six weeks out, no way to reach a client's future appointment, no way to knowingly double-book, no way to see what freed up on Thursday. The single most consequential gap is the first: **forward booking has no staff path**, and rebooking at the chair is where half a salon's book comes from.

---

## P-6 — There is no way to get to a date. The desk can only work on today. (MISSING)

Mrs. Kerr is paying at the desk. "Same again in six weeks — Tuesday if you've got it." That is the highest-conversion moment in the business and it lasts about twenty seconds. The desk opens the day grid and finds **Previous / Today / Next**. Six weeks is forty-two taps. There is no date box on the day grid, none on `/staff/book`, and the booking panel takes its day from the URL and never offers to change it (`apps/web/app/staff/book/page.tsx:37`, `booking-panel.tsx` has no day control at all). The mechanism is fine — `/staff/day?day=2026-10-06` renders any day and `safeDay` already treats a hand-typed one as ordinary input — there is simply no control that produces the URL.

The same wall stands in front of the other daily errand. Mrs. Hall rings: "I need to move my appointment, I don't remember which day." The desk searches her by phone, lands on her client record, and her upcoming appointment is right there at the top of the History list — **as plain text**. `apps/web/app/staff/clients/[id]/page.tsx:134-151` renders each visit as an `<li>` of spans with no link, while the call-down list one screen over links every row straight to the appointment (`call-down/page.tsx:71`). So the desk can see the appointment it needs to move and cannot click it. It has to read the date off the screen, go to the day grid, and walk there a day at a time. A-033 built the move panel and A-038 gave it a provider; both are behind a page the desk cannot reach in one gesture.

**What a row must do.**
- A date control on `/staff/day` (a native `<input type="date">` submitting `?day=`, exactly as `move-panel.tsx:74` already does) beside the existing Previous / Today / Next.
- The same control on `/staff/book`, so the panel can change its own day without going back to the grid — it already loads the whole day's offered times for a provider once it has one (`booking-panel.tsx:91-107`).
- Every row in the client's History links to `/staff/appointments/{id}`, and future appointments are separated from past ones under their own heading. `clientHistory` already returns both, ordered `startAt desc` (`packages/db/clients/clients.ts:133-135`) — the page just does not say which is which.
- Acceptance criterion in the desk's own terms: from a client's record, book her next visit on a named date and move her existing one, each without touching the day grid.

**Money/trust.** In my salon roughly half the book is made at the chair on the way out; the front desk will not do forty-two taps with a queue behind them, so they write it in a diary and enter it "later", which is where double-bookings come from. The paper book comes back out here first. Estimate mine, from my own operation.

**Backlog fit.** New item, immediately after A-038 and before anything on the unscoped list. It is A-033's other half — that row gave the *move* a date box and left the *booking* without one.

**Confidence: high.** Greps above; nothing to raise.

---

## P-7 — The rebook button drops every service after the first, and runs the desk through the customer's rules. (CORRECTNESS RISK)

This is the one forward-booking path that does exist, and it is the wrong one. The client record renders "Cut + Colour with Dana. Last in on 12 May — she comes about every 42 days, so this starts on 23 June" and the button beneath it links to **`/book`** — the customer's flow — carrying `service: rebook.serviceIds[0]!` (`apps/web/app/staff/clients/[id]/page.tsx:104-115`). `resolvePrefill` takes one service id and the flow books one service (`apps/web/app/book/page.tsx:56`). So the card names a three-hour cut-and-colour and the button books a forty-five-minute cut. Nobody notices until she arrives.

Three more things follow from the destination being the public flow, all verified in `apps/web/lib/booking/public-actions.ts`:
- **`audience: 'public'`** on the engine calls and the write (`:112`, `:141`, `:234`), so D-25's staff exemption from the lead time and D-21's uncapped staff horizon are both lost on the one surface staff use most.
- **The client id is thrown away and re-resolved by (phone, name)** (`:213-220`). The desk started *on her record* and the flow will still create a second client if somebody types "Jen" where the record says "Jennifer" — splitting her history, her notes and her rolling no-show count, which is the exact harm D-17 and A-015's merge exist to contain.
- **CLIENT-04's block applies** (`:244`). A client with three no-shows, standing at the counter with her card out, gets "We can't book this one online. Please call the salon" — from the salon. The staff bypass exists at `bookAppointment` and this path cannot reach it.

**What a row must do.**
- Point "Rebook" at the staff booking surface, not at `/book`, carrying `providerId`, **every** `serviceId` in order, and `fromDay` — `staffSlotsFor`/`bookAsStaff` already take `serviceIds` as an ordered array (`booking-panel.tsx:133-135`).
- Carry the resolved `clientId` through, so the appointment attaches to the record the desk was looking at. No name re-typing, no second record.
- Staff audience end to end: no lead time, no horizon, no self-serve block, flag shown not enforced — the flag is already rendered on the picker (`booking-panel.tsx:245`).
- Regression test: rebooking a two-line visit produces two `AppointmentServiceLine` rows in the original order, attached to the same `clientId`, with no new `Client` row written.

**Money/trust.** A colour booked as a cut is two hours of a stylist's Saturday sold for nothing and a client turned away at the chair. In my shop that is $180–220 of chair time plus the apology. Once per week is enough for the desk to stop trusting the button. Estimate mine.

**Backlog fit.** New item, sitting with P-6 — same session, same surface. Do P-6 first; this one needs the staff panel to accept a day.

**Confidence: high.** Every claim is a line number above.

---

## P-8 — Deactivating a stylist with a book full of appointments warns nobody. (HALF-BUILT — the P-1 pattern, again)

Dana hands in her notice. The owner opens Providers and clicks **Deactivate**. The row goes grey. Nothing else happens: `apps/web/lib/settings/actions.ts:94-103` writes `Provider.active` and returns, with a comment above it saying the impact preview "is A-019's". A-019 built it — `futureAppointments` in `packages/db/availability/impact.ts:194` and `listDeactivationImpact` in `apps/web/lib/availability/impact-actions.ts:55` — and **wired it to nothing**. `grep -rn "listDeactivationImpact" apps packages` returns one line: the definition. Her forty booked appointments are now held by an inactive provider, invisible to the booking flow's provider list, and the only place they surface is `/staff/conflicts` — a screen nobody has a reason to open, because nothing told anyone anything happened.

The same gap, smaller, on the absence path: `addAbsence` writes time off and returns a `FormState` of errors (`apps/web/lib/settings/availability-actions.ts:115-140`); `availability-client.tsx` renders no conflict list and no link to one. AVAIL-05's own wording is "preview conflicts on any hours edit / time off / block / deactivation". Today the preview exists as a function and the desk's only route to it is remembering to tap **Conflicts** on the day grid afterwards. That works on a sick day because the desk is already on the day grid; it does not work for a resignation, a two-week holiday entered in advance, or an hours change made by the owner at home on a Sunday.

**What a row must do.**
- Deactivation is a two-step: click Deactivate, see the list `listDeactivationImpact` already returns — each client, phone, date, service — and confirm. Same shape as SVC-03's existing `DeactivationRequiresConfirm` gate for services, which is already built and already tested against a real appointment row (A-006).
- Writing time off, an ad-hoc block, or an hours change returns the conflicts it just created and renders them inline with the four AVAIL-05 actions, or at minimum a "9 appointments are now stranded — deal with them" link to `/staff/conflicts` scoped to that provider.
- Nothing refuses. D-2's and A-007's rule stands: recording that Dana is off must always succeed. This is about the sentence that comes back, not about the write.
- Regression test: deactivating a provider with future appointments without confirming leaves `Provider.active` unchanged, and confirming leaves every appointment untouched.

**Money/trust.** Forty stranded appointments discovered a week later is forty phone calls that should have been made on the day, and the ones you miss walk in to a stylist who left. This is the event the brief names as the highest-stress in the business.

**Backlog fit.** New item. It belongs inside A-019's scope — the row explicitly says it "**also owns the provider-deactivation impact preview** moved out of A-025" — so this is finishing A-019, not a new feature.

**Confidence: high.** Zero-caller grep is definitive.

---

## P-9 — BOOK-05's override cannot be reached from any screen. (HALF-BUILT)

The bride's mother rings on Thursday: six of them, Saturday morning, and Dana is solid. In a real salon the answer is "leave it with me" — you double-book the 10:00 knowingly, you tell Dana, and you write down why. D-8 calls this the hardest-won point in the whole product and the build honours it everywhere except the screen: `isOverride` + reason, the zero-width blocked range, `override_booked` in the event log, the marker on the detail panel, D-24's advisory lock and the ninth race interleaving all exist and are tested.

The desk cannot get to it. The booking panel's instant is `pick?.at ?? chosenSlot ?? ''` (`booking-panel.tsx:74`), and `chosenSlot` is either a slot the engine offered or the `at` from the URL (`:105`). The only links that emit an `at` are gap chips, and gaps are by construction free provider time inside a working window (`apps/web/lib/day/view-model.ts:169-180`). An appointment chip links to the detail page. So there is no way to select 10:00 on Saturday when Dana has a client at 10:00 — the override checkbox only appears after a refusal (`staff-actions.ts:205-226`) and the desk cannot cause the refusal. The proof is the test itself: `staff-booking.spec.ts:149-158` reaches the override by navigating to a hand-built `?at=18:00`, which is not a URL the product ever produces. "Move her to 6pm, we'll stay late" — the case A-038 deliberately routed *back* to an override booking — has the same problem.

A related edge from the same code: tap a 25-minute gap for a two-hour colour and `chosenSlot` silently becomes the first offered time *at or after* it (`:105`), which may be four hours later, while the page heading still reads "at 13:35" from the URL (`staff/book/page.tsx:63,74`). The selected chip is highlighted, so it is visible — but the headline names a time the form is not booking.

**What a row must do.**
- A time entry on the staff booking panel: a `<time>` or `<select>` of the day's grid instants, not restricted to offered ones, so the desk can name any time in the salon's day. It composes to an instant server-side exactly as the gap link does today (D-4: the form carries the instant, never `{date, time}`).
- Show the engine's excluded times **with their reasons** to staff, which A-032's own left-behind asked for and handed to A-033: `explain` is already returned on `audience: 'staff'` and `readableReason` already exists in `apps/web/lib/scheduling-words.ts`. "10:00 — she already has a client" with a Book-it-anyway beside it is the whole feature.
- The heading reflects the time that would actually be booked, not the one in the URL.
- Regression test: with a fully booked column, a staff user selects an occupied time, is refused with `overlaps-booking` in words, ticks the override with a reason, and the appointment lands with a zero-width blocked range and an `override_booked` event — all from the browser, with no hand-built URL.

**Money/trust.** A wedding party is $600–900 to me and it is booked on the phone in ninety seconds or it goes elsewhere. More than the money: a system that cannot be overruled is the one the staff route around, and every workaround they invent is invisible to the book. Estimate mine.

**Backlog fit.** New item, after P-6 (it needs the same time control) and folding in A-032's deferred "show staff the excluded times with reasons".

**Confidence: high** on unreachability; **medium** on the gap-preselect heading mismatch being a real-world error rather than a cosmetic one — I have not watched a desk use it.

---

## P-10 — A cancellation for any day but today is invisible until that day arrives. (MISSING)

Saturday lunchtime, a client cancels next Thursday's colour through her manage link. `transitionAppointment` enqueues nothing — the notice is guarded `actor.type === 'staff'` (`packages/db/appointments/transition.ts:206`), correctly, because she does not need telling what she just did. But nothing tells the *salon* either, and there is no screen where a freed slot appears: the day grid draws the hole only on Thursday, and per P-6 the desk cannot easily get to Thursday. Three hours of Dana's most valuable service sit unsold for six days, and the waitlist entry that fits it is sitting in `/staff/waitlist` the whole time.

The matching machinery is built and good. It has one door: `matchFreedSlot` is called only from `/staff/waitlist` reading URL params that are built in exactly one place — the cancelled appointment's own detail page (`apps/web/app/staff/appointments/[id]/page.tsx:176`). So "who wants this slot?" requires already knowing which appointment was cancelled and opening it. That is the one thing the desk does not know.

This is **not** the automated-offer question. OQ-4 is still open and should stay open; A-023's staff panel is still the right v1. What is missing is the supply side of the call-down list the product already built for the demand side.

**What a row must do.**
- A "what's opened up" list: appointments moved into a slot-freeing status in the last N days whose freed time is still in the future and still empty, ordered by how soon the time expires — soonest first, because a Thursday 2pm dies on Thursday at 2.
- One tap from the day grid, beside Walk-in / Conflicts / Call-down, with a count on it so it is legible without opening.
- Each row carries the freed length and links straight into the `matchFreedSlot` URL the detail page already builds, plus the client's phone as a `tel:` link — same shape as `/staff/conflicts`, which is the screen this is a sibling of.
- Derived on every read, nothing stored, the same discipline as A-019's conflicts and A-020's counters: a row drops off the moment somebody books the time.

**Money/trust.** A Saturday colour is $180–220 in my chair and a weekday one not much less; two a week recovered pays for the software several times over. The waitlist is worth nothing if nobody knows a slot opened. Estimate mine.

**Backlog fit.** New item, after A-023 in spirit — it is WAIT-02's missing entry point, not a new epic. Below P-6..P-9 only because those cost money every single day and this one costs it a few times a week.

**Confidence: high** on the mechanism (grep of `matchFreedSlot` callers, and the staff-only notify guard); **medium** on the exact shape of the list, which a real desk would want to argue with.

---

## On the unscoped list

**The order is roughly right and nothing on it is urgent next to P-6..P-10.** Every item on that list is a new capability; all five findings above are surfaces missing from capabilities already paid for, which is always the better trade.

- **Multi-provider chains — still last-ish, same reasoning as last review.** Cut with Dana then colour with Priya is real and rare, and the workaround (two appointments) is not refused by the database, because two providers do not collide on the provider axis. Nothing has changed to make it more urgent.
- **Real Resend/Twilio adapters — correctly out of scope, with one caveat worth writing down.** The scheduling logic is not dishonest without them. But A-036's "Told: …" column on the conflicts screen means "we wrote an outbox row", and today that row is a console log. Staff will read it as "she has been texted". One sentence of on-screen wording ("queued") costs nothing and stops that becoming a lie the desk relies on.
- **Multi-user auth + roles — the urgent half already shipped as A-037, and one small piece of the other half should come forward.** Identity was the thing that mattered and it is done. Full RBAC is not needed in a four-chair salon. But A-037's own left-behind records that the roster screen is reachable by any staff member, so anyone at the counter can set anyone else's PIN — which makes the audit trail A-037 exists for forgeable in thirty seconds by the person most motivated to forge it. The fix is not roles: it is that setting or resetting a PIN requires the password session (`sub`), not the acting identity (`act`). That is a guard, not a permissions matrix, and it belongs in the same row as the `act` timeout the same left-behind names.
- **Recurring appointments — do not build; see below.**
- **tzdata-drift job — honest, cheap, still last.** It is the only item on the list that protects something already shipped, so if a quiet session ever wants filling, take this one rather than starting a chain feature.
- **OQ-5, while it is open:** leave the call-down chronological and do not build a second reminder touch. A day-of 2h reminder in a salon reaches people already on their way and trains everyone to ignore both messages. If the owner wants a second touch, the honest one is the *unconfirmed* list on the phone, which A-021 already built.

## Do not build

**Recurring appointments ("every 4 weeks").** Unchanged from the last review, and P-7 sharpens it: the standing-series shape is not what a salon needs, a correctly-wired rebook-at-checkout is — and that is a one-session fix rather than a whole epic of series-versus-occurrence problems.

**A week or month grid.** The fix for P-6 is a date box, not a bigger calendar. Four columns times seven days is unreadable on a desk monitor, doubles the rendering surface the day view already gets right (clipping, now-line, gap chips, overrun, status colours), and gives the desk a second answer to "what does Dana have on" that can disagree with the first. The salon works one day at a time; it just needs to choose *which* day.

**A chair-visualisation screen.** Unchanged from the last review. D-30 settled that nobody at the desk picks a chair, and A-032 put the only chair fact anybody needs — the room is full at 11:15 — into the refusal.

**Automated waitlist offers, until OQ-4 is answered by a person.** Unchanged, and P-10 is explicitly not this: a list of what freed up is a staff surface, and it makes the eventual automation decision *easier* to take, because the desk will have seen how often a slot actually frees.

**Notification templates and content.** The outbox carries a key and a payload and that is the right amount until a real driver exists (D-14). Building a rendering layer now means building it twice.
