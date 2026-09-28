# Five-lens review after the security work

**Run 2026-09-28 at `59de25b`, after A-141 closed the security leftovers (D-69).**

Five reviewers ran in parallel, each from `.claude/agents/`. Every reviewer was read-only: no app was started and no file was changed.

| Lens | Agent | Model | Recs |
|---|---|---|---|
| Owner / operator | `salon-operator` | Opus | 6 + D-68 ranking |
| One column, behind the chair | `stylist` | Opus | 7 |
| Client booking on a 390px phone | `booking-client` | Sonnet | 6 |
| Coherence, hierarchy, copy | `ux-design` | Sonnet | 8 |
| Keyboard, screen reader, WCAG 2.2 | `accessibility` | Opus | 12 |

**Nothing here is scheduled.** Each bundle below is a backlog candidate. The owner picks, and each pick becomes a D-number and an A-number the usual way.

**The headline claims were checked against the code before this was written** (§4). Everything else is the reviewer's reading, with its file:line.

---

## 1. Verdict

The core is right. Every lens independently praised the same things: the running-late cascade, the processing gap offered as bookable time, the release of a no-show's time, the full-sentence chip names, the audit log on appointments, and the desk's booking path. No reviewer found a correctness defect in the slot engine or the no-overlap invariants.

**What the reviews found sits at the edges of the core:**

- **Screens that go stale.** A stylist's own column never refreshes.
- **A record that cannot be corrected.** A client's name, phone and email have no edit path, and their allergy note has no history.
- **Moments where the product drops the person.** After a lost race the typed details are gone. Keyboard focus falls to `<body>` after every step. Cancel on the manage page is one tap.
- **A design system that stopped at the door of the busiest screens.**

Four of the five lenses reached the same few places from different directions (§2). That is the strongest signal in the review.

---

## 2. Where the lenses agree

| Place | Found by | What each saw |
|---|---|---|
| Public booking, lost race (`booking-flow.tsx:419-423`) | booking-client #1, accessibility #2 | The `alternatives` branch returns the client to the time list with no reason given, and wipes the typed name and phone. The stale "that time has just been taken" then fires on the *next*, free time. No e2e spec covers this branch; the sibling `instead` branch has one. |
| Manage page cancel (`manage/[token]/cancel-form.tsx:14-26`) | booking-client #2, #3, accessibility #11 | One tap, no confirmation, not styled as destructive, a 36px target. It can resolve to `cancelled_late`, which counts toward the D-27 block. |
| 36px hand-rolled buttons | ux-design #1, booking-client #2, accessibility #8 | The detail panel, the column controls, staff booking and the manage page all bypass `components/ui/button.tsx`. That component's own comment names 36px as the defect it fixes. |
| Nothing says what changed or who changed it | stylist #3, operator #2 | The stylist's column shows a moved appointment with no marker. The client's pinned note is overwritten last-write-wins, with no author. The appointment event log is the only surface that can explain itself. |
| Async results nobody hears | accessibility #3, #4, stylist #1 | Staff live regions mount together with their text, so they stay silent. Separately, the `?provider=` list never re-reads at all. |

---

## 3. Candidate bundles, ranked

**S / M / L** as in `06-backlog.md`. **Defect** means the product contradicts its own stated acceptance criteria or its own code comments. **Decision** means an owner call is needed before any build.

### Defects: small, certain, and verified

