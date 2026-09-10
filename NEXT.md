# Next

**A-111 is done, gate green (1627 unit + 1 skipped, 312/312 e2e in 3.7m).**
Commits `d4bf7bd` (work) + the SHA record, pushed together in ONE push.
**Confirm the CI run went green before trusting this file.**

`grep "⬜ A-" docs/prds/06-backlog.md` returns **A-112 … A-113**, so the next
session is **A-112** — read its row before anything else. It says **DECIDE
FIRST (a new D-number), THEN BUILD**: may a mis-tapped cancellation be undone,
and under what guard? The row already names the recommendation (an APPT-06-style
`cancelled | cancelled_late → booked` edge inside the 7-day window, refused by
the exclusion constraint and mapped through `errors.ts` to a sentence) and the
two alternatives. **Note the D-number collision**: `07-decisions.md` has TWO
rows numbered D-51 (lines 82 and 83). A-111 appended **D-52**, so A-112 takes
**D-53** — do not re-derive the next number by counting.

## What A-111 changed (in case A-112 trips over it)

- **There are no gendered pronouns in ANY string the product renders**, client
  copy and provider copy alike (D-52 — this went beyond the backlog row, which
  had exempted staff copy; `setup-seed.ts` seeds **Marcus**, one stylist in
  four, and `scheduling-words.ts` was calling him "she").
- **`apps/web/lib/voice.test.ts` enforces it.** It parses every `.ts`/`.tsx`
  under `apps/web/{app,components,lib}` and `packages/{core,db}` — 233 files —
  and fails on `she|her|hers|herself|he|him|his|himself` in a **string literal,
  template chunk, or JSX text**. Comments are fine and always were: they are
  not AST nodes. `*.test.ts` / `*.spec.ts` are excluded by filename.
- **Copy A-112 will touch, in its new wording:** `errors.ts` sentences are
  unchanged, but `release-time.ts`'s refusals now read *"This cannot be
  released before it was due."* / *"That time is already over…"* / *"That time
  was never given back…"*, and `actions.ts` says *"That time has been sold to
  somebody else… Put the time back first if the slot is still free."*
- **`event-language.ts`:** `'appointment.services_changed'` is now
  **`'Services changed'`** (was "What she is having changed"), and the restore
  lines read *"The time was put back on the book by …"* / *"The remaining time
  was put back on the market by …"*.
- **`conflict-list.tsx`'s cancel-side checkbox** is now *"I've already rung them
  — don't send the cancellation"*, deliberately NOT the shorter "Already rung
  them" (see the rule below).

## The rules A-111 leaves behind

**A SCOPE LINE IN A BACKLOG ROW IS A CLAIM, NOT A CONSTRAINT — CHECK IT AGAINST
THE SEED.** A-111's row said in bold *"this is the client copy only — 'her
working hours' about Dana or Tess is correct and stays."* It is not correct:
the product stores no gender for providers either, and one of the four seeded
stylists is a man. Honouring the row would have produced an **allowlist holding
exactly the ~20 strings that are wrong about him** — which is A-096's rule
(*patching the rooms that noticed leaves the door open*) arriving as a config
file. **When an item hands you an exemption, ask what the fixture says about
it before you build the exemption in.**

**A RENAME CAN COLLIDE WITH COPY THAT WAS ALREADY CORRECT, AND NO SCAN FOR THE
THING YOU CHANGED CAN SEE IT.** The conflicts row renders a keep form and a
cancel form side by side, each with a "don't tell them" checkbox. The keep one
already read *"I've already rung them — don't text"*; neutralising the cancel
one to *"Already rung them"* made it a **SUBSTRING** of its sibling, so
`getByLabel` resolved to two checkboxes — and one accessible name sitting inside
another is ambiguous to anyone navigating by label, not just to Playwright.
**Neither string contains a pronoun afterwards**, so the guard is blind to it.
The tell was a **432 ms** failure: a strict-mode violation fails instantly,
where a wrong locator burns the full 30 s timeout.

**LINT LOST TO A TEST ON MERGE SEMANTICS, AND THAT IS WORTH REMEMBERING BEFORE
REACHING FOR `no-restricted-syntax` AGAIN.** A `Literal[value=/…/]` selector
does this detection in eight lines and fires in the editor. But **ESLint rule
config REPLACES rather than merges**, so covering both eslint configs while
exempting test narration and preserving `packages/core/time`'s existing
`'no-restricted-syntax': 'off'` carve-out meant four override blocks each
re-listing the D-3 axis selectors — a shape where the next person to add a
block silently drops one set, which is the same defect class being guarded.

