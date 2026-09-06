# Next

**A-097 — "no preference" dead-ends her after all.** Next ⬜ in
`docs/prds/06-backlog.md`, row 99. Size S, no dependencies.

A-071's whole point is that a client who said she does not mind is never sent
back to the time list. It re-offers the same time with somebody else — and when
there is nobody else, **it falls back to the vanished stylist's day, which is
empty by construction: she is off.** Proved on 2026-09-05 at 09:56: the flow
picked Tess at 12:00 (the only slot one stylist can take that day, the other
three being on their 12:00–13:00 break), Tess was taken out from under the page,
and the screen answered *"No appointments available that day. Please choose
another day."* on a Saturday with three stylists free from 13:00 and an empty
book. **She said no preference and was shown one person's empty column** — the
fallback carries a provider she never chose.

Found by A-092 because `booking.spec.ts`'s A-071 case was failing on the clock.
That spec is now pinned to a whole open day, so **nothing covers this path** —
the fixture is part of the item.

**What A-096 just changed underneath it.** Every axe assertion in the suite now
goes through `apps/web/e2e/axe.ts` and runs **both colour schemes**; `eslint`
refuses a spec that imports `AxeBuilder` directly (`no-restricted-imports` in
`apps/web/eslint.config.mjs`). So a new spec gets dark for free and must not
hand-roll one. `text-zinc-500` is gone from `app/staff` and `app/manage` — use
`text-ink-muted`.

**Two things A-096 deliberately left open**, both recorded in `PROGRESS.md`:

- **`/staff/dashboard/overruled` has no e2e spec at all.** Its colour was fixed
  with the rest, but nothing guards it. Not papered over here: the route renders
  an empty list without `from`/`to`, and scanning an empty list is scanning the
  chrome — the fixture needs a genuinely overruled cancellation.
- **`/staff/design` returns 50 axe `incomplete` results** in both schemes (41
  `aria-prohibited-attr`). `incomplete` is not `violation`, nothing asserts on
  it, and it appears on no real staff route — gallery-only.

Read `docs/START-HERE.md` and `CLAUDE.md` first, as always. CLAUDE.md gained
A-096's rule under "Traps that only fail at runtime".
