# Next

**Pick up: A-145, C4. Staff announcements and field errors** (Phase 22 in
`06-backlog.md`, D-70). A-144 (C3, manage page phone pass) is done, `287398e`.

Then A-146 is gated on OQ-23, A-150 on OQ-24, A-151 on OQ-25 — ask the owner
questions when each item comes up, not before.

Needs a backlog row: `packages/db/appointments/transition.test.ts` › "lets
exactly one of two simultaneous check-ins win" is not barrier-based and fails
under load (2/6 on 2026-09-28). See A-143's PROGRESS entry.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()`/`findFirst()` and no `where`. `salon()` (used by A-144
for the manage-page phone) is another caller of the same assumption. Replace
before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
