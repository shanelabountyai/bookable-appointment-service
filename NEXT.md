# Next

**Project closed 2026-10-05.** Nothing is queued. All four closure deliverables exist:
DEMO.md (re-run 2026-10-03), exec brief (version 3, https://claude.ai/artifact/AUve67hviR4hkQ6AH9t6nq),
LinkedIn drafts 49-53 in the Ledger (written at the first closure; no new ones this pass),
cost review (D-78).

**Open once:** re-read Neon (`neonctl projects get bold-base-98485145 --org-id org-morning-smoke-06224724`) around 2026-10-12; baseline 405836 s compute (D-78). The daily cron is live.

**Before any demo:** `migrate:deploy` against the Neon demo DB if migrations landed since the last deploy, THEN `./scripts/refresh-hosted-demo.sh` (the refresh empties the book before copying, so a stale schema leaves it empty). Salon is closed Sun/Mon: demo from Tuesday.

Known ceilings are recorded in docs/prds/07-decisions.md (D-73..D-77) and review 31.
