# Next

**A-112 is done, gate green (1648 unit + 1 skipped, 318/318 e2e).**
Commits `f303f30` (work) + `03ab7ef` (SHA record), pushed together in ONE push.
**Confirm the CI run went green before trusting this file.**

`grep "⬜ A-" docs/prds/06-backlog.md` returns **A-113 only**, so the next
session is **A-113** — the LAST row in the backlog. Read it before anything
else. Two halves, both about the demo book rather than the product:

1. **Seed one BOOK-05 override** — two clients, one stylist, one instant, a
   typed reason — on a day inside the moving future book, because `seedDensity`
   produces **zero overlapping same-provider pairs** and A-099's lanes are
   therefore dormant on every demo walk. Assert what the SCREEN says: two chips
   at the same `top`, different lanes, both names legible, and the same two rows
   on the printed sheet.
2. **Widen the seeded client names.** Eleven women, two men, no other variation
   is how *"She came"* survived eight demo walks and 1,895 tests.

**Both halves are pinned by tests that will fail if you get the PRNG order
wrong:** A-045's every-column idempotence test and A-024's frozen `1290/2100`
over `DEMO_WEEK`. Anything added must run **strictly after** the fixed book in
the PRNG stream, as A-095 did.

**D-numbers:** `07-decisions.md` has TWO rows numbered D-51 (lines 82 and 83).
A-112 appended **D-53**, so if A-113 needs one it takes **D-54** — do not
re-derive by counting.

## What A-112 changed (in case A-113 trips over it)

- **`cancelled` and `cancelled_late` are no longer dead ends.** One edge each to
  `booked` — staff only, inside APPT-06's seven-day window, reason required
  (D-53). The exclusion constraint refuses it once the time has been sold; the
  desk gets a sentence, never a SQLSTATE.
- **`isCorrection(from, to)` now reads only `from`** — "leaves a terminal
  status", not "terminal on both sides". Anything counting `status_corrected`
  events will see reinstatements in that bucket, correctly.
- **`TERMINAL_STATUSES` no longer means "no transition leaves them."** Its
  docblock says so. It means *where a visit ends up*, and every edge out of one
  is a correction.
- **The cancellation notice's dedupe key moved from the appointment to the
  EVENT** (`cancelled:${event.id}`). Any test asserting the old key string
  breaks; none did.
- **New notification template `appointment.reinstated`**, worded "Cancellation
  undone" in `TEMPLATE_WORDS`. It is **opt-IN** — `notify === true` and nothing
  else — the only notice in the product that way round.
- **`STATUS_ACTION_LABELS.booked` is now "Put it back on the book"** (was the
  unreachable "Put back to booked"). It is a real button now, on the detail
  panel, for cancelled appointments inside the window.
- **The §7 table in `00-master-prd.md` gained an explicit `booked` COLUMN**, so
  "nothing transitions back to booked" is a written rule with two written
  exceptions rather than an absence inferred from a missing column.

## The rules A-112 leaves behind

**A DEAD END BECOMING A DOOR BREAKS EVERY KEY THAT ENCODED "THIS HAPPENS ONCE",
AND IT BREAKS AS SILENCE.** The cancellation notice was keyed
`cancelled:<appointmentId>` with a comment reasoning "one cancellation of an
appointment is one fact". True — for exactly as long as `cancelled` was
terminal. Cancel → reinstate → cancel for real is now an ordinary week, and the
second notice carried the first one's key: the outbox discarded it as a
duplicate, so a genuinely cancelled client got **no message while the screen
said she had been told**, on the one path A-036 exists to make impossible.
**Verified against the unfixed code before fixing it — one row, no error, exit
0.** When you make a terminal state non-terminal, grep for every key, cache and
"once" assumption that the old finality justified.

**A PREDICATE CAN BE RIGHT FOR THE WRONG REASON AND STAY RIGHT UNTIL ONE EDGE
MOVES.** `isCorrection` asked "terminal on both sides", which is identical to
"leaves a terminal status" for as long as every edge out of a terminal status
lands on another terminal one. Adding one that does not made the plainest "we
got this wrong" in the product log as `status_changed`. **Two predicates that
agree on today's data are not the same predicate** — write down which one is the
property.

**AN E2E ASSERTION CAN PASS AGAINST A FEATURE THAT DOES NOTHING.** The first
draft asserted the chip came back on the day grid after a reinstatement. But
`day-view.ts` renders cancelled appointments **on purpose**, struck through, so
"it appears" was never the visible fact and the before-assertion
(`toHaveCount(0)`) was simply false. The real change is the word the chip's
accessible name ends on: `, cancelled` → `, booked` (`booked` is the one status
with no on-chip word, but the aria-label carries it). **Check what the screen
already shows before asserting what changes.**

**ONE ERROR SHAPE BEING REACHABLE IS A FACT TO WRITE DOWN, NOT A GAP TO
APOLOGISE FOR.** A-078 says provoke both. `transitionAppointment` owns its
transaction and never issues `SET CONSTRAINTS ... DEFERRED` — grep finds that
only in `push-column.ts` — so the violation always surfaces at statement end.
The deferred shape is provoked for real against the shared mapper in
`constraint.test.ts`. Stated in the test so nobody re-derives it.

