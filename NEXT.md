# Next

**Pick up: define four reviewer agents, then run all five reviews in parallel**
(decided 2026-09-27, D-69's last line). `.claude/agents/salon-operator.md`
already exists (owner lens, Opus). Add, in the same shape (read-only tools,
`model:` pinned in frontmatter):

- `stylist` — Opus. Works one column on the staff day view: late clients,
  colour processing gaps, the push, running late, what's opened up.
- `booking-client` — Sonnet. `/book` and `/manage` on a 390px phone,
  first-timer vs regular, no-preference, the fall-back day.
- `ux-design` — Sonnet. Hierarchy, consistency and copy across staff and
  public screens.
- `accessibility` — Opus. Keyboard, screen reader, contrast in both schemes,
  beyond what the axe helper already catches.

Findings go to a review doc in `docs/reviews/` and become backlog candidates;
nothing is scheduled until the owner picks.

Security leftovers are closed (A-141). Candidates, not scheduled (D-68):
two-stylist visit linking, recording request-vs-anyone, a rebook-rate read
model, reschedule counting, oldest-first waitlist ranking.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()` and no `where` — replace before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
