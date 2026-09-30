# Next

**Pick up: A-152** (C11, series ending — Phase 22 in `06-backlog.md`, D-70).
A-151 (C10, owed a rebook) is done (D-74).

Needs a backlog row: `packages/db/appointments/transition.test.ts` › "lets
exactly one of two simultaneous check-ins win" is not barrier-based and fails
under load (2/6 on 2026-09-28). See A-143's PROGRESS entry.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()`/`findFirst()` and no `where`. `salon()` (used by A-144
for the manage-page phone) is another caller of the same assumption. Replace
before a second business exists.

Known ceiling (D-74): a salon cancel from the appointment panel is not flagged,
so it never reaches /staff/owed.

Known ceiling (D-73): "changed since print" does not count a row moved OFF a
column or cancelled after the print.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
