# Next

Bookable reopened for the saas-foundation security audit (D-66). A-136 closed
SEC-01 + SEC-02 (cross-tenant IDORs) on 2026-09-26; OPS-01 was already done by D-65.

A-137 closed SEC-03 + SEC-05 (public booking rate limit, constant-time cron
secret).

**Pick up: SEC-04** (backlog → *Security findings*): anonymous booking attaches
to an existing client by phone + name. Decide the shape first (verification
step vs new client + staff merge) — it collides with D-55's canonical match
and CLIENT-04's block, so read both before choosing. Then SEC-06 (document the
`x-forwarded-for` / Vercel dependency in `callerKey`, which now keys both limits).

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()` and no `where` — replace before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
