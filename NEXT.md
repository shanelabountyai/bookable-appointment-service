# Next

## Phase 16 is scoped. Start at the top: A-124.

`docs/reviews/25-operator-review-phase-15-close.md` (operator review at the
Phase 15 close) scoped three rows, all ⬜ in `docs/prds/06-backlog.md`:

- **A-124 (M) — DECIDE FIRST (D-60).** The freed-time screens measure the
  appointment that left, not the time that is free. Ask the owner the D-60
  question (what a freed span IS once the book around it changes) as a
  clickable question with the review's option (a) recommended, record the
  answer in `docs/prds/07-decisions.md`, then build.
- **A-125 (S) — DECIDE FIRST (D-61).** Booking someone off the waitlist does
  not close the entry. Same shape: decide, record, build.
- **A-126 (S).** A stylist's own view says "not working today" over clients
  booked on their day off. No decision needed.

A-124 is an M and carries a decision — recommend Opus for it.

## Environment notes (carried forward, still true)

- **`bookable_cp13` is dropped.** `bookable_cisim`, `bookable_drift_shadow` and
  `bookable_shadow` are the remaining non-core databases; leave them.
- **CHECK FOR A NEIGHBOUR BEFORE ANYTHING HEAVY.** `sysctl -n vm.loadavg` and
  `ps -Ao pid,ppid,etime,command | grep "[n]ode (vitest"` (parent PID 1 =
  orphan). A seed that fails with `P2028` is this, not code. There are several
  long-lived `playwright test-server` processes from IDE sessions; they are
  idle, not sweeps.
- **`pkill -9 -f "$PWD.*playwright"` before every sweep.**
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
- **`--list` says 334.** Unit total 1693 (1692 + 1 skipped). Full unit ~3.5 min;
  e2e ~4.7 min; CI ~20 min.
- **No prettier config in the repo.** `npx prettier --write` uses defaults and
  reformats whole files. Don't.
- **No database has a StaffUser after a seed.** `seedStaffUser` from
  `@bookable/db/auth`.
- **zsh globs an unquoted `?`:** quote every route on a command line.
- **Docs-only pushes are skipped by CI** (`paths-ignore: docs/**`, `**/*.md`),
  so a review/scoping push has no run to watch. A code push does.
