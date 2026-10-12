# Next

**Bookable is closed (2026-10-05). The MCP track (M-000..M-016) is built and gated (2026-10-12).** `STATUS.md` is the handoff: done / not done / your five hand steps. Nothing is queued for a session.

**Hand steps, in order (all yours — they spend credit, publish, or deploy):**
1. Connect Claude Code to the server (stdio or HTTP) and try it — `STATUS.md` §1–2.
2. Run the Claude eval: `EVAL_COST_CAP_USD=1 npm run eval` — record cost + pass count under M-015 in `docs/PROGRESS.md`.
3. Deploy via the `main-manual` hook after `migrate:deploy` against Neon (two new migrations), then `./scripts/refresh-hosted-demo.sh`.
4. Exec brief + LinkedIn drafts for the M-track from `docs/RELEASE_NOTES.md`.

**Before any demo:** `migrate:deploy` against the Neon demo DB if migrations landed since the last deploy, THEN `./scripts/refresh-hosted-demo.sh`. Salon is closed Sun/Mon: demo from Tuesday.

Known ceilings: `docs/prds/07-decisions.md` D-73..D-77, review 31; MCP: `DECISIONS.md` M-D15 (OAuth), M-D17 (eval not run).
