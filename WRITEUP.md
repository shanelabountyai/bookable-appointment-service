# Project Write-Up: Bookable

**Repo:** https://github.com/shanelabountyai/bookable-appointment-service (private)
**Live demo:** https://appt.labintelligence.co (shared password, see `docs/DEMO.md`)
**Built with:** Claude Code + Next.js, TypeScript, Postgres, Prisma
**Status:** In progress · Phase 22 of a multi-phase build · Last synced: 2026-09-29

---

## The Business Problem

A service business with more than one chair — a salon, a med spa, an HVAC crew — loses revenue to phone tag, double-bookings, and no-shows, and eventually gives up on software for a paper book because the screen stops matching reality: appointments run late, a stylist calls in sick with nine bookings on her column, a walk-in needs a chair *right now*. The product has to do two things at once — be a correct, race-proof booking engine, and be a staff surface that survives a busy Saturday — or the desk reaches for the paper book the first time the screen lies to them.

## What I Built

- A public booking flow (services → who/when → client → confirm) with a real availability engine behind it: weekly hours, day overrides, buffers, multi-service visits, and a "no preference" path that asks every qualified provider at once.
- Staff-side booking, a live day grid with per-column running-late and column-push tools, check-in/status transitions, a printable day sheet, and a conflicts workbench for reassigning a sick stylist's book.
- A concurrency-safe core: the database itself refuses a double-booking via an exclusion constraint, not application logic, so two people racing for the same slot get a real refusal, not a coin flip.
- A DST-correct time layer built and proven against a documented edge-case matrix, run twice in CI (`TZ=UTC` and `TZ=Pacific/Kiritimati`) so a timezone bug can't hide behind the machine's own clock.
- Client records, reliability flags, a waitlist, notification outbox with retry, an owner dashboard, and a five-lens accessibility/design/operator review that turned into a fourth build phase (staff live regions, focus management, the design system reaching the busy screens).
- 145 of 152 planned backlog items shipped; the remaining seven are gated on three owner decisions not yet asked.

## How It's Built

Next.js (App Router) + TypeScript over Postgres via Prisma, split into `packages/core` (pure domain logic — the slot engine takes `now` as a parameter and never reads the system clock), `packages/db` (schema, hand-written migrations, and the write paths that touch the exclusion constraint), and `apps/web`. Money is integer cents. Every core table carries `businessId`, so multi-tenancy is a cheap, real boundary rather than a retrofit.

**Key design decisions**

| Decision | Alternative considered | Why I chose it |
|---|---|---|
| No-overlap is a partial GiST exclusion constraint on `(providerId, tstzrange(blockedStart, blockedEnd, '[)'))`, hand-written SQL | Check-then-write in application code | A check-then-write is a race by construction under concurrent load; the database is the only thing that can refuse atomically. App code maps `23P01` → `SlotTaken` → 409 — never `23505`, which Prisma won't even surface as `P2002` here |
| Two time axes, branded and never mixed: `CalendarDay`/`WallTime` for rules, `Instant` for anything booked, one conversion module whose `resolve()` returns `unique \| gap \| ambiguous` | A single `Date`-based representation | `@db.Date` → JS `Date` cost a sibling project a silent day-west shift with ten green tests. A calendar day is stored `CHAR(10)`; `new Date(string)`, `getTimezoneOffset` and friends are banned by lint, repo-wide |
| A slot's identity is its instant — never `{date, time}` in a URL, token, or form payload | Passing the wall-clock label the customer read | On the day the clocks fall back, "01:30" names two different instants. A payload built from the label is a coin flip about which one |
| Reschedule is a same-row `UPDATE` inside one transaction, not cancel-then-book | Two-row cancel-then-insert across two transactions | Two transactions can leave a customer with no appointment if the second one fails. One transaction re-runs the engine and writes one event; cancel-then-insert is only safe *inside* that same transaction, and the code says so |
| Staff overrides write a zero-width blocked range plus the original range for display | Refusing every staff double-book like the public site does | "Impossible" has to mean impossible *by accident*. The constraint never lies — the day view renders the true collision — but a reason-required, audited override is how a real desk survives a sick stylist |
| Tests run against local Postgres, e2e against a production build, both under two opposite timezones | A single CI timezone; a dev server for e2e | A UTC-only CI hides exactly the DST bugs this project exists to catch; a dev-server e2e run is a different artifact from the one that ships |

