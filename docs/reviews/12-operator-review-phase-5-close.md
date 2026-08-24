# Operator review — Phase 5 close

**Run 2026-08-24, after A-054 (demo checkpoint 4) closed Phase 5 and emptied
the backlog for the sixth time.**

**This review had been owed for three scoping passes.** Phase 4's scoping note
asked for it before A-048; it did not happen. The Phase 5 scoping pass asked
again and said in its own header that "the ordering below is the half that most
needs a front-desk opinion — treat it as provisional until one is taken"; it did
not happen then either. Both of those passes shipped anyway. This is that
opinion, and the first thing it does is tell us one of those orderings was
wrong.

Reviewer: 22 years operating salons and a med spa, ex-ops manager of a 14-van
HVAC company. The same reviewer wrote `01-operator-review.md`,
`05-operator-review-milestone-1.md`, `08-operator-review-phase-3.md` and
`09-operator-review-phase-3-close.md`.

---

## Verification note

Every factual claim below was re-checked against the source before being
written into the backlog, per the discipline the last three scoping passes
adopted. All five load-bearing ones hold:

| Claim | Checked | Result |
|---|---|---|
| SVC-02 "any provider" was never built | `grep -rniE "any provider\|fewest booked"` over real source | **True.** Hits are the waitlist's *preference* field, a tiebreak comment in `providers.ts`, and a UI label. No booking path implements it. |
| Nothing writes `AppointmentServiceLine` outside the booking path | `grep -rn "appointmentServiceLine"` excluding tests/generated | **True.** One `findMany` (a read) in `reschedule-actions.ts`; one `createMany` in a test fixture. No writer. |
| `Service` has no "bookable online" flag | `grep -c "bookableOnline" schema.prisma` | **True.** Zero. |
| The public flow books ONE service | `booking-flow.tsx` | **True.** `useState<Service \| null>`, single `serviceId` posted. |
| The column push accepts a negative delta undocumented | `push-column.ts:402` | **True.** `args.minutes === 0` is the only rejection. |

---

## The verdict, in the reviewer's words

> The book itself is real, and that is not faint praise — running late is a
> stored first-class fact, overrides are modelled rather than refused,
> conflicts stay derived, the colour-gap is bookable, the chair binds, and
> every mutation names a person. On the ordinary chaos of a Saturday it is
> stronger than I expected: check-in is on the chip, the walk-in has its own
> door, the desk can reach any date, a sick stylist's nine clients are listable
> and movable across providers.
>
> Where it breaks is not chaos, it is **change of mind** — the one thing a
> booked appointment cannot do in this system is *become a different
> appointment*.

That answers the question this review was asked. The suspicion put to the
reviewer was that the build is strong on correctness and weak on ordinary
chaos. **Disproved on chaos, and replaced with something sharper**: the gap is
not the unpredictable Saturday, it is the client who changes her mind while
sitting in the chair.

---

## The finding that overturns a decision of ours

**D-35 said there would be no "cancel the remaining occurrences" button.** The
reviewer says that is wrong, and the argument is structural rather than a
preference:

> Creating six appointments is one action and undoing them is six. Any product
> where the undo costs six times the create teaches the desk not to use the
> create — which is exactly what will happen to A-049.

And it answers D-35's own stated objection:

> The specific objection D-35 raises — "which ones did you mean" — has an
> answer, and it is *future from this one*, because past occurrences already
> happened and cancelled ones are already cancelled. The cutoff-per-occurrence
> and message-per-client objections are arguments for a preview, not against
> the action.

Recorded as **D-39**, superseding that half of D-35. Everything else in D-35
(two fields not a wizard, an override may not repeat, the ambiguous-hour anchor
refused) the reviewer endorses unchanged.

## A finding of theirs that we answered badly

Stated plainly, because a review that cannot say this is not worth running:

