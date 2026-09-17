# Next

## Phase 15 is empty after A-123

The backlog has no open item. Next step is a demo checkpoint (13): walk the
future book with D-59's chip, confirm the flag and OVR are on every short chip
(Thu 17 … Fri 25 Sep, dedupe by `href`), and look at Tom Byrne's pinned note.

## Environment notes (carried forward, still true)

- **`bookable_cp12` is lying around.** Drop it by hand when convenient.
- **CHECK FOR A NEIGHBOUR BEFORE ANYTHING HEAVY.** `sysctl -n vm.loadavg` and
  `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname"`.
- **`pkill -9 -f "$PWD.*playwright"` before every sweep.**
- **Run every command from the REPO ROOT.** One e2e spec:
  `PORT=3300 npx dotenv -e .env.test -e .env.local -- npx playwright test --config=apps/web/playwright.config.ts <spec> -g "<pattern>"`.
- **`--list` says 334.** Unit total 1693 (1692 + 1 skipped). Full unit ~3.5 min; e2e ~4.7 min; CI ~20 min.
- **No prettier config in the repo.** `npx prettier --write` uses defaults and reformats whole files. Don't.
- **No database has a StaffUser after a seed.** `seedStaffUser` from `@bookable/db/auth`.
- **zsh globs an unquoted `?`:** quote every route on a command line.
