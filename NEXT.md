# Next

**Pick up: the owner picks which bundles from `docs/reviews/30-five-lens-review.md`
to schedule.** Five parallel reviews (operator, stylist, booking client, UX,
accessibility) ran 2026-09-28 at `59de25b`. The findings are grouped into
bundles C1–C16 there, and nothing is scheduled yet. For each pick, record a
D-number, then add an A-row to `06-backlog.md`.

The recommended first four are small, verified defects: C1 (a stylist's own
list never refreshes), C2 (the lost race on /book), C3 (one-tap cancel on the
manage page), and C4 (staff live regions that never announce).

The D-68 candidates still stand, and the operator ranked them in §3 of the
review. Two-stylist linking should be built. The rebook-rate read model is
superseded by C10.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()` and no `where`. Replace it before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