> I wrote "do not build recurring appointments" in both
> `08-operator-review-phase-3.md` and `09-operator-review-phase-3-close.md`.
> The Phase 5 scoping pass promoted it to A-049 and put it *first*, on the
> stated reasoning that "a salon's forward book is mostly standing series" —
> which is an engineer's belief about a front desk, and the section's own
> header admits as much. It is not mostly standing series; it is mostly
> rebooking at checkout, which A-040 correctly fixed. I would still not have
> built A-049, and it went ahead of both recommendation 1 and recommendation 2,
> each of which costs money every week.
>
> That said: the *execution* is the right shape in every respect I checked, and
> having built it, finishing it is now cheaper than regretting it.

**This is the cost of skipping the review, measured.** A-049 was an L, took two
sessions, and displaced two items the operator rates as weekly revenue. The
reasoning that promoted it is quoted verbatim in `06-backlog.md` and was an
engineer's assumption about a front desk, written in a section whose own header
admitted it needed an operator's opinion first.

---

## The three defaults, answered

| Decision | Taken as | Operator's answer |
|---|---|---|
| **D-34** — series materialised as real rows; one occurrence detaches; no re-plan | default | **Right. Keep it.** "A virtual occurrence in a book whose guarantees are exclusion constraints is a lie the database has never heard of, and 'cancel this one, leave the rest' is what a desk means every time." |
| **D-35** — no bulk cancel for a series | default | **Wrong.** See above; superseded by D-39. |
| **D-37(a)** — no second reminder touch | default | **Right, and unchanged from the Phase 3 close.** "A day-of reminder in a salon reaches people already in the car and teaches them to ignore both messages." **One correction to the revisit trigger** — see below. |
| **D-37(b)** — call-down in time order, carrying value and flag | default | **Right.** "A silently re-ranked list makes every row's position mean something the reader cannot see." The gap is not the sort — it is that the list forgets who has been rung. |

**The D-37(a) correction is worth taking on its own.** Its recorded revisit
trigger was "when the no-show rate is measured and the 24h touch is not moving
it". The reviewer points out that nobody can honestly evaluate that while the
adapter is a console log, so the trigger should read **"revisit when a real
channel has run for a month"** — otherwise it gets revisited on a hunch.
Amended in D-39.

---

## Do not build

The reviewer was explicit, and this list is as valuable as the build list:

- **A-053, automated waitlist offers — blocked, not deferred.** "A sequential
  soft-hold takes a Saturday 2pm off the market for 30 minutes on the authority
  of an offer that was written to a console. That is perishable supply
  destroyed by a message nobody received. OQ-4 is not a data-shape question
  yet; it is blocked." A-023's staff panel plus A-043's "Opened up" *is* the v1
  for a 4-chair salon.
- **A second reminder touch** (D-37(a)).
- **Re-ranking the call-down** (D-37(b)).
- **A week or month grid.** Unchanged from the last two reviews — the date box
  solved it.
- **A chair-visualisation screen.** "A-046's room strip is already at the edge
  of useful; do not grow it into a floor plan."
- **Any third staff role, per-screen permissions, or a manager tier.** "D-36
  got this right and the resistance to a third role is the valuable part of it."
- **A series rule editor.** End-the-series-here plus a rebook covers it. "A
  rule that can be edited underneath booked occurrences is a whole class of
  'which ones moved' bugs for a case that happens twice a year."
- **Multi-provider service chains as an epic.** Still two appointments; only
  the chair accounting is wrong (A-063).

**And one thing that is not an engineering row at all:** the real Resend/Twilio
adapters. `logging-adapter.ts`'s argument for not building them still holds —
but the reviewer notes the accounts are now the gate on A-053, on evaluating
D-37(a), and on the honesty of every "was she told?" column. **It is the
owner's most valuable non-engineering action**, and belongs said out loud
rather than at the bottom of an unscoped list.

---

## The full review

The recommendations are reproduced as backlog rows A-055..A-063 in
`docs/prds/06-backlog.md`, each carrying the operator's own operational
scenario, because the scenario is the part that survives translation into a
ticket. Two of them (A-062, A-063) carry the reviewer's own confidence
qualifications and A-063 is scoped to prove-then-fix rather than fix.
