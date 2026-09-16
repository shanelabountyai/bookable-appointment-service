# Next

**A-120 is done (D-57 — the chip carries the consequence).**
Commits: the build (`e78fc61`), then the SHA record, pushed together in ONE
push. **Confirm with `gh run list --limit 1` before trusting this file** — that
run must be green.

Full local gate passed: lint, typecheck, unit (1688 passed + 1 skipped = 1689,
reconciling against A-119's 1685 + 4 new) and e2e (331 passed, matching
`--list`'s 331).

## THE BACKLOG IS EMPTY

`grep ⬜ docs/prds/06-backlog.md` returns nothing but the legend line. A-120
was row 122 and the last open item; **A-121 does not exist** — the A-119
handoff's "then A-121 top to bottom" was wrong about that. So the next session
is not a build session unless somebody scopes one.

What produced the last three rounds, in the order they have actually worked:

1. **A demo checkpoint**, walked on a production build over a freshly created
   scratch database (checkpoint 10 is `docs/reviews/21-demo-checkpoint-10.md`;
   `bookable_cp10` is still lying around — drop it by hand). Every round of
   rows since Phase 9 came out of one. **This item is three reasons to walk
   another one**: the seeded book can now show the never-reminded list, a name
   too long for a column, and a flagged client — none of which any previous
   checkpoint could see, because none of them existed on a fresh install.
2. **An operator review** (`salon-operator` agent) at the phase close, which is
   what produced A-115/A-117 and the Phase 12 round.

Pick one, produce the rows, then build top to bottom as usual. **D-58 is the
next free decision number** (D-57 was taken by A-120; and see the numbering
note at the top of `07-decisions.md` — D-51 is assigned twice on purpose).

## What A-120 left for anyone near the day grid, the flag, or the seed

- **`GridItem.missed` is `{ sentence, short }`, not a string.** Four renderers
  read it: the CHIP takes `short` (it has 185 px), and the stylist's list, the
  printed sheet, the late-call panel and the accessible name take `sentence`. A
  pair rather than a second optional field on purpose — an optional
  `missedShort` lets the next narrow renderer keep the default and cut the
  sentence silently, which is exactly how this shipped.
- **`flagOnAChip` is the chip's only wording and `flagSentence` everyone
  else's**, both built from one private `flagCounts` in `client-flag.tsx`. A
  third wording in a third file is what that module exists to prevent.
- **A TRUNCATION IS INVISIBLE TO EVERY TOOL IN THE GATE.** `toBeVisible` and
  `getByText` read `textContent`, which CSS does not touch, and axe reads the
  accessible name, which is correct and whole. Where a surface claims
  legibility, compare `scrollWidth` with `clientWidth` and print both numbers
  in the failure. Now in CLAUDE.md as a trap.
- **D-54 means an A-099 lane chip is NOT narrower** — 185 px against an
  ordinary chip's 184 — because a double-booked column widens by its lane
  count. Any test named "half-width lane" is measuring an ordinary chip twice.
- **`seedDensity` now runs the reminder sweep.** It backdates `createdAt` on
  the future half of the moving book (`startAt - 21 days`) and sweeps only the
  ticks that have something due, plus `now - 5m` for the watermark, skipping
  the band of the MIDDLE cohort member. `remindersSent`/`remindersMissed` are
  returned and printed; `remindersMissed` going to zero is the never-reminded
  screen going quietly empty again. Cost: none measurable (the seed test file
  ran 76.7 s before, 71.9 s after).
- **Every function in `density-seed.ts` that INSERTS an appointment must add to
  `appointmentsCreated` at its call site.** `seedNoShowHistory` learned this;
  `seedLapsedHistory` had not, and the log under-reported by five. The new test
  asserts the whole total against `prisma.appointment.count()`, so a sixth
  fixture that forgets fails there.
- **`Sam Okafor` is now `Jordan Fairweather-Okonkwo`** — renamed IN PLACE, same
  count, order and phones, because `fill` picks clients off the PRNG and
  another LENGTH re-deals every one and moves A-024's frozen `1290/2100`. The
  lapsed pool's fifth person is `Ines Brandt`. Earlier PROGRESS entries and
  checkpoint reviews still name Sam Okafor; those are historical.
- **A test that reads `shared` AND the live database belongs in
  `density-seed.test.ts`'s FIRST describe.** The determinism block resets and
  re-seeds with a different `randomSeed`. Two of this item's assertions passed
  against the wrong book first — one loosely, which is the worse half.

## What A-119 left for anyone near the waitlist, the matcher, or a freed span

- **`WaitlistEntry.serviceIds` is ORDERED and that order is the FOOTPRINT.**
  D-23 takes the first line's `bufferBefore` and the last line's
  `bufferAfter`, so colour-then-cut is 145 minutes where cut-then-colour is
  160. **Anything that sorts or de-duplicates that array re-prices every
  combination booking in the salon.** The test is `ORDER IS THE FOOTPRINT` in
  `waitlist.test.ts`; nothing else in the suite would notice.
- **`matchFreedSlot` takes no `serviceId`.** A freed span matches anyone whose
  whole visit fits it. Re-adding a service filter is D-56 being re-opened.
- **An unqualified line returns `null`, never a skipped line** — skipping
  composes a SHORTER visit that fits MORE spans. Needs a junior in the fixture.
- **`composeVisit` is the one copy of D-23's composition** and `fitsFreedSpan`
  the one copy of A-109's comparison.
- **`dayPartWords` (`@bookable/core/waitlist`)** is the one place day-part tags
  become English.

## What A-118 left for anyone near the messages screen

- **`countNotReallySent(db, businessId)`** (`stuck.ts`) groups by `deliveredBy`
  in SQL and folds with `reallyDelivered` in TypeScript — **never spell that
  predicate as a `where` clause.**
- **`allClear` on `/staff/messages` has three terms**, and the page's intro
  paragraph enumerates its sections — a fifth section is a reader too.

## What A-117 left for anyone near reminders or the shell badge

- **`reminderDedupeKey(appointmentId, startAt)`** is the ONLY way to say "the
  reminder for this appointment at this time".
- **`MOVING_EVENT_TYPES`** is `['rescheduled', 'column_pushed']`. A third way
  to move an appointment belongs in it.
- **The staff shell runs FIVE queries per render.** If it shows up, cache the
  NUMBER — never ask a cheaper question (checkpoint-6 class).

## Environment notes

- **CHECK FOR A NEIGHBOUR BEFORE A SWEEP.** `psql -d postgres -c "SELECT
  datname, count(*) FROM pg_stat_activity GROUP BY datname"` — another
  project's test database holding 20+ connections starves this one, and it
  fails as `Hook timed out` on `beforeAll`. Not a code regression.
- **Leftover Playwright `test-server` processes outlive their session** (the
  VS Code extension's). `pgrep -fl "chrome-headless-shell|test-server"` before
  blaming the suite; five were resident through this item's sweep and did not
  interfere.
- **`dropdb bookable_dev` is refused by the auto-mode classifier.** For a
  checkpoint, create a NEW scratch database instead. **`bookable_cp10` is still
  lying around**; drop it by hand when convenient.
- **`pkill -9 -f "$PWD.*playwright"` before every sweep**, and note that
  `pgrep -cf` with that pattern errors on macOS — use `pgrep -f … | wc -l`.
- **Loading `/staff/book?...&day=` does NOT run the panel's client-side
  lookups.** Drive the date box (`getByLabel('Which day?').fill(day)`).
- **zsh globs an unquoted `?`:** quote every route on a command line.
- **JSX STRIPS THE NEWLINE BETWEEN A `<span>` AND ITS SIBLING TEXT** — put a
  real space in the text, not a margin class.
- **A MONITOR LOOP THAT CHECKS `EXIT=` BEFORE `✘` MISSES A FAST FAILURE.** Run
  the `✘` check once more after the loop.
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test
  --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
  `npm test -- <path> -t "<name>"` works; bare `npx vitest` skips every DB test.
- **Never overlap a vitest run with a playwright sweep**, and never
  `npm run typecheck` during an e2e build.
- **`--list` says 331** (was 328 before A-120). Unit total 1689 (1688 + 1
  skipped). Full unit run ~3.5 min; e2e sweep ~4.0 min; CI ~20 min.
- **No database has a StaffUser after a seed.** Call `seedStaffUser` from
  `@bookable/db/auth` in a script INSIDE the repo (e2e's credentials:
  `owner@shear-genius.test` / `e2e-staff-password`).
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a
  12:00–13:00 break. Tess is junior (Cut, Blow-dry, Fringe trim, Treatment
  only). FOUR chairs, and `Chair 1` is handed out first.