| # | Bundle | Size | From | Contents |
|---|---|---|---|---|
| **C1** | **A stylist's own list stays live** | S | stylist #1, #6 | • `?provider=` and `/staff/opened` re-read on the grid's 15s timer, through one shared hook (`useAutoRefresh` is private to `day-grid.tsx:339`).<br>• A-016's 30s staleness test runs on the list too.<br>• Walk-in on `?provider=` carries the provider (`day/page.tsx:126`).<br>• Correct the false comment at `provider-day.tsx:25`. |
| **C2** | **Losing the race on /book** | S | booking-client #1, #4; accessibility #1, #2, #12 | • Show why on the time step, through the live region that is already there.<br>• Keep the typed details.<br>• `setResult(null)` on a new pick.<br>• Add an e2e test for the `alternatives` branch.<br>• Focus each step's legend and the done heading; the step count goes into the legend.<br>• `aria-pressed` on the stylist and day cards.<br>• At the stylist dead-end, a one-tap "see anyone available". |
| **C3** | **The manage page gets the phone pass** | S | booking-client #2, #3, #6; accessibility #11 | • Confirm step on cancel ("Cancel your Tue 14:00 Cut? Yes, cancel / Keep it"), without revealing lateness (TOKEN-03).<br>• `variant="destructive"`.<br>• All three forms on `Button`.<br>• The salon's phone as a `tel:` link in the shell. |
| **C4** | **Staff announcements and field errors** | S | accessibility #3, #4, #10 | • Every `aria-live` element renders unconditionally, as `status-actions.tsx:56` already does.<br>• A parse guard in the style of `voice.test` fails on any conditional live region (the A-096 rule: fix it once and shut the door).<br>• One `role="status"` per async panel: client picker, push preview, staff slot list, manage reschedule.<br>• Errors go through `Field`'s `error` prop; on a refusal that needs a reason, focus the reason input. |

### Next tier: real gaps, medium size

| # | Bundle | Size | From | Contents | Decision? |
|---|---|---|---|---|---|
| **C5** | **The client record can be corrected and explains itself** | M | operator #1, #2 | • Edit name, phone and email, scoped at the sink, derived through the D-55 functions. If the edit matches an existing client, offer a merge.<br>• An append-only pinned-note history with author and time.<br>• A save from a stale copy is refused, and both texts are shown. | Yes: the history's shape, and whether a stale save refuses or merges. |
| **C6** | **Focus management on staff screens** | S–M | accessibility #5, #6, #7, #8, #9 | • Status buttons are keyed by position, not by `to`.<br>• The client picker returns focus after a pick.<br>• If a refresh drops focus, it goes to the column heading.<br>• A skip link and a "jump to now" link.<br>• Chip status button `min-h-6`, with the client's name in sr-only text.<br>• Break and time-off spans get an sr-only label (the `aria-label` on a generic span is dropped).<br>• Gap names start with the visible text (2.5.3). | No |
| **C7** | **The design system reaches the busy screens** | M | ux-design #1–#8 | • `Button` and `Field` in `status-controls.tsx`, `column-controls.tsx` and `booking-panel.tsx`.<br>• The `text-page-title` token on 19 pages, and `text-danger-ink` in 13 places.<br>• Copy fixes: "no show" becomes `STATUS_WORDS` on the detail page; "Bookings" becomes "Appointments" on the dashboard; the "Booking policy"/"Slot policy" headings; cross-links between People and Providers; "stylist" becomes "Provider" on staff surfaces (gut-check `people-list.tsx` first). | No. It overlaps C6's target size, so build it first or together. |
| **C8** | **Processing time looks like processing time** | M | stylist #2 | • A gap inside a segmented envelope reads "*Name* developing, back at 10:55" on the list, the chip and the print sheet.<br>• The colour row shows its worked blocks.<br>• A booking made into the gap says so.<br>• The fixture asserts both edges of each block (A-093). | Wording only |
| **C9** | **"What changed on my column today"** | M | stylist #3 | • Per-row "moved from 14:00 · Sam · 11:02", read from `AppointmentEvent`.<br>• Actor and time on the running-late header.<br>• A "printed 08:45" stamp on the sheet, with "changed since print (3)" on screen. | Yes: which events count as "changed". |
| **C10** | **"Owed a rebook" worklist** | M | operator #3 | • A derived list of salon-cancelled appointments whose client has nothing ahead, with one tap into prefilled staff booking and the A-072/A-077 call marks.<br>• Bulk cancel on conflicts, with the reason typed once.<br>• **The operator says this replaces the D-68 "rebook-rate read model" candidate.** | Yes: whether client cancels belong on the list. |
| **C11** | **Standing appointments don't quietly run out** | M | operator #4 | • A "series ending soon" list with "extend by the same rule".<br>• The detail panel names the ordinals that never booked (`requested` against the occurrences that exist). | No |

### Needs a decision before anything else

