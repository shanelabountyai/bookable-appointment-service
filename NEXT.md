# Next

**Pick up: A-146, C5. The client record can be corrected, and it explains
itself** (Phase 22 in `06-backlog.md`, D-70) — **DECIDE FIRST (OQ-23), THEN
BUILD**: ask the owner question before writing any code. A-145 (C4, staff live
regions and field errors) is done, `d7c4a64`.

Then A-150 is gated on OQ-24, A-151 on OQ-25 — ask when each comes up, not
before. A-147 (C7, design system on the busy screens) has no gate and no open
dependency, so it can go before A-146 if OQ-23 is still unanswered.

Needs a backlog row: `packages/db/appointments/transition.test.ts` › "lets
exactly one of two simultaneous check-ins win" is not barrier-based and fails
under load (2/6 on 2026-09-28). See A-143's PROGRESS entry.

Needs a backlog row (found by A-145): `e2e/conflicts.spec.ts`'s `beforeEach`
computes its test day as "next Tuesday after `new Date()`" — a real
wall-clock read. It broke on 2026-09-29 when that Tuesday rolled into
October: Playwright's `getByLabel('To')` substring-matches "Oc**to**ber",
so `getByLabel('To').selectOption(...)` hits a 3-way strict-mode violation
against the `<select>` plus two client checkboxes. Will fail on any date
whose computed Tuesday lands in October. Fix: freeze `DAY` like the engine
tests do, or use an exact-match/role-scoped locator for the `<select>`. See
A-145's PROGRESS entry.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()`/`findFirst()` and no `where`. `salon()` (used by A-144
for the manage-page phone) is another caller of the same assumption. Replace
before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
