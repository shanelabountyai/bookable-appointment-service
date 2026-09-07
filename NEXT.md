# Next

**Build A-098** — row 100 in `docs/prds/06-backlog.md`, the top of Phase 11.
The backlog is no longer empty: checkpoint 8 and the operator review at the
Phase 10 close scoped **eight rows, A-098…A-105**, on 2026-09-07.

**A-098: a stylist taken off the roster takes her whole forward book off every
screen, silently, while the salon keeps telling her clients to come.**
`provider.active = false` is the one action the product offers for "she has
left". Proved by flipping that one boolean on `db:reset:test`: **106 future
appointments worth $2,870** off the day grid *and* the printed sheet, **106
chairs still held**, `/staff/conflicts` reporting **0 stranded** — and
`reminders.ts` (correctly, on its own terms) still sending "your appointment is
tomorrow", whose manage link then offers an empty day forever
(`candidatesConsidered: 0`).

Four readers, one line each, **each correct in isolation and two of them
carrying a comment explaining why** — all four verified against source before
the row was written:

```
day-view.ts:144    where: { businessId, active: true }   ← removes the COLUMN, not its contents
impact.ts:361      conflictsForDay derives from hours + absences; deactivation writes NEITHER
unfinished.ts:94   provider: { is: { active: true } }    ← her visits can never be closed out
opened.ts:217      provider: { is: { active: true } }    ← a Saturday she frees is never sold
```

**The answer already exists one axis over.** `room.ts:116` is
`.filter((r) => r.active || r.holds.length > 0)` — a retired *chair* keeps
rendering until its last hold ends, and A-046's dialog says so out loud. A
retired stylist must stay **visible, closeable, conflictable and sellable**;
she must only stop being **bookable**. And per CLAUDE.md's status-enum rule,
**the item is the grep for readers of `active: true` across every surface**,
not the four named above.

## Read first

`docs/START-HERE.md`, `CLAUDE.md`, then the row itself and the two reviews it
came from: `docs/reviews/19-demo-checkpoint-8.md` and
`docs/reviews/19-operator-review-phase-10-close.md`. Both carry the `19-`
prefix — that is the house pattern (18- is shared too), not a collision.

## Two things about the next few rows, so they are not re-derived

- **A-101 needs a DECISION before any code** — a new D-number. RPT-02's
  utilization formula is **frozen and out of scope**; the open question is only
  what the tile renders for a week that has not happened yet. Do not "fix" the
  formula.
- **A-104 is a shape, not two screens.** The audit is already done: of the four
  parameter-driven zero-row states, `clients` and `dashboard/appointments` are
  right, `dashboard/overruled` and `book` are wrong. It brings the missing
  `overruled` e2e spec with it.

## Environment notes that cost previous sessions a pass

- Check `psql -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY
  datname"` and `uptime` **before** reading a stack trace — A-097 lost three
  gate runs to a *different project* mid-sweep.
- **The seed alone is 16.8 s** (measured at checkpoint 8, on a quiet machine).
  A-095's "~15–18 s" was right; the 120 s hook budget stands. No longer an open
  question.
- The demo book runs **eight working days forward** and then nothing until the
  fixed fall-back day on 1 November.
