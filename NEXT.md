# Next

The saas-foundation security audit (D-66) and the post-audit review (D-68) are
closed: SEC-01–10 and OPS-01 are done (A-136 to A-140). Bookable is back to
closed.

Candidates, not scheduled (D-68): two-stylist visit linking, recording
request-vs-anyone, a rebook-rate read model, reschedule counting, oldest-first
waitlist ranking. Security leftovers, not scheduled: IPv6 /64 grouping and a
per-business daily cap on anonymous bookings, pruning `RateLimitCounter`, and
limits on the public slot reads.

Known ceiling, not an item yet: the public side resolves its business with
`findFirstOrThrow()` and no `where` — replace before a second business exists.

Before any demo: `./scripts/refresh-hosted-demo.sh`.
