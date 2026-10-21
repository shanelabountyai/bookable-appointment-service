# STATUS — Bookable public API + webhooks (W-track)

**BUILT ON A BRANCH, NOT MERGED, NOT DEPLOYED (2026-10-21).** Branch `w-track-wip-snapshot`, draft PR #2. W-000..W-013 ✅ in `docs/prds/api/00-api-webhooks-prd.md` §10; W-014 partial (this file, DEMO §14, release notes done; the one-week cost re-read needs a deploy first). Decisions: `DECISIONS.md` W-D1..W-D23 (D-80, D-81 in `07-decisions.md`). Per-item notes: `docs/PROGRESS.md`. Reviewer guide: `docs/api/README.md`.

## Done

- **Milestones 1–3 (overnight, W-000..W-007).** API keys with scopes, problem+json errors with one mapper shared with MCP, cursor pagination, all reads, idempotent writes (barrier-raced, crash-tested), moves through the desk's own functions, desk-vs-API parity. Re-gated on the native engine on 2026-10-21 (they had only the overnight stand-in): 2077 passed.
- **Milestone 4 — webhooks (W-008..W-010).** `AppointmentEvent.seq` numbered at COMMIT by a deferred trigger (commit order, gapless, every writer covered); `GET /v1/events?since=`; endpoints and deliveries derived from the log; one-statement claim; backoff, dead-letter at 6, pause at 10, disable on 410; https-only + no private addresses at registration and at send; HMAC signatures with 24 h rotation overlap; `scripts/webhook-receiver.ts`.
- **Milestone 5–6 (W-011..W-013).** Owner page: endpoints, delivery log with filters, replay (row and from a seq). OpenAPI generated from the zod schemas with a drift test. e2e golden path with the reference receiver, replay at 390 px, PII sweep.

## Not done

