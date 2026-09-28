# Next

**Pick up: A-142, C1. A stylist's own list stays live** (Phase 22 in
`06-backlog.md`, scheduled by D-70 from `docs/reviews/30-five-lens-review.md`).
It's small: `useAutoRefresh` moves out of `day-grid.tsx` into a shared hook,
and `?provider=` and `/staff/opened` mount it. Add the staleness e2e on the
list.

Then work top to bottom: A-143 (the lost race on /book), A-144 (manage
cancel), A-145 (live regions). Three items are gated on owner questions, to
be asked when the item comes up and not before: A-146 → OQ-23, A-150 → OQ-24,
A-151 → OQ-25.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()` and no `where`. Replace it before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
