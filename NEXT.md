# Next

Bookable reopened for the saas-foundation security audit (D-66). A-136 closed
SEC-01 + SEC-02 (cross-tenant IDORs) on 2026-09-26; OPS-01 was already done by D-65.

**Pick up: SEC-03 + SEC-05** (backlog → *Security findings*), one small item:
rate-limit public `confirmAppointment` with the existing `consumeRateLimit`, and
compare the cron secret with `timingSafeEqual`. Re-verify line numbers first.
Then SEC-04 (returning-client match by phone + name) and SEC-06 (document the
`x-forwarded-for` / Vercel dependency).

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()` and no `where` — replace before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
