# Next

**Pick up: A-147, C7. The design system reaches the busy screens** (Phase 22
in `06-backlog.md`, D-70) — no gate, no open dependency. A-146 (C5, the
client record can be corrected, and it explains itself) is done, `55c5e55`,
deciding OQ-23 as D-72.

Then A-148 (C6, focus management) depends on A-147. A-150 is gated on OQ-24,
A-151 on OQ-25 — ask when each comes up, not before.

Needs a backlog row: `packages/db/appointments/transition.test.ts` › "lets
exactly one of two simultaneous check-ins win" is not barrier-based and fails
under load (2/6 on 2026-09-28). See A-143's PROGRESS entry.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()`/`findFirst()` and no `where`. `salon()` (used by A-144
for the manage-page phone) is another caller of the same assumption. Replace
before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
