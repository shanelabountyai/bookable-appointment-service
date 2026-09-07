# Next

**The backlog is empty.** `grep "⬜ A-" docs/prds/06-backlog.md` returns **0** —
A-097 was row 99 and the last one. That is not "done", it is the state
A-045's session met and it means the next session's job is a **scoping pass,
not a build**.

**Phase 10 just closed** (A-095, A-096, A-097). `docs/START-HERE.md` is
explicit that the demo checkpoint gets walked when its milestone closes, not
when convenient — the rental build's checkpoint found four defects, all in
items already marked ✅, all invisible from inside the item that introduced
them. **Checkpoint 8 is the move**, and the seeded book can finally carry it:
A-095 gave Marcus and Tess future columns, so the room axis binds (39
`no-resource-free` refusals where there were 0), and the waitlist, call marks
and call-down screens have rows for the first time.

Run the `salon-operator` agent against `docs/PROGRESS.md` and the built
product, then write what it finds into the backlog as new `A-` rows.

**Three things already known to be open**, worth checking against whatever the
checkpoint turns up rather than scoping blind:

- **`/staff/dashboard/overruled` has no e2e spec at all** (A-096). Its colour
  was fixed with the rest; nothing guards it. The route renders an empty list
  without `from`/`to`, and scanning an empty list is scanning the chrome — the
  fixture needs a genuinely overruled cancellation.
- **`sameTimeWithSomebodyElse` asks the room's question anonymously** (A-097).
  `confirmAppointment` has resolved the client five lines above and passes no
  `holderKey`. It is the strict direction, so it can only offer *fewer* times
  than the write would accept — but it is exactly the A-083 shape, and the
  public flow is the caller A-083 did not reach.
- **`/staff/design` returns 50 axe `incomplete` results** in both schemes
  (A-096). Not violations, nothing asserts on them, gallery-only route.

**Also worth one line in PROGRESS when somebody next touches the seed:**
A-095's note records the density seed at "~15–18s". A-097 measured
`density-seed.test.ts` at **76.9s for the whole file** (three seeds) on a
quiet machine. Nobody has re-measured the seed alone; the 120s hook budget
was left where it is, deliberately.

**And the environment lesson A-097 paid for:** three consecutive gate runs
failed in that one file and the cause was a *different project* mid-sweep
(`countertop_test`, eleven connections, load 28.9). Check
`psql -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname"`
and `uptime` **before** reading a stack trace.

Read `docs/START-HERE.md` and `CLAUDE.md` first, as always. CLAUDE.md gained
A-097's rule under "Traps that only fail at runtime".
