# Next

**A-095 — the demo book's dark corners, what checkpoint 7 could not walk.** Next
⬜ in `docs/prds/06-backlog.md`, row 97. `seedDensity` fills only Dana (0.7) and
Priya (0.4), so Marcus and Tess have no future appointments at all, the room
axis never binds (21,184 offers, not one `no-resource-free`), and there are zero
waitlist entries, call marks and call-down attempts — so WAIT-01–04, A-021,
A-023, A-043, A-072 and `/staff/opened`'s "Who wants this slot?" all render
their empty state on a book with 453 appointments in it.

**Not a ride-along.** The seed is pinned by A-045's every-column idempotence
test and by A-024's exact utilization constant over `DEMO_WEEK`'s whole ISO
week; both have to be satisfied deliberately. `seedDensity` is also deliberately
NOT idempotent and refuses on a non-empty book.

Worth a moment before starting: **A-096** (row 98, dark-scheme axe over the rest
of the staff app) has a new reason to come first. A-094 fixed `cn` so
tailwind-merge stops discarding A-088's type roles — which means every `Button`,
`Field` label, `EmptyState` and `Tab` in the staff app just changed from the
browser's 16px to A-088's 14/12px for the first time. The 278-test sweep is
green and CI is green, but nobody has *looked* at those screens since, and A-096
is the pass that would. Backlog order says A-095; this is the one argument for
taking A-096 out of turn.

A-094 is committed (`b08807e`, SHA record `3560020`) and CI-green (run
34044745224). A-097 is the remaining Phase 10 row.

Read `docs/START-HERE.md` and `CLAUDE.md` first, as always.