**AND THE GUARD ASSERTS IT SCANNED SOMETHING** (A-096). Three tests, not one:
the file list is non-empty and contains `close-out-buttons.tsx` by name; the
detector is run against a planted `<p title="She came">She came</p>` sitting
under a comment saying the same words, expecting **two** hits and not three;
then the real scan. Verified failing against the unfixed string — it prints
`apps/web/app/staff/unfinished/close-out-buttons.tsx:32  She came`.

## What A-111 deliberately did not do

- **Comments are untouched.** 674 of the 764 raw pronoun hits are prose in
  headers narrating one imagined client — *"she walks in at 09:05"*. That is a
  person telling a story, not the product addressing anybody.
- **e2e `overrideReason` fixtures still say "squeeze her in".** Test-authored
  data is data. The *shipped* copy of that same sentence, in
  `app/staff/design/day-fixtures.ts`, was rewritten — the design gallery is
  part of the built product.
- **The seeded client list is still eleven women and two men.** That is the
  second half of **A-113**, and it is what makes a demo walk able to hear this.

## Environment notes that cost previous sessions a pass

- **Run every command from the REPO ROOT.** The shell's cwd persists between
  calls: a stray `cd apps/web` makes `npm run test:e2e` skip the root's
  `dotenv -e .env.test -e .env.local` wrapper, so the sweep dies on
  `CRON_SECRET must be set in .env.test`, which reads exactly like a missing
  secret and is not one.
- **`npm run test:e2e -- <args>` DOES NOT WORK.** npm puts the args after
  `-w apps/web` and it dies with `Workspaces not supported for global
  packages`. To run one spec or one `-g` filter:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test
  --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
  The bare `PORT=3300 npm run test:e2e` (no args) is fine for the full sweep.
- **`npm test -- <path> -t "<name>"` DOES work** and is how to run one vitest
  file. Never bare `npx vitest` — without the dotenv wrapper every DB test
  SKIPS and the file merely "fails". Same for `playwright --list`.
- **An e2e failure alarm must grep `✘` ONLY.** A wider alternation on `Error:`
  fires on `[WebServer] ⨯ Error: The destination stream closed early`, which is
  benign. The whole 312-spec sweep is ~3.7m; two specs alone are ~39s, which is
  worth running before committing to a full sweep after a copy change.
- **KILLING THE SWEEP ON THE ALARM COSTS YOU THE DIAGNOSTICS.** Playwright's
  `list` reporter buffers every failure block until the END of the run, so a
  killed sweep leaves a `✘` line and nothing else. Let it finish once.
- **A hand-written appointment fixture must land on WHOLE MINUTES** —
  `appointment_instants_whole_minutes` refuses the seconds `new Date()` came
  with. Floor it.
- **A hand-written appointment fixture cannot set `blockedStart`/`blockedEnd`**
  — a trigger derives them from the row's own buffer columns, which default to
  0. Copy the buffers off the service whenever the footprint is what the test
  is about.
- **`density-seed.test.ts` has a 120 s per-test budget** and is the first thing
  that breaks under contention. The whole unit suite is **~185 s**. **Never
  overlap a vitest run with a playwright sweep.**
- **`bookable_dev` is the checkpoint-9 book (718 appointments)** and has **NO
  StaffUser** — call `seedStaffUser` from `@bookable/db/auth` in a script
  INSIDE the repo (a scratchpad path cannot resolve the `@bookable/*` aliases).
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` WITHOUT `FREEZE`
  invents violations** — always go through `e2e/axe.ts`.
- **No staff surface may hand-write a `tel:` link** — use `PhoneLink`.
- **The seed is not uniform.** Dana/Priya: 09:00-17:00 Tue-Sat, 12:00-13:00
  break. Marcus: split Thursday. Tess: no break, JUNIOR (Cut, Blow-dry, Fringe
  trim, Treatment only). **All four work Tue-Sat**, so Sunday and Monday are
  the only closed days.
- **The catalogue's FIRST service is `Cut`** — never assert a prefilled select
  with it.
- **"Cut" is a prefix of "Cut & finish"** — anchor service-button locators
  (`/^Cut45 min/`).
- **The seeded Colour carries SEGMENTS that must sum to its duration**, so a
  hand-written fixture whose body is not 120 minutes must use the **Cut**
  (45 min, buffers 0/10) or the **Blow-dry** (30 min, buffers 0/5).
- **A two-chair room is the cheapest fixture that can disagree with itself** —
  `resource.updateMany({ ..., skip: 2 }, { active: false })`.
- **e2e exercises the FIRST seed run**: `e2e/fixtures.ts` TRUNCATEs before
  every test, so a spec's `beforeEach` seeds an empty database.
- **Scope the pre-sweep kill to `$PWD`** (`pkill -9 -f "$PWD.*playwright"`),
  then `lsof -ti :3300 | xargs -r kill -9`, then verify BOTH are zero.
- **CI takes ~19-23 minutes.** `gh run watch <id> --exit-status` before saying
  "done".
