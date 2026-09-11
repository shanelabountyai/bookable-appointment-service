# Next

**A-114 is done (D-55: canonical phone + folded name, owned by the database).**
Commits: the build, then the SHA record, pushed together in ONE push.
**Confirm with `gh run list --limit 1` before trusting this file** — that run
must be green.

## The next item: A-115 — "When can Dana fit me in?" on a FULL day

A-106's day list and A-110's waitlist door sit behind `offered.length === 0`
(`booking-panel.tsx:284`), and a full day is never empty because A-042 made
`offered` carry refused times. Ask the question of the BOOKABLE times
(`offered.every(slot => slot.reasons.length > 0)`), keep A-042's refused list
AND the day list and door beneath it. **The fixture is a full day with no
absence anywhere in it**, asserted on the named arm AND against the move
panel's answer for the same day (`move-panel.tsx:77`) — they must agree.

Then A-116 … A-120 top to bottom. **A-119 needs a NEW D-number: D-56** (D-55
was taken by A-114; `07-decisions.md` still has TWO rows numbered D-51).

## What the close found, in case an item trips over it

- **A-115:** A-106's day list and A-110's waitlist door are behind
  `offered.length === 0` (`booking-panel.tsx:284`), so a FULL day (every time
  refused) gets neither. The move panel gets it right.
- **A-116:** the reinstatement returns into its OWN chair (`transition.ts:145-148`),
  and `findFreeResource` gives the freed chair to the next booking.
- **A-117:** the Messages badge counts outbox rows only, and a missed tick writes
  none. Predicate 4 ignores a moved `startAt`.
- **A-118:** *"Everything has gone out"* is printed over 686 rows all
  `deliveredBy = log`, while every appointment page says "queued".
- **A-119:** the waitlist stores one `serviceId`.
- **A-120:** on the demo book the missed-reminder list is empty by construction,
  the long name never reaches a chip, and the flag's second clause is always cut.

## Environment notes

- **`dropdb bookable_dev` is refused by the auto-mode classifier.** For a
  checkpoint, create a NEW scratch database instead: write
  `grep ^DATABASE_URL .env.local | sed 's#/bookable_dev?#/bookable_cp10?#'` into a
  scratchpad env file, then `createdb`, `migrate:deploy -w packages/db` and
  `tsx packages/db/seed.ts` under `npx dotenv -e <that file> -e .env.local --`
  (first file wins). **`bookable_cp10` was left behind by checkpoint 10**; drop it
  by hand when convenient.
- **The server does not need a special build for a scratch DB:** `npm run build`,
  then `npm run start -w apps/web` under that dotenv. Prisma reads the URL at
  runtime.
- **Loading `/staff/book?...&day=` does NOT run the panel's client-side lookups.**
  The day list, the "anyone" times and A-103's walk-in answer all run in a
  transition on the panel's own date box. Drive the box
  (`getByLabel('Which day?').fill(day)`), or a walk reports features missing that
  are there.
- **zsh globs an unquoted `?`:** quote every route passed on a command line, or
  the command dies with `no matches found` before it runs.
- **A MONITOR LOOP THAT CHECKS `EXIT=` BEFORE `✘` MISSES A FAST FAILURE.** Run
  the `✘` check once more after the loop.
- **Other projects' idle VS Code Playwright `test-server`s slow this suite.**
  `pkill -9 -f "apps/web/playwright"` kills this project's own.
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test
  --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
  `npm test -- <path> -t "<name>"` works; bare `npx vitest` skips every DB test.
- **Never overlap a vitest run with a playwright sweep**, and never
  `npm run typecheck` during an e2e build.
- **`--list` says 323.** Unit total is 1659 (1658 + 1 skipped). Full unit run
  ~170s; e2e sweep ~6 min; CI ~20 minutes.
- **No database has a StaffUser after a seed.** Call `seedStaffUser` from
  `@bookable/db/auth` in a script INSIDE the repo (e2e's credentials:
  `owner@shear-genius.test` / `e2e-staff-password`).
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` without `FREEZE`
  invents violations.** Inside the suite, always go through `e2e/axe.ts`.
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a
  12:00–13:00 break. Tess is junior (Cut, Blow-dry, Fringe trim, Treatment only).
  All 13 seeded phones are stored `+1…`, which is now the ONLY stored form:
  D-55's `client_identity` trigger canonicalises every write, fixtures included,
  so an assertion on a phone reads `+15125550101` whatever the fixture typed. Eight clients hold every appointment
  except the five lapsed visits.
