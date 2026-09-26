# Next

Bookable reopened for the saas-foundation security audit (D-66). Done:
SEC-01 + SEC-02 (A-136), SEC-03 + SEC-05 (A-137), SEC-04 (A-138, D-67:
match kept, accepted at phone-desk parity). OPS-01 was already done by D-65.

**Pick up: SEC-06** (backlog → *Security findings*): document the
`x-forwarded-for` / Vercel dependency in `callerKey` (`lib/manage/token-gate.ts`),
which now keys both the manage-link and public-booking limits. Docs/comment
only, so Sonnet fits. That closes the audit.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()` and no `where` — replace before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
