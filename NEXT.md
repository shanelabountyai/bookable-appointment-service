# Next

## A-125 is done (CI green, run 35377419293). Next: A-126.

`docs/prds/06-backlog.md` row 128, ⬜:

- **A-126 (S).** A stylist's own view says "not working today" over clients
  booked on their day off. No decision needed. Re-recommend the model at start.

## What A-125 left that the next item should know

- `bookAppointment` takes `waitlistEntryId`; closes only an ACTIVE entry of the
  booked client, inside the booking transaction (D-61).
- `nextBookedFor` (`@bookable/db/waitlist`) = each client's earliest live
  future appointment. A label, never a filter.
- `/staff/book` does not preselect the `at` param; the desk re-clicks the time.
- If `/staff/opened` or out-of-hours overrides get touched: still no fixture for
  a cancelled out-of-hours override (from A-124).

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 336.** Unit total 1703 (1702 + 1 skipped). Unit ~3.5 min; e2e ~7 min; CI ~20 min.
- No prettier config — don't `prettier --write`.
- zsh globs `?`: quote routes. Docs-only pushes skip CI.
