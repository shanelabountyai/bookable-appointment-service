# Next

**Bookable is closed (2026-10-05). The MCP track (M-000..M-016) is built and gated (2026-10-12). The Claude eval ran 2026-10-12: 9/9, $0.47.** `STATUS.md` is the handoff: done / not done / your hand steps. Nothing is queued for a session.

**Hand steps, in order (all yours — they publish or deploy):**
1. Connect Claude Code to the server (stdio or HTTP) and try it — `STATUS.md` §1–2.
2. Deploy via the `main-manual` hook after `migrate:deploy` against Neon (two new migrations), then `./scripts/refresh-hosted-demo.sh`.
3. ~~Exec brief + LinkedIn drafts~~ — done 2026-10-12: https://claude.ai/artifact/MKSe6REdWCNFeH2bLFjemo and Ledger posts 109–113 (`docs/RELEASE_NOTES.md` › Project closure artifacts). Review the five drafts before any goes out.

**Before any demo:** `migrate:deploy` against the Neon demo DB if migrations landed since the last deploy, THEN `./scripts/refresh-hosted-demo.sh`. Salon is closed Sun/Mon: demo from Tuesday.

Known ceilings: `docs/prds/07-decisions.md` D-73..D-77, review 31; MCP: `DECISIONS.md` M-D15 (OAuth).