| # | Bundle | Size | From | Why it needs the owner |
|---|---|---|---|---|
| **C12** | **Undo a mis-tapped forward status move** | M | stylist #4 | This amends §7's transition table, the way D-46 and D-53 did: one step back within about 10 minutes, staff only, and the timestamp that tap set is cleared. A wrong Finish currently seeds the running-late cascade (D-64). |
| **C13** | **Online-booking flood and shared-wifi fallout** | S–M | operator #5 | **Partly conflicts with D-69.** D-69 rejected a dedicated "too many" message on slot reads because no single person reaches 60 reads in 5 minutes; the operator argues that a salon's guest wifi does. The operator's other points do not reopen D-69: count only non-cancelled online bookings toward the cap, a staff list of recent online bookings with a bulk silent cancel, and a "paused" badge. **Caveat on "non-cancelled":** a book-then-cancel loop would then never spend the cap. Weigh that before accepting it. |
| **C14** | **The PIN knows which column is yours** | M | stylist #5, #7 | A nullable `StaffUser.providerId`, so that signing in with a PIN lands on your own column. Plus now/next on the list. D-36 (no new role) stands. The owner needs to confirm that stylists really share the terminal by PIN. |
| **C15** | **Booked value on the dashboard** | M | operator #6 | Dollars lost to no-shows and late cancels, and freed time resold, from D-18's snapshotted prices, labelled "booked value". Payments stay a non-goal, and the owner confirms that framing. |
| **C16** | **"Book with *name*" copy** | XS | booking-client #5 | The link starts the ordinary flow (A-054 deleted URL prefill). Change the CTA text. |

### The operator's ranking of the D-68 candidates

| Candidate | Operator's call |
|---|---|
| Two-stylist visit linking | **Build.** A reschedule currently moves half a visit. |
| Rebook-rate read model | **Superseded by C10.** Build the worklist, not the percentage. |
| Oldest-first waitlist ranking | **Low.** Concede it in `DEMO.md`. |
| Recording request vs. anyone | **Low.** It settles commission disputes, and nobody loses a Saturday over it. |
| Reschedule counting | **Do not build** (see §5). |

---

## 4. What was verified before writing

Each check is a direct read or grep at `59de25b`:

| Claim | Evidence | Holds? |
|---|---|---|
| The `?provider=` list never refreshes | `useAutoRefresh` has exactly one caller, `day-grid.tsx:47`. `day/page.tsx:193` renders `ProviderDay` in place of `DayGrid`. | ✔ |
| A client's name, phone and email cannot be edited | The only `client.update*` writes are `setClientNotes` (`clients.ts:187`) and the merge (`:306-322`). Creation happens only in the two booking actions. | ✔ |
| A lost race wipes the typed details and leaves the stale error | `booking-flow.tsx:419-423` clears `time` and sets the step to `time`. `result` is not cleared. The error renders only on the details step (`:457`). | ✔ |
| Cancel on the manage page is one tap and 36px | `cancel-form.tsx:20-26`: one submit button with `px-3 py-2`, no confirmation. | ✔ |
| No focus management anywhere | `.focus()` and `autoFocus` have zero matches in `apps/web` outside tests. | ✔ |

---

## 5. Do not build (operator, endorsed by nothing contrary in the other four)

- **Reschedule counting as a reliability signal.** It punishes the behaviour the cutoff asks for, and the desk will learn to cancel and rebook to spare the client the mark.
- **A chronic-late-arrival flag derived from `checkedInAt − startAt`.** D-22 already says the check-in tap happens late when the desk is busy, so the flag would brand clients for the desk's backlog.
- **Automated waitlist offers (A-053).** Keep them blocked while OQ-4 is open.
- **More running-late cascade rows.** Concede the residue in `DEMO.md`, per the Phase 19 close.
- **A nightly demo reset, or live SMS.** D-65 and the non-goals stand.

---

## 6. Notes for whoever builds from this

- **Proposed copy has to pass `voice.test` (D-52).** Several reviewers wrote example strings with gendered pronouns. Treat their wording as intent, not as copy.
- **C1, C2 and C4 each add a guard, not only a fix.** C1 adds the staleness test on the list, C2 an e2e test for the `alternatives` branch, and C4 a parse guard against conditional live regions. Those are the parts that stop a recurrence.
- **C7 before C6**, or together: C6's target-size fix on the chip button lands differently once `Button` is in use.
- The four new agent definitions (`stylist`, `booking-client`, `ux-design`, `accessibility`) are in `.claude/agents/`, with their models pinned. Re-run them at the next milestone close alongside `salon-operator`.
