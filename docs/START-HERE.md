# Start here — running Bookable with Claude Code

This starter is A-000: the PRD set, the decision log, the three reviews, a failing slot-engine test suite, and the type contract for the engine. Everything below is how to drive the rest.

## The loop

One backlog item per session, top to bottom, no skipping ahead:

1. Read the item in `docs/prds/06-backlog.md`, its story IDs in `00-master-prd.md`, and any decision it cites in `07-decisions.md`.
2. Build it. Tests are part of the item, not a follow-up.
3. Run the gate: `npm run lint && npm run typecheck && npm test && PORT=3300 npm run test:e2e`
4. Mark the item ✅ in `06-backlog.md`.
5. Add the entry to `docs/PROGRESS.md` — what it built, what it decided, what it left behind.
5b. Add the entry to `docs/RELEASE_NOTES.md` — the portfolio-facing version: what is genuinely engineered here rather than scaffolding, written for "walk me through something you built."
6. Commit. Record the SHA in a small follow-up commit, never by amending (amending changes the SHA you just wrote down).

## Session 0 — verify the starter's red state

The slot-engine suite ships failing on purpose (the implementation throws `NotImplementedError`). Prove the harness works before building anything:

> Run `npm install && npm test` at the repo root. Confirm every test in packages/core/scheduling/slot-engine.test.ts fails with NotImplementedError — not with a type error, an import error, or a timeout. Then run `npm run typecheck` and confirm it is clean. Do not implement anything yet.

## Session 1 — A-001, the scaffold

> Build A-001 from docs/prds/06-backlog.md: the full monorepo scaffold around the existing packages/core/scheduling files — Next.js App Router + TypeScript in apps/web, Prisma + Postgres in packages/db (docker-compose for local Postgres; port 3300 as the config default), Playwright + axe, and CI that (a) applies all migrations to a throwaway Postgres from scratch with a drift check, and (b) runs the unit suite twice, under TZ=Pacific/Kiritimati and TZ=UTC, asserting both pass. Keep the existing root vitest setup working. Read CLAUDE.md first and preserve its gate command.

## Session 2 — A-002, the time module

This is where the project's central discipline gets built. The spec is `docs/reviews/03-slot-engine-spec.md` §§0–1 and the DST cases in §3.

> Build A-002: packages/core/time. Implement the branded CalendarDay/WallTime/Instant types from packages/core/scheduling/types.ts, the single conversion module with resolve() returning unique | gap | ambiguous, and the ESLint bans from CLAUDE.md. TDD: write the resolution tests for 2026-03-08 02:30 (gap) and 2026-11-01 01:30 (ambiguous) in America/Chicago first, using the verified instants from the spec. Use temporal-polyfill at the boundary only.

## Session 3 — A-003, the data model

The highest-leverage session in the project. Do not let it get rushed.

> Build A-003 from docs/prds/06-backlog.md. Read 00-master-prd.md §6 and §8 and decisions D-2, D-7, D-12, D-13 first. Before writing the schema, show me the full entity list AND the exact SQL of the exclusion constraint (including the partial-status predicate and the half-open range) and wait for me to confirm both. Then write the schema, hand-write the migration, and add constraint tests that insert overlapping rows directly against the database — bypassing the application — and assert refusal with SQLSTATE 23P01.

The pause before the schema is the point: the constraint's shape (buffers inside the range, blocks outside the table, which statuses participate) is the decision the whole engine builds against.

## The slot engine session (A-008)

The red suite in `packages/core/scheduling/slot-engine.test.ts` is the *starting* target, not the whole definition of done. When it is green:

> Extend the slot-engine suite to the full matrix in docs/reviews/03-slot-engine-spec.md §3 — every table row is a test, using the spec's verified UTC instants — plus the §2 invariants as property tests with fast-check. The engine is done when the matrix passes byte-identically under TZ=UTC and TZ=Pacific/Kiritimati.

## Using the salon-operator agent

After each milestone, before starting the next:

> Use the salon-operator agent to review what has been built so far against the backlog, and tell me the most consequential gap.

It reads `PROGRESS.md` first and judges by "would this survive a Saturday" — late columns, walk-ins, the phone ringing, a sick stylist. Its job is to catch what only shows up when someone who has run a front desk looks at the product.

## Rules that will save you a bad afternoon

- **`07-decisions.md` wins over the PRDs.** If a proposal contradicts it, the log is right — unless the owner consciously supersedes the decision with a new D-number.
- **Walk each demo checkpoint when its milestone closes, not when convenient.** The rental build's checkpoint found four defects, all in items already marked ✅, all invisible from inside the item that introduced them.
- **Never let the two time axes mix.** If a `Date` is crossing the engine boundary, or a `{date, time}` pair is going into a URL, stop — that is the bug this project exists to practice not writing.
- **The race tests are deterministic.** If one flakes, the test (or the mechanism) is broken; do not add retries.
- **Staff can always act; customers are always safe.** Overrides need a reason and an audit row, never a dropped constraint. Nothing is ever silently cancelled or moved.