## What A-112 deliberately did not do

- **Nothing re-points the manage token.** `repointManageTokens` moves an
  expiry, and `endAt` never moves on a reinstatement — the token issued at
  booking is already correct. That is the whole argument for an edge over a
  rebooking, and it is pinned by a test rather than left as a claim.
- **A reinstatement goes back into the appointment's OWN chair**
  (`resourceId` survived the cancellation), so a refusal can mean "that chair is
  taken" while another sits empty. Conservative in the safe direction, and the
  desk can move it afterwards — but the sentence does not distinguish the two.
- **No `no_show → booked` and no `completed → booked`.** Only a cancellation
  may be undone.

## Environment notes that cost THIS session a pass

- **OTHER PROJECTS' IDLE PLAYWRIGHT TEST-SERVERS SLOW THIS SUITE 2.4x, AND IT
  LOOKS EXACTLY LIKE FLAKE.** Two full unit runs failed on **seed-hook
  TIMEOUTS** — `utilization-constant.test.ts` (120s hook budget, 20s alone) and
  then `settings.test.ts`'s idempotence test (5s) — never on an assertion, and
  both files passed alone. Duration was **442s against the documented ~185s**,
  with memory at 61% available and Postgres holding 6 connections, so neither
  `swapcheck` nor `pg_stat_activity` said a word. Five VS Code Playwright
  extension `test-server` processes were resident, one per project. Killing this
  project's own put the suite back to **177s and 79/79 green**. `pgrep -fl
  playwright` then `lsof -a -p <pid> -d cwd -Fn` names the owning directory.
- **`pkill -9 -f "$PWD.*playwright"` DOES NOT MATCH THEM.** The extension's
  command line is relative (`node_modules/@playwright/test/cli.js test-server -c
  apps/web/playwright.config.ts`), so `$PWD` never appears in it. Match the
  config path instead: `pkill -9 -f "apps/web/playwright"`.
- **The e2e sweep took 15.3m this session** (usual ~3.7m), same cause. 318/318
  passed; wall time under load is not a correctness signal.
- **`--list` says 318 now**, up from 312 — reconcile against that.
- Everything below here still holds from A-111 and is unchanged:
  - **Run every command from the REPO ROOT.** A stray `cd apps/web` skips the
    root's `dotenv -e .env.test -e .env.local` wrapper and dies on
    `CRON_SECRET must be set in .env.test`, which is not a missing secret.
  - **`npm run test:e2e -- <args>` DOES NOT WORK** (npm puts args after
    `-w apps/web`). One spec: `PORT=3300 npx dotenv -e .env.test -e .env.local
    -- npx playwright test --config=apps/web/playwright.config.ts <spec>
    -g "<pattern>"`. Bare `PORT=3300 npm run test:e2e` is fine for the sweep.
  - **`npm test -- <path> -t "<name>"` DOES work.** Never bare `npx vitest` —
    without the dotenv wrapper every DB test SKIPS and the file merely "fails".
  - **An e2e failure alarm must grep `✘` ONLY** — `Error:` fires on the benign
    `[WebServer] ⨯ Error: The destination stream closed early`.
  - **KILLING THE SWEEP ON THE ALARM COSTS THE DIAGNOSTICS** — the `list`
    reporter buffers failure blocks to the end. Let it finish once.
  - **Hand-written appointment fixtures**: whole minutes only
    (`appointment_instants_whole_minutes`), and they cannot set
    `blockedStart`/`blockedEnd` — a trigger derives them from the row's own
    buffer columns, which default to 0. Copy the buffers off the service.
  - **Never overlap a vitest run with a playwright sweep.**
  - **`bookable_dev` is the checkpoint-9 book (718 appointments)** and has **NO
    StaffUser** — call `seedStaffUser` from `@bookable/db/auth` in a script
    INSIDE the repo.
  - **Scanning axe after `emulateMedia({colorScheme:'dark'})` without `FREEZE`
    invents violations** — always go through `e2e/axe.ts`.
  - **No staff surface may hand-write a `tel:` link** — use `PhoneLink`.
  - **The seed is not uniform.** Dana/Priya 09:00-17:00 Tue-Sat with a
    12:00-13:00 break; Marcus split Thursday; Tess no break, JUNIOR (Cut,
    Blow-dry, Fringe trim, Treatment only). All four work Tue-Sat, so Sunday and
    Monday are the only closed days.
  - **The catalogue's FIRST service is `Cut`** — never assert a prefilled
    select with it. **"Cut" is a prefix of "Cut & finish"** — anchor service
    locators (`/^Cut45 min/`). **The seeded Colour carries SEGMENTS summing to
    120 min**, so a fixture with a different body must use Cut (45, buffers
    0/10) or Blow-dry (30, buffers 0/5).
  - **A two-chair room is the cheapest fixture that can disagree with itself** —
    `resource.updateMany({ ..., skip: 2 }, { active: false })`.
  - **e2e exercises the FIRST seed run**: `e2e/fixtures.ts` TRUNCATEs before
    every test.
  - **CI takes ~19-23 minutes.** `gh run watch <id> --exit-status` before saying
    "done".
