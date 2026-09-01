# Bookable — design brief

**For: Claude Design.** Written 2026-09-01, at the Phase 7 boundary.

This is the input for building Bookable's design system and UI/UX component
library. It is deliberately specific about the *operating conditions* rather
than about taste: this product's whole risk is that it looks fine in a
screenshot and fails at 8:45 on a Saturday with a phone ringing.

Everything below is drawn from the shipped code, not from a wishlist. Where the
brief says a thing does not exist, it has been checked.

---

## 1. What the product is

Appointment scheduling for a small service business. The sample tenant is a
four-chair hair salon, and every design decision should be tested against that
salon rather than against an abstract "booking app".

Three audiences, three completely different postures:

| Audience | Where they are | Posture |
|---|---|---|
| **The front desk** | Behind a counter, on a tablet or a laptop, standing | Interrupted every ninety seconds. One-handed. Never reads a screen twice. |
| **The stylist** | At the chair or the backwash, on a phone, hands wet or gloved | Glances. Wants one fact. |
| **The owner** | End of the week, on a laptop, sitting down | Reading, comparing, deciding. |
| **The client** | Anywhere, phone, probably at night | Has never seen this before and will not see it again for six weeks. |

The desk is the primary user. When a design choice helps the owner and costs
the desk a tap, the desk wins.

---

## 2. The five moments the design has to survive

Design for these, not for the empty-state screenshot. Each is a real screen in
the product today.

1. **8:45 Saturday, printing the day.** The broadband is flaky. One page per
   stylist, off a laser printer, pinned at each station. It must be legible in
   greyscale at arm's length. (`/staff/day?sheet=1`)
2. **Dana is forty minutes behind.** The desk marks the delay; every chip in
   her column now shows a booked time *and* a likely time, the site stops
   selling her next slot, and six clients need ringing. Two numbers on one chip
   that must never be confused. (`/staff/day`)
3. **A walk-in at the counter while the phone rings.** Search a client, or
   don't — book with no client record at all — pick a service, pick a time,
   done. Every extra field is a booking that happens on paper instead.
   (`/staff/book`)
4. **"That time just went."** Two people booked the same chair a second apart.
   The loser sees a refusal, a reason, and either the next free stylist or an
   explicit override with a typed reason. The override marker must stay rare
   enough that staff still read it.
5. **A cancellation on Saturday for next Thursday.** Three hours of the
   salon's most valuable service, invisible unless a screen goes and finds it.
   (`/staff/opened`)

---

## 3. What exists today — an honest audit

### The public site has a design. The staff app does not.

**Public marketing pages** (`/`, `/services`, `/stylists`, `/visit`) have a
committed identity, already contrast-audited:

- Grounds: bone `#F5F0E8`, paper `#FBF9F5`, rule `#E2DACD`
- Ink: `#171310`, secondary `#4A423B`, muted `--color-muted-ink #6E6357`
- Accent: `--color-clay #B26B47` for **graphics only** (3:1 bar), and
  `--color-clay-ink #8E5236` / hover `#6F3E28` for **text** (4.5:1 bar, passes
  on both grounds). These are two tokens on purpose — one hex could not do both
  jobs, and axe failed every marketing page at once when it tried.
- Type: `Instrument_Serif` display (`--font-display`), `Karla` body
  (`--font-body`).
- The site **commits to light** and paints it explicitly. It does not inherit
  `prefers-color-scheme`.

**Staff app** (everything under `/staff`) is raw Tailwind utility classes —
`border-zinc-400`, `dark:border-zinc-600`, `rounded-md px-3 py-2` — repeated by
hand on every page. There are no tokens, no shared primitives, and no visual
hierarchy beyond `font-medium`. It works and it is accessible; it is not
designed.

**shadcn/ui is configured but not installed.** `components.json` exists
(`new-york`, base colour `zinc`, CSS variables, lucide icons) and
`components/ui/` **does not exist**. Nothing imports a shadcn primitive. This is
scaffolding somebody set up and never used — treat it as a stated intent, not
as an existing system.

**`components/` contains exactly two things**: `client-flag.tsx` and
`date-jump.tsx`, plus `components/site/logo.tsx`. Everything else lives beside
its route as a co-located `*.tsx`.

**There is no global staff navigation.** `/staff` is a bare list of links;
`/staff/day` re-declares its own row of buttons; other pages have a single
"← Today" back-link or nothing. Fifteen screens, no shared chrome beyond the
desk-switcher bar. **This is the largest single UX gap in the product.**

### What is already right and must not be lost

- **Print is a first-class medium.** `globals.css` overrides the dark palette
  under `@media print` because dark-mode text prints as nothing. `@page
  { margin: 12mm }`.
