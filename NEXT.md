# Next

**Build A-099** — row 101 in `docs/prds/06-backlog.md`, the second row of
Phase 11. A-098 is ✅ and pushed.

**A-099: the knowingly double-booked hour draws one client on top of the
other, and D-8 promises in writing that it does not.** D-8's last clause is a
promise about a screen — an override writes `blockedStart = blockedEnd` plus
`overriddenFromRange` *"so the constraint never lies and the day view renders
the true collision."* It does not. Two clients, same stylist, same instant,
the second booked through BOOK-05 with a typed reason: both chips compute
`top=60 height=55`, and the horizontal extent is not per-item —
`CHIP_SHELL` (`appointment-chip.tsx:89`) is `absolute inset-x-1` for **every
chip in the product**, and `GridItem` (`view-model.ts:23`) carries only `top`
and `minutes`. **There is no lane, no offset and no width anywhere in the day
surfaces.** The later chip in DOM order paints over the earlier one, opaque,
`overflow-hidden` — so **the client already in the book is the one who
disappears**, under a chip wearing the override marker, which reads as one
deliberate override rather than as two people at ten o'clock. The desk
overrides *because* it intends to see both.

It needs lanes in the view model (n overlapping items share the column width)
and **it must hold on the printed sheet**, where there is no z-order to hide
behind — the sheet renders the same `GridModel` and has no absolute
positioning at all, so "two rows at the same time" is the paper's version of
the same fact.

## Read first

`docs/START-HERE.md`, `CLAUDE.md`, then the row itself and
`docs/reviews/19-demo-checkpoint-8.md`, which is where it was found.

## What A-098 just changed underneath it

`GridColumn` gained `offRoster`, and `DayColumn.gaps` is now empty for an
inactive provider — so the day surfaces have moved slightly. Nothing about
lanes conflicts with it, but `view-model.ts`'s `toColumn` and
`day-grid.tsx`'s `Column` are both freshly edited; re-read them rather than
working from memory of an earlier session.

`apps/web/app/staff/design/day-fixtures.ts` now has a fourth column in
`A_STYLIST_OFF` (`Tess`, `offRoster: true`). The gallery is the cheap place to
draw an overlapping pair for A-099 too — `/staff/design` is axe-swept in both
schemes and needs no seeded book.

## Two things about the rows after it, so they are not re-derived

- **A-101 needs a DECISION before any code** — a new D-number. RPT-02's
  utilization formula is **frozen and out of scope**; the open question is only
  what the tile renders for a week that has not happened yet. Do not "fix" the
  formula. (A-098 touched `dashboard.ts` — it widened WHO gets a row, not how
  one is computed. The formula is untouched.)
- **A-104 is a shape, not two screens.** The audit is already done: of the four
  parameter-driven zero-row states, `clients` and `dashboard/appointments` are
  right, `dashboard/overruled` and `book` are wrong. It brings the missing
  `overruled` e2e spec with it.

## Environment notes that cost previous sessions a pass

- Check `psql -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity
  GROUP BY datname"` and `uptime` **before** reading a stack trace — A-097 lost
  three gate runs to a *different project* mid-sweep. (Bare `psql` fails on
  this machine: there is no `shanelabounty` database. Use `-d postgres`.)
- **The seed alone is 16.8 s**; the 120 s hook budget stands. Not an open
  question.
- The demo book runs **eight working days forward** and then nothing until the
  fixed fall-back day on 1 November.
