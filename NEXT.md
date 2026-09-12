# Next

**A-116 is done (reinstating into the chair somebody else took).**
Commits: the build (`76f299c`), then the SHA record, pushed together in ONE
push. **Confirm with `gh run list --limit 1` before trusting this file** — that
run must be green.

## The next item: A-117 — the badge cannot see the one failure D-51 was for

Two halves, both measured by the operator. **Part 1:** the shell badge is
`countUnsentNotifications` (`stuck.ts:173`, `layout.tsx:58`), which counts
OUTBOX rows — and a missed cron tick writes none, while the next tick drains
everything else. So the badge reads 0, the stuck list is empty and the
watermark says the job ran five minutes ago, while four ten o'clocks were never
reminded. Count the cohort in the badge **from `listMissedReminders` itself**,
never a second predicate. **Part 2:** predicate 4 (`missed-reminders.ts:76`)
asks whether the APPOINTMENT holds any reminder row, while the sweep's identity
is `reminder-24h:{id}:{startAtMs}` (`reminders.ts:112`) — so a client reminded
for Saturday and moved to Wednesday drops off the list, while the sweep enqueues
a second reminder. Match on the key built from the row's CURRENT `startAt`, via
ONE exported key builder. **Move predicate 3 with it** (`missed-reminders.ts:89`):
"booked early enough" becomes "at THIS time early enough" — the latest event that
rewrote `startAt`, else `createdAt`.

**Fixtures:** a skipped tick with every other tick run so the outbox is clean;
and remind → reschedule by more than a day → skip the new band. Operator review
§2 (`docs/reviews/21-operator-review-phase-12-close.md`). No new D-number.

Then A-118 … A-120 top to bottom. **A-119 needs a NEW D-number: D-56** (D-55 was
taken by A-114; `07-decisions.md` still has TWO rows numbered D-51).

## What the close found, in case an item trips over it

- **A-118:** *"Everything has gone out"* is printed over 686 rows all
  `deliveredBy = log`, while every appointment page says "queued".
- **A-119:** the waitlist stores one `serviceId`.
- **A-120:** on the demo book the missed-reminder list is empty by construction,
  the long name never reaches a chip, and the flag's second clause is always cut.

## What A-116 left for anyone near occupancy

- **A reinstatement now RE-PICKS its chair** (`transition.ts`, `chairForMove`),
  so `resourceId` can change on a `cancelled → booked` edge. Anything caching a
  chair across a cancellation is stale.
- **`transitionAppointment` can now throw `NoResourceFree`**, not only
  `SlotTaken`/`TransitionRefused`/`AppointmentMovedFirst`. Any other caller of it
  that catches errors needs that arm — `changeStatus` (`actions.ts`) has it.
- **A-075's un-release is the same shape and was deliberately NOT changed**
  (`release-time.ts:261`): `no_show` still occupies, so re-picking would move a
  client who had already sat down. Named in `transition.ts`'s comment.

## What A-115 left for anyone near the booking panel

- **The panel's lookup and A-106's fortnight walk are ONE transition**, so on a
  full day the refused chips now wait on the walk (~2.5s warm, more cold). A
  spec that expects chips within the default 5s fails as "the fix did not work"
  on a slow machine — wait for `Looking…` to go.

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
- **`--list` says 326.** Unit total is 1663 (1662 + 1 skipped). Full unit run
  ~6 min (density-seed alone is ~73s); e2e sweep ~4.3 min; CI ~20 minutes.
- **No database has a StaffUser after a seed.** Call `seedStaffUser` from
  `@bookable/db/auth` in a script INSIDE the repo (e2e's credentials:
  `owner@shear-genius.test` / `e2e-staff-password`).
- **Scanning axe after `emulateMedia({colorScheme:'dark'})` without `FREEZE`
  invents violations.** Inside the suite, always go through `e2e/axe.ts`.
- **The seed is not uniform.** Dana and Priya work 09:00–17:00 Tue–Sat with a
  12:00–13:00 break. Tess is junior (Cut, Blow-dry, Fringe trim, Treatment only).
  There are FOUR chairs, and `Chair 1` is what the picker hands out first. All 13
  seeded phones are stored `+1…`, which is now the ONLY stored form: D-55's
  `client_identity` trigger canonicalises every write, fixtures included, so an
  assertion on a phone reads `+15125550101` whatever the fixture typed. Eight
  clients hold every appointment except the five lapsed visits.