- **Never colour alone.** Status, the client reliability flag, the override
  marker and the running-late state all carry words and/or a glyph; colour is
  decoration on top. (WCAG 1.4.1, and `client-flag.tsx` says so in a comment.)
- **Small grey text is where contrast quietly fails.** The day grid uses
  `zinc-600` and not the `zinc-400/500` that "reads better", because at 12px
  those measure 2.6:1 and 4.4:1. Any new muted token must be checked at its
  real size on its real ground.
- **The desk switcher is a native `<details>`**, not a popover — keyboard and
  screen-reader correct for free, and collapsed to one line because the answer
  is usually "yes, still me". The PIN field is `inputMode="numeric"` so the
  tablet shows a keypad.
- **Every time on screen is formatted server-side in the salon's timezone.**
  There is no `Date` in the day grid's client component, deliberately.

---

## 4. Non-negotiable constraints

These are correctness rules, not preferences. A design that breaks one is
wrong even if it is beautiful.

### Accessibility
- **CI runs axe on every staff and public surface** with
  `wcag2a, wcag2aa, wcag21a, wcag21aa` and asserts `violations == []`. A
  component that cannot pass will not ship.
- 4.5:1 for text, 3:1 for graphical objects and UI boundaries — **at the size
  and on the ground it actually renders on**, not on white.
- Never colour alone. Every state needs a word, a glyph, or both.
- Every interactive control is keyboard operable with a visible focus ring.
  Scrollable regions that may contain nothing focusable get an explicit
  `tabIndex={0}` (the day grid and room strip already do — a day where every
  stylist is off has no focusable child and a keyboard could not scroll it).
- Live regions: `aria-live="polite"` for form results, already used.
- `aria-current="page"` for the selected stylist / view tab.

### Time and identity
- **A slot's identity is an instant, never `{date, time}`.** On the autumn
  fall-back day "01:30" names two different instants. No URL, form field, or
  data attribute may carry a wall-clock time as an identifier.
- When a wall time is ambiguous, the timezone abbreviation is rendered beside
  it (e.g. `01:30 CDT`). The design must leave room for that suffix.
- A chip may show **two times at once** — the booked time and the projected
  time when a column is running late. These must be visually distinguishable
  at a glance and unambiguous in the accessible name. Getting this wrong puts
  the paper book back on the counter.
- Money is integer cents. Render as currency; never do arithmetic in the UI.

### Print
- `/staff/day?sheet=1` is a real deliverable: one column per page, page breaks
  between stylists, greyscale-legible, no background-dependent contrast.
- Anything that only works because of a background colour is invisible on
  paper.

### Density and touch
- The day grid is **1.5 px per minute** — a 45-minute service is a chip tall
  enough for two lines of text. Any type scale must work inside that.
- Primary desk targets are ≥44px on the tablet. The grid chip is the exception
  and is compensated by a detail panel.
- The grid auto-refreshes every 15 seconds via a server round-trip. Nothing may
  flash, jump, or lose focus on refresh.

### Dark mode
- The staff app currently supports `prefers-color-scheme` throughout
  (`dark:` variants everywhere) and must keep doing so — the salon's tablet
  sits under a window and the desk switches.
- The public site deliberately does **not**. Keep that split.

---

## 5. What we want from you

### 5.1 A token layer

Define, as CSS custom properties in `app/globals.css` under `@theme inline`, a
single set of semantic tokens the staff app can be rebuilt on. Name them by
role, never by value.

- **Ground**: page, raised surface, sunken/inset, overlay
- **Ink**: primary, secondary, muted (checked at 12px), inverted
- **Line**: hairline, control border, strong/selected
- **Intent**: neutral, positive (confirmed / here), attention (running late,
  no-show, override), danger (cancelled, destructive action), information
  (checked in, in progress)
- **Focus ring**, **selection**, **disabled**
- Radius scale, spacing scale, shadow scale (probably two steps — this is a
  flat product), and one motion duration + easing pair.

Every intent token needs a light value, a dark value, and a stated contrast
result against its own ground.

**The public site's palette stays as it is.** Do not fold it into the staff
tokens; they are two surfaces with two jobs. If anything, name the shared
concepts so a future third surface can pick a side.

### 5.2 A type scale

One family for the staff app (currently Geist Sans). Give us a scale with
named roles: `display`, `page-title`, `section`, `body`, `body-sm`, `label`,
`caption`, `numeric`. The salon reads a lot of times and durations — say
whether numerics are tabular, and where.

### 5.3 Primitives

Build these as the base layer. Prefer native elements wherever one exists — the
product already reaches for `<details>` over a popover and
`<input type="date">` over a picker library, and that instinct should survive
the design system.

