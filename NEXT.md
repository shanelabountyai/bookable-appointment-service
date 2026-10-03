# Next

**The backlog is empty. Phase 23 closed with A-161.** Pick up: **project closure**
(global CLAUDE.md, *Definition of done*). The four deliverables: `docs/DEMO.md` refresh
(run every command in it), the exec brief (`exec-brief` skill), the LinkedIn posts in
the Ledger, and the cost review. Record every artifact URL in `docs/RELEASE_NOTES.md`.

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

Known ceiling (A-153): `AppointmentSeries.providerId` stays the rule's
ORIGINAL stylist; extend and the list read the latest active occurrence.
All Extend buttons on /staff/series show pending during any one extend.

Known ceiling (D-77): the undo is on the appointment panel only, not the day chip.
