# Bookable — Claude Code starter (A-000)

Appointment scheduling for a service business. Third learning build in the idiom, after the self-storage (`B-`) and rental (`R-`) platforms. **This starter supersedes `prd-bookable-appointment-app.md` (draft v1)** — the draft went through three reviews and the results are this repo.

## What's in the box

| Artifact | What it is |
|---|---|
| `CLAUDE.md` | Repo conventions, the time rules, DB invariants, the gate — read by every session |
| `docs/START-HERE.md` | The session loop and the copy-paste prompts for Sessions 0–3 |
| `docs/prds/00-master-prd.md` | The rewritten PRD: testable ACs, full transition table, entity list, frozen metrics |
| `docs/prds/06-backlog.md` | Strictly-ordered backlog (A-numbers), 4 milestones, 3 demo checkpoints |
| `docs/prds/07-decisions.md` | D-1..D-14 settled decisions (they OVERRIDE the PRD) + open owner questions |
| `docs/reviews/01-operator-review.md` | Salon/med-spa/HVAC operator's 13 recommendations on draft v1 |
| `docs/reviews/02-product-owner-review.md` | 29 requirement defects + structural gaps + corrected sequencing |
| `docs/reviews/03-slot-engine-spec.md` | **Normative**: engine signature, ~40 invariants, ~90-case DST/edge matrix with verified instants, concurrency spec |
| `docs/sibling-prds/prd-membership-subscriptions.md` | Skeleton for "Project #2 (subscriptions)" referenced in the draft's Non-Goals |
| `packages/core/scheduling/types.ts` | The engine's type contract (branded time axes, SlotQuery/SlotResult) |
| `packages/core/scheduling/slot-engine.test.ts` | ~35 failing tests — the TDD red state A-008 builds against |
| `.claude/agents/salon-operator.md` | Milestone-review agent (the rental-operator pattern) |

## First commands

```bash
npm install
npm test          # EXPECTED: everything fails with NotImplementedError — that's Session 0
npm run typecheck # EXPECTED: clean
```

Then open `docs/START-HERE.md` and run Session 0's prompt in Claude Code.

## The one-paragraph orientation

The slot engine is the learning artifact and it is specified to the instant: rules are wall-clock, occurrences are instants, one module converts, and the database — not the application — makes double-booking impossible via a gist exclusion constraint (which is why this repo is Postgres from commit one). The operator review added what keeps booking software alive after week two: staff booking as the primary path, check-in/running-late as modeled state, no-show history as the deposit substitute, and the rule that nothing is ever silently cancelled or moved.
