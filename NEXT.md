# Next

**Pick up: A-144, C3. The manage page gets the phone pass** (Phase 22 in
`06-backlog.md`, D-70). A-143 (C2) is done, `c53db69`.

Then A-145 (live regions). Three items are gated on owner questions, to be
asked when the item comes up and not before: A-146 → OQ-23, A-150 → OQ-24,
A-151 → OQ-25.

Needs a backlog row: `packages/db/appointments/transition.test.ts` › "lets
exactly one of two simultaneous check-ins win" is not barrier-based and fails
under load (2/6 on 2026-09-28). See A-143's PROGRESS entry.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()` and no `where`. Replace it before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