- **Not merged, not deployed.** No `migrate:deploy` against Neon, no hook, no refresh: the session brief forbade them. Three migrations wait: `20261021120000_event_seq`, `20261021130000_webhooks`, `20261021140000_webhook_secret_rotation` (plus the overnight `20261020120000_api_key`, `20261020130000_idempotency_record`).
- **`waitUntil` / `after()` on the Vercel plan is unverified (W-D8).** Proven locally in the production build (e2e + DEMO §14 log line). The daily sweep is the carrier of record if it does not run there.
- **The one-week Neon re-read (W-014, D-78's method)** — after the deploy.
- **Exec brief and LinkedIn posts** — owner hand steps (they publish).

## Open decisions

1. **W-D1 — an API key with `write` has the front desk's rights** (cancel, reschedule, status moves, client messages), recorded as `staff`-typed actor with `channel = api`. Keep, or hold integrations below the desk (needs an `integration` actor and transition-table rows)?
2. **D-81 / W-D23 — retries ride the daily cron** (your cost call). Restore an hourly sweep only if an integration needs retries within the hour.

## Exact steps for you to do by hand (in order, when you choose to ship)

1. Review and merge PR #2 (never merged from a session).
2. `migrate:deploy` against the Neon demo DB (the five migrations above; `event_seq` backfills history).
3. Trigger the `main-manual` Deploy Hook (D-71) — nothing new to set in Vercel; `WEBHOOK_ALLOW_PRIVATE` must stay UNSET there.
4. `./scripts/refresh-hosted-demo.sh`. Demo from Tuesday (salon closed Sun/Mon).
5. Spike W-D8: book once on the hosted desk with an endpoint registered, and look for `[webhooks] inline sweep` in the function log.
6. A week later: `neonctl projects get <id> --org-id <org> --output json` → `compute_time_seconds`; compare with 407174 (2026-10-12) and record the delta under D-81.

---

# STATUS — Bookable MCP server (M-track)

**CLOSED / DELIVERED 2026-10-12.** Built, gated, deployed, evaluated (9/9), and every closure artifact recorded. Screenshots 14–15 in `docs/screenshots/` show the token list and one assistant exchange.

Built 2026-10-12 against `docs/prds/mcp/00-mcp-prd.md`. Every backlog item M-000..M-016 is ✅ in that file's §10. Decisions taken along the way: `DECISIONS.md` (M-D1..M-D18). Per-item build notes: `docs/PROGRESS.md` (M-001..M-016). Portfolio notes: `docs/RELEASE_NOTES.md`. The README for a hiring manager: `apps/mcp/README.md`.

## Done

- **Milestone 1 — Foundation.** `apps/mcp` workspace on `@modelcontextprotocol/sdk` 1.32.1; per-person bearer tokens (`McpToken`, issued/revoked by the owner on `/staff/people`, hashed, last-used); token resolved on **every call**; role-built `tools/list`; the §6 error envelope with one test per code; wall-time parsing that refuses DST gaps and overlaps naming both readings; per-token rate limit.
- **Milestone 2 — Reads.** `list_services`, `list_providers`, `find_open_times` (the desk's two offer paths, with the equality test), `get_day`, `get_appointment` (+ `allowed_actions` from the transition table), `find_client`, `get_client_history`, `list_waitlist` (PII rules), owner-only `get_week_report`.
- **Milestone 3 — Writes.** `McpProposal` + `commit_proposal` (single-use claim, 10-minute TTL, outcome recorded); `channel` on every `AppointmentEvent` (13 writers, source-scanned); `prepare_booking`, `prepare_new_client`, `prepare_reschedule` (reassign when the time is unchanged), `prepare_cancel`, `prepare_status_change`, `prepare_waitlist_entry`; barrier-forced race test; desk-vs-MCP parity test.
- **Milestone 4 — Hosted + eval.** Streamable HTTP at `/api/mcp` with bearer auth (stateless, JSON responses; OQ-M5 verified against current client docs); the eval harness with nine database-graded scenarios, scripted dry run 9/9 in CI, Claude run 9/9 on `claude-opus-5-5` for $0.47 (2026-10-12); `apps/mcp/README.md`; `docs/DEMO.md` §13; "via the assistant" on the staff detail page.
- **Gate.** lint, typecheck, 1991 unit tests, e2e against the production build (376), CI green per push (`gh run list`).

## Not done (deliberately)

- **OAuth for claude.ai / Claude Desktop custom connectors.** They accept a static bearer only as an organisation-level credential (Team/Enterprise). Claude Code connects today over HTTP with `--header`; Desktop connects over stdio locally. OAuth is a later item (M-D15).
- ~~Not deployed~~ **Deployed 2026-10-12** (owner's go): `migrate:deploy` applied `20261012120000_mcp_token` and `20261012130000_event_channel_mcp_proposal` to Neon, the `main-manual` hook built `123fc7c` (Ready, 37 s), and `refresh-hosted-demo.sh` replaced the book (646 appointments; derived tables identical). Proof the new code is live: `POST https://appt.labintelligence.co/api/mcp` answers `401` with `WWW-Authenticate: Bearer realm="bookable-mcp"`, which only the MCP route sends. Hosted tokens: sign in on the hosted `/staff/people` (the refresh recreated the owner login) and issue one there.
- ~~Exec brief and LinkedIn drafts~~ **Done 2026-10-12:** *Bookable Assistant in Brief* at https://claude.ai/artifact/MKSe6REdWCNFeH2bLFjemo (private until shared) and Ledger posts 109–113. Recorded in `docs/RELEASE_NOTES.md` › Project closure artifacts.
- **Client notes over MCP** (OQ-M3), **overrides, pushes, releases, merges, settings** — out of scope by the PRD (§3), not omissions.

## Open decisions

None blocking. Everything the spec left open was taken with the recommended default and logged: `DECISIONS.md` M-D1..M-D18. Two worth a glance because they shape the product: **M-D7** (the credential is re-checked on every call) and **M-D16** (error payloads travel in `content`, not `structuredContent`, because validating clients reject the latter).

## Exact steps for you to do by hand

1. **Try it from Claude Code (local, stdio).** Sign in as the owner, issue a token on `/staff/people` ("AI access"), then:
   ```bash
   claude mcp add --env BOOKABLE_MCP_TOKEN=<paste> --env DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-)" --transport stdio bookable -- npx tsx apps/mcp/src/stdio.ts
   claude mcp list        # expect "bookable … ✔ Connected"
   ```
   Then ask Claude Code: *"Who's in with Dana tomorrow, and when is she free for a cut?"*
2. **Try it over HTTP** against the production build on :3300 (`npm run e2e:server` or the deployment):
   ```bash
   claude mcp add --transport http bookable-http http://localhost:3300/api/mcp --header "Authorization: Bearer <paste>"
   ```
3. **Re-run the Claude eval** when the tools or scenarios change (uses the TEST database and resets it; `ANTHROPIC_API_KEY` in `.env.local`):
   ```bash
   EVAL_COST_CAP_USD=1 npm run eval                  # or EVAL_ONLY=book-named-client,sick-stylist-move-clients
   ```
   Results land in `apps/mcp/eval/results/<timestamp>.json` (gitignored). Baseline 2026-10-12: 9/9, $0.47. Record each run in `docs/PROGRESS.md` under M-015.
4. **Deploy, when you choose to** — trigger the `main-manual` hook (D-71), after `migrate:deploy` against the Neon demo DB; then `./scripts/refresh-hosted-demo.sh`. Set nothing new in Vercel: the MCP route needs no env var beyond what the app already has.
5. ~~Closure artifacts~~ — done 2026-10-12 (see *Not done* above). Share the brief from its Share menu when you want it forwardable; it links nothing private.
