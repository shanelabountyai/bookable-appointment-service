# Next

**The Phase 12 close is done: demo checkpoint 10, the operator review, and Phase 13
scoped as A-114 … A-120 in `docs/prds/06-backlog.md`.** Docs only, no product code.
Commits: the scoping pass, then the SHA record, pushed together in ONE push.
**Confirm with `gh run list --limit 1` before trusting this file.** A docs-only push
is skipped by `paths-ignore`, so "no new run" is the expected answer.

## The next item: A-114 — DECIDE FIRST, then build

**A-114: the website makes a second client out of a phone number written with
brackets, and a blocked client books straight past CLIENT-04.** Proved through the
real `/book` flow at checkpoint 10. Alice Hall has 3 no-shows and is blocked from
booking online. Typing `+1 512 555 0101` gets *"We can't book this one online"*.
Typing `(512) 555-0101` gets *"Your appointment is confirmed"* and a second Alice
Hall with a clean record. `normalizePhone` keeps a leading `+`, so one number has
three identities, and `confirmAppointment` reuses a client only on an exact
`(phone, name)` match. The name has the same fault: `mode: 'insensitive'` does not
fold accents or Unicode form, so "Rae Nunez" is a stranger and the desk's search
for "nunez" finds nobody.

**It needs a NEW D-number before any code: D-55.** `07-decisions.md` has TWO rows
numbered D-51; the last is D-54. Do not re-derive the number by counting. Frame it
as a clickable question. The row lists the parts: a canonical phone form
(canonicalising is not validating, so `phone.ts`'s "not E.164 validation" can
stand), a migration of stored phones, and one folded name comparison used by both
the write and the desk search. D-17's household trade (the name distinguishes
people who share a phone) is settled and stays.

**The fixture is the item:** two different people typing. Format A on one side,
format B on the other; an accented name one way and the other. `booking.spec.ts:71`
and `:87` write the same literal on both sides, which is why nothing caught this.

Then A-115 … A-120 top to bottom. **A-119 also needs a NEW D-number** (whichever
decision is taken first gets D-55).

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
- **`--list` says 319.** Unit total is 1650 (1649 + 1 skipped). Full unit run
  ~170s; CI ~20 minutes.
- **No database has a StaffUser after a seed.** Call `seedStaffUser` from
  `@bookable/db/auth` in a script INSIDE the repo (e2e's credentials:
  `owner@shear-genius.test` / `e2e-staff-password`).
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` without `FREEZE`
  invents violations.** Inside the suite, always go through `e2e/axe.ts`.
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a
  12:00–13:00 break. Tess is junior (Cut, Blow-dry, Fringe trim, Treatment only).
  All 13 seeded phones are stored `+1…`. Eight clients hold every appointment
  except the five lapsed visits.
