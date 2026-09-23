# Next

## Project closure — the three deliverables (the backlog has no ⬜ rows left)

A-135 shipped and CI is green (`aa35cde`, run 35892508204). Review 29 §6 says
the cascade is done and the project closes. Three deliverables, in this order:

1. ✅ DONE (2026-09-23, every command run against a fresh `bookable_demo`) **`docs/DEMO.md`** — screen by screen: exact commands, accounts and where
   each credential lives, the seeded names to point at, what to say at each
   stop; a troubleshooting table; and a *concede before you're asked* section.
   The concessions list is already written: `docs/reviews/29-operator-review-phase-19-close.md` §6,
   plus A-135's own leave-behind (a colour seated before a gap client's
   post-claim checkout reads capped at the delta). **Run every command in it
   once before it ships**, including the env-var greps.
2. ✅ DONE (2026-09-23) — https://claude.ai/artifact/AUve67hviR4hkQ6AH9t6nq — **The exec brief** — `Bookable in Brief`, via the `exec-brief` skill, for a
   non-engineering reader. Match the storage and rental briefs so the set reads
   as one thing. Scope honesty near the top: what is synthetic, what is not
   deployed.
3. **LinkedIn drafts** — into the Lab Intelligence Ledger
   (`https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i`), tagged to project and
   pillar, no two adjacent drafts sharing a pillar. Mine the *Defects Found* /
   *Hardest Bug* material first — the A-093 segmented-colour map collapse, the
   A-120 truncation, and this phase's "the claim follows the next client into
   the chair" are better posts than any feature.

**Record every artifact URL in `docs/RELEASE_NOTES.md`** before calling it closed.

Model: Sonnet for DEMO.md (mechanical: run the commands, write them down).
Opus only if the exec brief's framing needs it.

## Environment notes (carried forward, still true)

- `bookable_cisim`, `bookable_drift_shadow`, `bookable_shadow` are the non-core DBs; leave them.
- Check `sysctl -n vm.loadavg` and orphan vitest before trusting a slow/killed run.
- `pkill -9 -f "$PWD.*playwright"` before every sweep. Run from REPO ROOT.
- **`--list` says 340.** Unit total 1753 (1752 + 1 skipped). Unit ~3.5 min; e2e ~5 min; CI ~25 min.
- `npm test` needs the env: `npx dotenv -e .env.test -e .env.local -- npx vitest run <file>` for one file.
- **A vitest `Killed`/137 with no JetsamEvent file may be the countertop
  session**: its gate runs an UNSCOPED `pkill -9 -f 'node \(vitest'`.
- `npm run test:e2e -- -g X` breaks (npm eats `-g`); pass a spec file instead.
- No prettier config — don't `prettier --write`.
- zsh globs `?`: quote routes. Docs-only pushes skip CI.
- Local drift check (no shadow DB): `npm run db:migrate:test`, then
  `npx dotenv -e .env.test -- sh -c 'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel packages/db/prisma/schema.prisma --exit-code'`.
- **Monitors that `tail -F` a log a finished command already wrote never fire** —
  arm the monitor BEFORE the run, or just reconcile the log by hand afterwards.