## Skills Learned / Functions Unlocked

- **A pure, TDD-built slot engine** proven against a documented edge-case matrix (`docs/reviews/03-slot-engine-spec.md`) with hand-verified DST instants, taking `now` as an argument so no test can pass by accident of when it ran.
- **Concurrency correctness by database constraint, not by code path** — a partial GiST exclusion constraint doing the job a hundred lines of locking logic usually tries and fails to do, with deterministic barrier-based race tests (`packages/db/booking/races.test.ts`) instead of retry-until-flaky ones.
- **A repo-wide parser guard as a recurrence-prevention mechanism** — `voice.test.ts` walks the TypeScript AST to keep gendered pronouns out of rendered copy (a grep can't tell a JSX text node from a comment; a parser can), and this phase's own `aria-live.test.ts` uses the same technique to keep every staff announcement region from silently regressing into the "mounts with its text already inside it" bug.
- **Reading a UI bug off a document instead of off a screen** — the printed day sheet caught a rendering defect that forty green axe runs, four demo walk-throughs, and every unit test had walked past, because a table has to say with a *sort order* what a grid says with a *position*, and a wrong position is invisible while a wrong order is not.
- **State-machine transitions as one total, exhaustively-typed table**, so a ninth appointment status or a new "who may push this" list is a compile error everywhere it isn't handled, not a silent gap three screens later.

## The Hardest Bug

Not a crash — a colour drawn in the wrong place, at a third of its height, for two months, past three demo checkpoints and every automated check the project had.

`findBusyAppointments` returns one row *per worked block* of a segmented service (a colour's develop time is a separate block from its application and finish), keyed by the appointment's own id — that's the entire mechanism a prior phase built to model gaps inside a service. The day grid's renderer joined that list back into a lookup with `new Map(busy.map(b => [b.id, b]))` — and a `Map` built from duplicate keys keeps the *last* one. So a two-hour colour appointment, drawn from its own busy rows, collapsed onto its final 55-minute block: a chip that should have started at 09:00 was drawn at 10:25, at a third of its real height, with the hour the stylist spends actually applying the colour rendered as empty column.

Every test stayed green because the bug only moved the *start*. The gaps around the appointment are computed by subtracting the busy spans from the day — and those were still correct, because the collapse kept whichever block happened to be last, and the free time after the appointment doesn't care which block supplied it. An assertion on the *end* of a span passes against this bug every time; only an assertion on *both* edges can catch it. And it needed a fixture nobody had written: a segmented service is the salon's single most valuable offering and the only kind of appointment that produces more than one busy row per id, so no unit test, e2e spec, or seeded demo book had ever exercised the code path where the last-wins collapse mattered.

What actually surfaced it was building the *printed* day sheet — a second renderer for the same data, driven by a table instead of a grid. A table can't express "these two things happened at the same time" with position the way a grid can; it has to say so in a sort order, and the print renderer sorted a 09:30 appointment *above* the 09:00 colour that visually overlapped it on screen. Reading that page top-to-bottom made the wrong start time obvious in about four seconds, in a way that four months of the wrong pixel position on a grid had not been. The fix was four lines — min-start, max-end across an appointment's blocks — and the regression guard (`sheet-parity.test.ts`) now asserts that every field the grid's chip reads is either present on the printed sheet or explicitly, checkably exempted, so the next field nobody thinks about a second renderer for fails loudly instead of quietly.

## What I'd Do Differently

- Build the token/design system earlier. It arrived after most of the staff screens already existed as hand-rolled zinc classes with hand-written dark-mode twins, and retrofitting it onto every screen (and finding the accessibility debt hiding under the retrofit — see below) was a bigger sweep than building it up front would have been.
- Run the accessibility sweep in *both* colour schemes from day one. Playwright's default is light mode, and a palette built to flip with `prefers-color-scheme` went unmeasured in dark mode for months: 275 contrast violations across twelve staff routes, all the same value, invisible to forty consecutive green axe runs because every one of them happened to render the light theme.
- Write the "two answers to one operational question must be equal" assertion the first time a fallback path exists, not after a real gap shows up. Three separate defects in this project were exactly that shape — an offer and a write disagreeing, a "no preference" fallback silently asking the *old*, stricter question, a per-day filter loading a whole year of spanning rows — and each one was caught by adding the same kind of test after the fact rather than by a standing rule.

## By the Numbers

- 46 calendar days (2026-08-14 to 2026-09-29), 395 commits.
- About 40k lines of app source across `apps/web`, `packages/core` and `packages/db` (excluding tests and generated code).
- 1,791 unit/integration tests (plus 1 pre-existing, tracked skip) run under two opposite timezones, and 352 of 353 end-to-end specs at the last full run (the one failure is a pre-existing e2e fixture that reads the real wall clock — see `NEXT.md` — not a product defect).
- 145 of 152 backlog items shipped, 71 recorded architectural decisions, across four build phases plus a five-lens review that opened a fourth.
- Seed data: one synthetic salon ("Shear Genius"), its providers, services and a demo book; no real clients.

---

*Part of my Claude Code build log: https://claude.ai/artifact/28KeGV3xfBwcBuoMEQjFMj*

---

## Build log

### The slot engine and the two-axis time model (Phase 1)

**Problem:** almost every scheduling bug in software this category ships is a timezone bug wearing a different costume — a date stored as a database `date` reads back a day off, a fall-back-day booking is ambiguous about which "01:30" it means, a duration computed as a wall-clock delta silently changes when it crosses a DST boundary.

**Design:** two branded, non-interchangeable axes. `CalendarDay`/`WallTime` for *rules* (weekly hours, override days) and `Instant` for anything actually booked, with exactly one conversion module whose `resolve()` returns `unique | gap | ambiguous` rather than a bare value a caller could misuse. `CalendarDay` is stored `CHAR(10)` — `@db.Date` is banned by lint alongside `new Date(string)`, `Date.parse`, `get/setHours`, and `getTimezoneOffset`, because every one of them is a silent axis-crossing through the process timezone. The engine itself takes `now` as a parameter and is proven against a hand-verified DST edge-case matrix (`docs/reviews/03-slot-engine-spec.md`).

**Deliberately not:** a third-party scheduling library, or computing durations as wall-clock deltas — a 90-minute service starting at 01:30 on spring-forward day ends at 04:00 on the wall, because duration is physical seconds. CI runs the whole suite under `TZ=UTC` and `TZ=Pacific/Kiritimati` specifically because a UTC-only CI hides exactly this bug class.

### No-overlap as a database constraint, not application logic (Phase 1)

**Problem:** "the app never double-books" has to be true under real concurrency, and a check-then-write in application code is a race by construction — two requests can both read "free" before either writes.

**Design:** a partial GiST exclusion constraint on `(providerId, tstzrange(blockedStart, blockedEnd, '[)')) WHERE status NOT IN (terminal set)`, hand-written into a migration rather than generated. The database refuses the second write outright; app code catches SQLSTATE `23P01` and maps it to a 409, and never treats the check as the correctness mechanism — `READ COMMITTED` is sufficient *because* the constraint exists underneath it. Half-open ranges (`'[)'`) everywhere, constraint through engine through tests, because `'[]'` makes back-to-back appointments false-conflict and a salon could never book consecutive clients. Buffers are stored columns (`blockedStart`/`blockedEnd`, body plus buffer), so a buffer-only overlap is refused by the same constraint that catches a body overlap.

**Proving it:** deterministic, barrier-based race tests (`packages/db/booking/races.test.ts`) — two attempts released at the same instant by a real synchronization barrier, not a retry loop hoping for bad luck — assert exactly one wins and the loser's refusal names who got there first. A later phase split the constraint in two (envelopes for the same holder may overlap; bodies never do) and had to be threaded through every reader that models the room independently of the database, not only the writers — the availability sweep, the push planner, anything predicting an answer the constraint doesn't get asked to give.

**Deliberately not:** optimistic locking as the primary mechanism, or a serializable isolation level — the constraint makes both unnecessary for this invariant, and using them anyway would have hidden the fact that the guarantee no longer lived in the database if someone later removed it.

### Staff overrides: "impossible" has to mean impossible by accident (Phase 2)

**Problem:** a public customer must never be able to create a conflict, but the operator's hardest-won point from the domain review was that every real booking platform that fails on staff dies of a flat refusal — a sick stylist, a walk-in that has to happen, a wedding party squeezed in with the owner's blessing.

**Design:** staff can knowingly double-book, book outside hours, or book into a buffer — a reason is required, an audit event is written, and an override marker renders wherever that appointment shows up. Mechanically, a staff override writes a *zero-width* blocked range into the exclusion constraint's table, plus the original range kept separately for display: the constraint itself never lies about what's actually occupying the provider's time, and the day view renders the true collision using the display range. Time off and ad-hoc blocks are deliberately kept *outside* the constraint's table for the mirror-image reason — blocking over an existing booking must surface the conflict for a human to resolve (a stylist calling in sick with appointments already on her book), not be silently refused by the database.

**Deliberately not:** a second, looser constraint for staff writes, which would have meant maintaining two definitions of "occupied" that could disagree. One constraint, one exception mechanism, recorded rather than hidden.

### Reschedule as a same-row transaction (Phase 2)

**Problem:** the product-owner review proposed marking the old appointment `rescheduled` and inserting a new row — clean from a reporting angle, until the concurrency spec asked what happens if the insert fails after the old row is already marked gone. A customer can end up with no appointment at all.

**Design:** reschedule is a single-row `UPDATE` inside one transaction, re-running the full engine against the new time and writing one `AppointmentEvent` recording both sides. There is no window where the appointment exists in neither its old nor its new state. Cancel-then-insert *is* acceptable, but only inside one transaction — the distinction the codebase insists every comment near this pattern spell out explicitly, because "two transactions" and "one transaction with two statements" look identical in a diff and are not identical in a failure.

**Deliberately not:** a status-based history model for reschedules. The event log carries the history; the row carries the current truth, and there is exactly one of it.

### The day the colour was drawn nowhere (Phase 3 — see "The Hardest Bug" above)

Covered in full above: a one-to-many read collapsed to last-wins by a naive `Map`, invisible to every test because only the *start* of a segmented appointment moved and every existing assertion checked the end. Found by building a second renderer (the printed day sheet) whose only way to express simultaneity is a sort order, not a pixel position.

### Two more read-model defects, same family (Phase 3)

**Problem:** a read model that predicts a chooser's answer has to ask the chooser's exact question, or it will be right on every simple fixture and wrong only where the room is actually interesting — which is precisely the case a simple test suite never generates.

**Design, first case:** a day's absence conflicts were computed by loading *every* time-off and ad-hoc block a provider had ever had, with no date filter at all, and asking each one "who do you strand?" — correct for a single-day absence, silently wrong for a week-long one, which answers for the whole week and puts every client in it onto every `?day=` query for the rest of the year. The fix inverts the direction of the question: ask it from the day's own rows outward, never from the spanning rows inward, which is the only direction that can't return a member of the wrong day.

**Design, second case:** the "book with anyone" fallback, when the preferred provider comes back with nothing, asked `listTimesOn` with that provider's id still attached — because the reason the preferred answer was empty is usually that the provider is gone for the day, and the fallback then asked "what does the absent provider have free," which is empty by construction and gets silently swallowed into "nobody is free," a *different* wrong answer than the one the client actually needs. The fix separates "ask everyone" from "ask the one preference," and a fixture where exactly one person can take the instant is what finally made the bug reachable — every fixture with uniform hours made the two questions return identical answers.

**Deliberately not:** a single shared query object for both operations. The two questions are genuinely different operations most of the time; the fix is asking each one correctly, not merging them into one query that would then need its own branch for which caller it's serving.

### A new parameter is never one edit, and the callers that matter are the ones that already have the answer (Phase 4)

**Problem:** a room-sharing feature needed to know "who would actually be sitting in this chair" threaded through every write path that could create a conflict — reschedule, change-services, the booking re-check. Two callers were missed, and they weren't the ones that pass the value today; they were the ones that *already know* the value and default to `null` because nothing forced them to pass it.

**Design:** the parameter defaults to the strict question ("assume no sharing") rather than the permissive one, which is the safe default for a value nobody supplies — except it means a caller that already resolved the client five lines above, and simply forgets to pass it, compiles, passes every existing test, and silently asks a stricter question than the write path will actually enforce. The fix isn't a stricter type (both call sites pass a real, typed value); it's an assertion that the two answers to one operational question — "what would the room say" and "what did we actually offer" — are equal, run against a room interesting enough for the answers to differ when the parameter is wrong.

**Deliberately not:** making the parameter required at the type level everywhere. Two legitimate callers genuinely don't have a client yet at the point they need to ask the question — that's the shape of a booking panel before anyone is selected — so the fix has to be a runtime equality check between two independently-computed answers, not a type that can't express "I don't have one yet."

### A truncated warning that no automated check could see (Phase 4)

**Problem:** a no-show warning ("⚑ 3 no-shows in the last 12 months. Cannot book online — the desk can.") was 386 pixels wide rendered into a 185-pixel chip. Every tool in the accessibility and testing gate — axe, `toBeVisible()`, the accessible-name computation — reported it as fine, because all of them read either the DOM's full text content or the accessible name, and CSS `overflow: hidden` touches neither. Nine real records in the seeded book had the second half of the warning — the operationally important half — never once rendered on screen, through four demo walk-throughs.

**Design:** the only assertion that can tell a legible line from a silently clipped one compares `scrollWidth` to `clientWidth` and prints both on failure. The actual fix is a genuinely shorter message ("Desk only · 3 no-shows") rather than a smaller font or an ellipsis, because a short form that merely *fits* the current fixture is the same bug at a longer name or a fourth no-show — the replacement had to be shorter than the space available, not shorter than the original string. And the fixture itself needed its own assertion: a test string chosen to be "long enough to overflow" has to fail loudly the day it stops being long enough, or a future edit that shortens the surrounding layout goes green and silent.

**Deliberately not:** truncating with an ellipsis and a tooltip. A desk employee scanning a busy grid under time pressure isn't going to hover to discover the fact that decides whether a client can be trusted to book online unsupervised.

### The accessibility check that only ever ran one way (Phase 4)

**Problem:** a design system built explicitly to flip its palette with `prefers-color-scheme` had 275 colour-contrast violations across twelve staff routes — one value, repeated everywhere `text-zinc-500` sat on the dark theme's background — invisible to forty consecutive green automated accessibility runs.

**Design:** Playwright's default colour scheme is light, and no spec anywhere had explicitly requested dark, so a suite that looked exhaustive had in fact measured exactly half of the product. The fix moves the scheme loop into the one shared helper every accessibility check goes through, and closes the other door with a lint rule banning direct imports of the underlying accessibility library from spec files — so the next spec, written the obvious way, can't reopen the gap. Two smaller findings rode along: a sweep that reported "46 routes clean" was actually rendering the login page 46 times behind a redirect race, and a CSS class that hadn't been generated at all would have inherited the *foreground* colour and passed a contrast check by accident, rendering muted text as primary text — both invisible without printing the actual URL measured and checking the built artifact rather than inferring correctness from the absence of failures.

**Deliberately not:** trusting a green accessibility run as proof of anything without first confirming what page, in what state, in what colour scheme, it actually rendered.

### A parser as the guard, twice (Phase 1 and Phase 4)

**Problem:** a copy defect ("She came" printed under every row of a 124-row worklist, when the product stores no gender for anybody) and an accessibility defect (an announcement region that mounts at the same moment as its own text, which is silent to a screen reader) are both the kind of thing that compiles clean, passes every existing test, and is invisible to a tool that only understands rendered pixels or accessible names — because the defect is about *when* something is true, not what.

**Design:** both guards parse the TypeScript AST directly (the `typescript` package's own compiler API) rather than grepping source text, specifically so a defect *inside a comment* doesn't count and a defect *inside real JSX or a string literal* can't hide. `voice.test.ts` walks every string literal, template chunk, and JSX text node for a gendered pronoun; `aria-live.test.ts` (this phase) walks every `aria-live` element and asks whether it sits on the gated side of a ternary or `&&` whose other branch renders nothing — the exact shape of "this element's existence, not just its content, depends on a condition." Both tests assert a synthetic self-test fires on the historical defect and stays silent on the correct pattern before ever trusting the real-codebase assertion, and both explicitly exempt one legitimate look-alike (test narration for the first; a form field's deliberately-absent error slot for the second) by the *shape* of the exemption rather than by naming files, so patching the exemption can't quietly become a new way to hide a real instance.

**Deliberately not:** an ESLint rule. Comments aren't AST nodes and test narration constantly uses the words a lint pattern would have to allow-list, which is exactly the kind of allowlist that rots into "patched the rooms that noticed, left the door open."
