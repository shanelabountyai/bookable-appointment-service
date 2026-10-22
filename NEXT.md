# Next

**2026-10-21: the W-track (public API + webhooks) is MERGED to `main` (PR #2, `2660a7e`) — not deployed.** W-000..W-013 ✅, W-014 partial (the one-week Neon re-read waits on a deploy). W-D1 answered: write keys keep desk rights (W-D24). Nothing is queued for a session. Owner hand steps, in order (PR #2's checklist): `migrate:deploy` the five W migrations against Neon → trigger the `main-manual` Deploy Hook → `./scripts/refresh-hosted-demo.sh` → W-D8 spike (book once with an endpoint registered, look for `[webhooks] inline sweep` in the function log) → a week later, Neon `compute_time_seconds` vs 407174, recorded under D-81.

**STATUS: CLOSED / DELIVERED (2026-10-12).** Code, demo script, exec briefs, LinkedIn drafts, cost review and screenshots are all done and recorded. Nothing below needs a session. The only work left is outside the repo: images for Ledger posts 49–53 and 109–113, set aside by the owner.

**Bookable is closed (2026-10-05). The MCP track (M-000..M-016) is built and gated (2026-10-12). The Claude eval ran 2026-10-12: 9/9, $0.47.** `STATUS.md` is the handoff: done / not done / your hand steps. Nothing is queued for a session.

**Hand steps, in order (all yours — they publish or deploy):**
1. ~~Connect Claude Code to the server~~ — done 2026-10-12 over stdio against `bookable_dev` (owner password reset to the demo value first; the book's clients are Alice Hall … Tom Byrne, not the eval's Maria Gomez). HTTP variant untried.
2. ~~Deploy~~ — done 2026-10-12: Neon migrated, hook deploy Ready, hosted book refreshed. To use the assistant against the hosted demo: issue a token on `https://appt.labintelligence.co/staff/people`, then `claude mcp add --transport http bookable-hosted https://appt.labintelligence.co/api/mcp --header "Authorization: Bearer <token>"`.
3. ~~Exec brief + LinkedIn drafts~~ — done 2026-10-12: https://claude.ai/artifact/MKSe6REdWCNFeH2bLFjemo and Ledger posts 109–113 (`docs/RELEASE_NOTES.md` › Project closure artifacts). Drafts reviewed and approved 2026-10-12 (112's opener tightened, 113's spelling Americanised); they still need images before posting.

**Before any demo:** `migrate:deploy` against the Neon demo DB if migrations landed since the last deploy, THEN `./scripts/refresh-hosted-demo.sh`. Salon is closed Sun/Mon: demo from Tuesday.

Known ceilings: `docs/prds/07-decisions.md` D-73..D-77, review 31; MCP: `DECISIONS.md` M-D15 (OAuth).
