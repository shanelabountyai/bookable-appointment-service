# Next

**Phase 23 is scheduled (D-76): A-153..A-161, from `docs/reviews/31-five-lens-review-phase-22-close.md`.**
Pick up: **A-153 (E1) — series extend and "never booked" tell the truth.**
The project closes after Phase 23. A-160 (C12) needs OQ-26 answered first.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()`/`findFirst()` and no `where`. `salon()` (used by A-144
for the manage-page phone) is another caller of the same assumption. Replace
before a second business exists.

Known ceiling (D-74): a salon cancel from the appointment panel is not flagged,
so it never reaches /staff/owed.

Known ceiling (D-73): "changed since print" does not count a row moved OFF a
column or cancelled after the print. (Review 31 N1 adds: nor a services or
client change in place — a candidate, not scheduled.)

Known ceilings (D-75): no seeded series, so `/staff/series` is empty in the
demo until one is booked. Series ended before A-152 carry no `endedAt`.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