`Button` (primary / secondary / quiet / destructive, with a pending state —
every mutating control in this app goes through `useActionState` and has a
`pending` boolean), `Link`-as-button, `Input`, `Select`, `Textarea`,
`Checkbox`, `Radio`, `Field` (label + hint + error, `aria-describedby` wired),
`Badge`, `Card`, `Panel`/`Disclosure` (native `<details>` under the hood),
`Tabs` (as links with `aria-current`, not JS state — these are URLs),
`Table`, `EmptyState`, `InlineAlert` (four intents), `Toolbar`, `Sheet`/
`Drawer` for the appointment detail, `Toast`-or-live-region for action results,
`Skeleton`.

### 5.4 Domain components — the ones that matter

These are the product. Give each one a full state matrix.

1. **`AppointmentChip`** — the atom of the day grid. Positioned absolutely on a
   1.5px/min scale, height = duration. Must carry, without becoming unreadable
   at 45px tall: client name, service, status, an override marker, a
   per-visit note, a client-reliability flag, and — when the column is running
   late — the booked time *and* the projected time.
   States: `booked`, `confirmed`, `checked_in`, `in_progress`, `completed`,
   `no_show`, `cancelled`, `cancelled_late`; × override / not; × has-note; ×
   flagged client; × running-late projection; × conflicting-with-time-off.
   Current colours (a starting point, not a decision):
   confirmed emerald, checked-in/in-progress sky, no-show amber.
