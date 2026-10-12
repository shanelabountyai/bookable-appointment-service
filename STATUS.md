# STATUS — Bookable MCP server (M-track)

Built 2026-10-12 against `docs/prds/mcp/00-mcp-prd.md`. Every backlog item M-000..M-016 is ✅ in that file's §10. Decisions taken along the way: `DECISIONS.md` (M-D1..M-D18). Per-item build notes: `docs/PROGRESS.md` (M-001..M-016). Portfolio notes: `docs/RELEASE_NOTES.md`. The README for a hiring manager: `apps/mcp/README.md`.

## Done

- **Milestone 1 — Foundation.** `apps/mcp` workspace on `@modelcontextprotocol/sdk` 1.32.1; per-person bearer tokens (`McpToken`, issued/revoked by the owner on `/staff/people`, hashed, last-used); token resolved on **every call**; role-built `tools/list`; the §6 error envelope with one test per code; wall-time parsing that refuses DST gaps and overlaps naming both readings; per-token rate limit.
- **Milestone 2 — Reads.** `list_services`, `list_providers`, `find_open_times` (the desk's two offer paths, with the equality test), `get_day`, `get_appointment` (+ `allowed_actions` from the transition table), `find_client`, `get_client_history`, `list_waitlist` (PII rules), owner-only `get_week_report`.
- **Milestone 3 — Writes.** `McpProposal` + `commit_proposal` (single-use claim, 10-minute TTL, outcome recorded); `channel` on every `AppointmentEvent` (13 writers, source-scanned); `prepare_booking`, `prepare_new_client`, `prepare_reschedule` (reassign when the time is unchanged), `prepare_cancel`, `prepare_status_change`, `prepare_waitlist_entry`; barrier-forced race test; desk-vs-MCP parity test.
- **Milestone 4 — Hosted + eval.** Streamable HTTP at `/api/mcp` with bearer auth (stateless, JSON responses; OQ-M5 verified against current client docs); the eval harness with nine database-graded scenarios, scripted dry run 9/9 in CI, Claude run 9/9 on `claude-opus-5-5` for $0.47 (2026-10-12); `apps/mcp/README.md`; `docs/DEMO.md` §13; "via the assistant" on the staff detail page.
- **Gate.** lint, typecheck, 1991 unit tests, e2e against the production build (376), CI green per push (`gh run list`).

## Not done (deliberately)

- **OAuth for claude.ai / Claude Desktop custom connectors.** They accept a static bearer only as an organisation-level credential (Team/Enterprise). Claude Code connects today over HTTP with `--header`; Desktop connects over stdio locally. OAuth is a later item (M-D15).
- **Not deployed.** No production deploy was triggered (the brief said not to). The hosted demo at appt.labintelligence.co is one migration behind (`20261012120000_mcp_token`, `20261012130000_event_channel_mcp_proposal`) until the next manual deploy — run `migrate:deploy` against Neon first, per `NEXT.md`'s standing note.
- **Exec brief and LinkedIn drafts** for the M-track were not produced (they publish artifacts; the brief asked for no external writes). The material is in `docs/RELEASE_NOTES.md` M-001..M-016 — the *Defects found* paragraphs are the posts.
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
5. **Closure artifacts** (per your definition of done): the exec brief (`/exec-brief`, matching the Bookable brief) and the LinkedIn drafts into the Ledger — both from `docs/RELEASE_NOTES.md` M-001..M-016.
