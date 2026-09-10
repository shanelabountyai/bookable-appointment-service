# Next

**A-113 is done, gate green (1649 unit + 1 skipped; 319/319 e2e).**
Commits: the work, then the SHA record, pushed together in ONE push.
**Confirm the CI run went green before trusting this file.**

**The backlog is EMPTY.** `grep "⬜ A-" docs/prds/06-backlog.md` returns nothing:
A-113 was the last Phase 12 row. So the next session is the **Phase 12 close**,
in the same shape as the Phase 11 close:

1. **Demo checkpoint 10** → `docs/reviews/21-demo-checkpoint-10.md`
   (template: `20-demo-checkpoint-9.md`). Walk a FRESHLY SEEDED book. Two things
   this item put there for a checkpoint to find:
   - **One double-booked hour** on the moving book (seed log: `1 double-booked
     by override`). Open `/staff/day?day=<that day>`: that stylist's column is
     double width ALL DAY (D-54), both names readable, and the sheet
     (`&provider=…&sheet=1`) says "At the same time as …" on both rows.
   - **Clients who are not all the same**: Dev Iyer, Leo Dunn, Rae Núñez, Kwame
     Adeyemi, Mateo Tabora, Jordan Fairweather-Okonkwo. Read the rendered text
     against them. That is the point.
2. **Operator review at the Phase 12 close** → `21-operator-review-phase-12-close.md`
   (template: `20-operator-review-phase-11-close.md`; the `salon-operator` agent).
3. **Scope Phase 13 into `06-backlog.md`** from both.

**D-numbers:** `07-decisions.md` has TWO rows numbered D-51. A-113 appended
**D-54**, so the next decision is **D-55**. Do not re-derive it by counting.

## What A-113 changed (in case the checkpoint trips over it)

- **`seedDensity` books ONE BOOK-05 override, last**, just before the outbox
  drain, with no PRNG draw. The partner is the earliest unsegmented `booked` row
  on a moving-book day after today. `DensitySeedResult.overrides` is returned
  and printed.
- **Seeded client names were renamed IN PLACE**: same count, order and phones.
  The pool length feeds `pick(clients)`, so ADDING a client re-deals every
  booking and moves A-024's frozen 1290/2100. Rename, never append.
- **D-54: a provider column whose day holds a laned cluster spans N grid
  tracks** (`gridColumn: span N`, N = widest cluster's lanes), all day.
  `day-grid.tsx`'s `Column`. The user chose this over hiding the time on laned
  chips (the recommendation) and over deferring.
- **`day-grid.spec.ts` now runs the REAL density seed** in one test (~20s,
  `test.setTimeout(240_000)`) and reads the pair back rather than naming it.

## The rules A-113 leaves behind

**AN ASSERTION THAT SOMETHING IS VISIBLE PASSES ON AN ELLIPSIS.** A-099 shipped
lanes asserting `toBeVisible` on both chips, and the names were cut off from the
day it shipped: at the 13rem column minimum a half lane leaves ~46px for a name
after the time. Hand-built fixtures named "Mei Chen" hid it, because nobody read
a fixture at column width. Where the claim is "you can read it", measure
`scrollWidth <= clientWidth`. Verified failing ("Leo Dunn is cut off") before
the fix.

**A FIXTURE THAT RUNS THE REAL SEED FINDS WHAT A HAND-BUILT ONE CANNOT.** The
lanes had a thorough hand-built spec. The seed's pair was two 20-minute chips,
30px tall, with real names in a four-column grid, and that is the shape that
failed.

## Environment notes

- **A MONITOR LOOP THAT CHECKS `EXIT=` BEFORE `✘` MISSES A FAST FAILURE.** A
  one-test run wrote `✘` and `EXIT=` inside one 3-second poll, so the loop
  ended having reported only the totals. Run the `✘` check once more after the
  loop.
- **Other projects' idle VS Code Playwright `test-server`s slow this suite and
  look like flake.** `pkill -9 -f "apps/web/playwright"` kills this project's
  own. `$PWD` never appears in that command line, so a `$PWD`-scoped pattern
  misses it.
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test
  --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
  `npm test -- <path> -t "<name>"` works; bare `npx vitest` skips every DB test.
- **Never overlap a vitest run with a playwright sweep**, and never
  `npm run typecheck` during an e2e build: `pretypecheck` runs `next typegen`
  into the same `.next`.
- **`--list` says 319.** Unit total is 1650 (1649 + 1 skipped). Full unit
  ~170s; CI ~20 minutes.
- **`bookable_dev` has NO StaffUser.** Call `seedStaffUser` from
  `@bookable/db/auth` in a script INSIDE the repo.
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` without `FREEZE`
  invents violations.** Always go through `e2e/axe.ts`.
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a
  12:00–13:00 break. Marcus has a split Thursday. Tess is junior, with no break,
  doing Cut, Blow-dry, Fringe trim and Treatment only. The catalogue's first
  service is `Cut`, and "Cut" is a prefix of "Cut & finish".