2. **`ProviderColumn`** — a stylist's day. Header with her name, working hours,
   a running-late control, and a "push the column" action. Handles: no hours
   today, hours changed underneath a booking, time off drawn over the column,
   gaps inside a service (a colour's develop time is sellable).
3. **`DayGrid`** — N columns side by side with a shared time gutter, horizontal
   scroll on the tablet, plus a single-stylist view. Ticks, now-line, and a
   room/chair strip beneath it.
4. **`DaySheet`** — the print artefact. Not a styled DayGrid; a different
   document. One column per page, a blank scribble column, per-visit notes and
   pinned client notes visually distinct from each other.
5. **`SlotPicker`** — the shared control behind public booking, staff booking,
   reschedule and "anyone at two". Shows offered instants; on staff surfaces it
   can show *why* a time is excluded; **on public surfaces it must never**
   ("overlaps booking" tells a stranger exactly when a stylist is with a
   client).
6. **`ClientPicker`** — search-or-create, used by staff booking and (next item)
   attaching a client to a walk-in after the fact. **One picker in the product,
   not two.**
7. **`ClientFlag`** — reliability, as a sentence with a window ("2 no-shows in
   the last 12 months"), never a bare count, never colour alone. Appears on
   five surfaces.
8. **`FreedSlotRow`** — `/staff/opened`. A span of time that just became
   sellable, *why* it became sellable in the desk's own words ("Mrs Hall
   dropped her Colour", "moved to Thursday", "Cancelled late by …"), the
   minutes, the stylist, a `tel:` link, and a one-tap route into the waitlist
   matcher. Four `freedBy` kinds today: `cancelled`, `shortened`,
   `rescheduled`, `reassigned`.
9. **`CallDownRow`** — tomorrow's unconfirmed clients, with per-client attempt
   marks (rung / no answer / left a message), actor-stamped and re-stampable.
10. **`ConflictRow`** — an appointment that a hours change or a time-off entry
    has stranded. Must *surface* the collision for a human rather than hide it,
    and offer acknowledge / move / reassign.
11. **`OverrideMarker`** — the single most important visual in the product. It
    means "a human deliberately booked over the rules and typed a reason". It
    must be unmistakable and it must stay rare; if the design makes it cheap or
    decorative, the whole safety model degrades.
12. **`RunningLateBanner`** + **`ColumnPushControl`** — set a delay, preview the
    effect ("moves 6, leaves 2, Dana then shows 0 behind"), commit.
13. **`StatusControl`** — the check-in → in-progress → completed / no-show
    path, plus correction. Terminal states still occupy their time; the UI must
    not imply otherwise.
14. **`MoneyAmount`**, **`Duration`**, **`InstantLabel`** (with the ambiguity
    suffix), **`DayNav`** — small, but they are the units the whole product is
    written in.

### 5.5 Navigation

Design the staff shell. Today there is none. Constraints:

- The desk-switcher bar ("At the desk: Dana") sits above everything and is
  already built as a `<details>`; keep its behaviour, restyle it.
- The day grid is the home screen in practice, not `/staff`.
- Two badge counts must be visible from anywhere: **"Opened up (N)"** and
  **messages that failed to send (N)**. Both exist and both are currently
  buried.
- Owner-only surfaces (dashboard, reports, settings) should be visibly a
  different tier from desk surfaces.
- It has to work at tablet width in landscape, one-handed, without a hamburger
  that costs two taps to reach the thing the desk does forty times a day.

---

## 6. Surface inventory

Every route that exists, what it is for, and where the design pressure is.

### Public
| Route | Job | Pressure |
|---|---|---|
| `/` `/services` `/stylists` `/visit` | Marketing. Already designed (bone/clay/serif). | Leave alone unless asked. |
| `/book` | The client's booking flow: service → stylist (or "no preference") → time → details. | Mobile, at night, one shot. Never leak why a slot is unavailable. |
| `/manage/[token]` | Confirm, reschedule or cancel from a link in a message. | The visitor has no account and no context. Deliberately bare — no site chrome. |

### Desk (front-of-house)
| Route | Job |
|---|---|
| `/staff/day` | **The home screen.** Grid of columns, single-stylist view, room strip, running-late, push-column, print, and the tabs into everything below. |
| `/staff/day?sheet=1` | The printed day sheet. |
| `/staff/book` | Book at the counter. Search-or-create client, or none at all. |
| `/staff/appointments/[id]` | One appointment: status, move, change services, notes, event history, end-series. |
| `/staff/opened` | What just became sellable, and why. |
| `/staff/waitlist` | Waitlist entries, and the freed-slot matcher. |
| `/staff/call-down` | Tomorrow's unconfirmed, with attempt marks. |
| `/staff/conflicts` | Bookings stranded by an hours or time-off change. |
| `/staff/clients` `/staff/clients/[id]` | Client search, record, history, notes, merge. |
| `/staff/messages` | The notification outbox, with failures counted. |
| `/staff/login` | PIN / password. |

### Owner / configuration
| Route | Job |
|---|---|
| `/staff/dashboard` (+ `/appointments`, `/overruled`) | Utilization, no-shows, overrides. |
| `/staff/availability` | Weekly hours and one-off day overrides. |
| `/staff/providers` `/staff/people` | The roster, and who has a desk PIN. |
| `/staff/services` | Services, durations, buffers, and segment editing (a colour's develop gap). |
| `/staff/resources` | Chairs / rooms. |
| `/staff/settings` | Business-level rules — lead time, cancellation cutoff, booking horizon, timezone. |

---

## 7. Voice

The product's copy is already written in a specific register and the design
must not fight it. It is the language of a person who runs a salon, not of a
scheduling system.

- "What's opened up", not "Available inventory".
- "Who wants this slot?", not "Match waitlist".
- "That's me", not "Confirm identity".
- "Nobody else has a desk PIN yet. Add one under Settings → Who works here." —
  empty states say what to do next, by name.
- "2 no-shows in the last 12 months" — a number always carries its window.
- Refusals name the cause and offer the next action. Never "Error".

Design empty states, error states and confirmations as **sentences**, not as
labels with an icon.

---

## 8. Deliverables

1. A token sheet — colour (light + dark + contrast results), type, spacing,
   radius, shadow, motion — as CSS custom properties ready to paste into
   `app/globals.css`.
2. Primitive components, styled, with every state drawn: rest, hover, focus,
   active, disabled, pending, invalid.
3. The domain components in §5.4, each with its full state matrix drawn — not
   one happy-path example.
4. The staff navigation shell, at tablet-landscape and laptop widths.
5. `/staff/day` fully composed, at: four stylists, one stylist, a column
   running forty minutes late, and a day with a stylist off.
6. `/staff/opened` composed with all four `freedBy` kinds visible at once.
7. The print sheet, in greyscale.
8. The mobile public booking flow.

## 9. Out of scope

- The public marketing pages' identity. It is done and it is audited.
- Any change to what a screen *says* or which data it shows. This is a brief
  about form. If the form reveals that a screen is missing a fact, say so —
  do not invent the fact.
- Anything that requires a new client-side dependency. The staff app currently
  ships zero UI libraries and would like to keep it that way; native elements
  and Tailwind are the toolkit. shadcn primitives are acceptable **because they
  are copied-in source, not a dependency**.

---

## 10. Where the truth lives

- Product source of truth: `docs/prds/` (`00-master-prd.md` §8 has the
  canonical entity names).
- `docs/prds/07-decisions.md` overrides any conflicting PRD text.
- `docs/prds/06-backlog.md` is the build order; `docs/PROGRESS.md` is what has
  been built and why.
- `CLAUDE.md` at the repo root carries the correctness rules — the time axes,
  the exclusion constraint, and the traps that only fail at runtime.
- `docs/reviews/` holds the operator reviews: a 22-year salon owner reading
  the product and saying what breaks on a Saturday. Read
  `14-operator-review-phase-6-close.md` before designing the day grid.
