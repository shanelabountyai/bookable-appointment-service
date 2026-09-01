# Bookable — Appointment Scheduling Platform

Appointment scheduling for a small service business (sample: a 4-chair salon). Learning project, built to professional standards. Third build in the idiom — same stack and working conventions as the self-storage (`B-`) and rental (`R-`) platforms.

## How to work in this repo

- Product source of truth: `docs/prds/`. Build order: `docs/prds/06-backlog.md`, top to bottom, one item per session.
- `docs/prds/07-decisions.md` OVERRIDES any conflicting PRD text. Never re-open a settled decision; append new decisions there instead.
- `docs/reviews/03-slot-engine-spec.md` is **normative** for the time module (A-002), slot engine (A-008), and booking concurrency (A-009) — signatures, invariants, edge matrix, and the verified DST instants come from there, not from the PRD prose.
- Stack: Next.js (App Router) + TypeScript, Postgres + Prisma, Tailwind + shadcn, Vitest/Playwright + axe, Vercel target. Monorepo: `apps/web`, `packages/core` (domain logic — the slot engine lives here as a pure function), `packages/db` (Prisma schema + hand-written migrations).
- **This repo owns port 3300** (storage hardcodes 3000, rental owns 3100) — it is the config default so the cross-repo e2e footgun from the rental build cannot recur.
- Canonical entity names: `00-master-prd.md` §8. Money is integer cents. `businessId` on every core table.
- After completing a backlog item, in order: run the gate → mark the item ✅ in `06-backlog.md` → add its entry to `docs/PROGRESS.md` (what it built / what it decided / what it left behind) → add its entry to `docs/RELEASE_NOTES.md` (portfolio-facing: what's genuinely engineered here, not scaffolding — for interview/proof-of-expertise use) → commit (`A-012: appointment state machine`) → record the SHA in a small follow-up commit, never by amending → **push both commits together in ONE push** → **watch the CI run and confirm it is green before reporting the item done.**
- **A local gate is not the gate. CI is.** The first ten runs of this repo's CI failed while every local gate passed, because two generated artifacts (`packages/db/generated/client`, Next's `.next/types`) exist on the dev machine, are gitignored, and were never generated on the runner. `npm ci` now regenerates both via `postinstall`/`pretypecheck`, and CI asserts they exist. The rule that prevents a recurrence is behavioural: **`gh run watch` (or `gh run list --limit 1`) after every push, before saying the word "done".**
- **The same artifacts break the LOCAL gate after the repo directory moves.** Mirror image of the CI failure above: moving this repo out of `~/Documents/Claude/Projects/` left the old absolute path compiled into `apps/web/.next`, so Prisma searched the pre-move location and every e2e spec failed (`Query Engine ... not found`, 30 of 37) while all 536 unit tests stayed green — the production build is the only thing that reads the bundle. After moving or renaming the directory: `rm -rf apps/web/.next && npm run db:generate` before trusting a sweep. The `.dylib` being present is not evidence the path is right.
- **One push per item, not two.** Two pushes = two billed CI runs. Commit the work, commit the SHA record, then push once. Docs-only pushes are skipped by `paths-ignore` anyway, and `concurrency: cancel-in-progress` kills superseded runs.

## The time rules (the trap this project exists to practice)

- **Two axes, never mixed**: `CalendarDay`/`WallTime` (branded strings) for rules — weekly hours, override days; `Instant` for occurrences — anything booked. Exactly one module converts between them, and its `resolve()` returns `unique | gap | ambiguous`, never a bare instant. (D-3)
- **`@db.Date` is banned.** A calendar day is stored as `CHAR(10)`. Postgres `date` → JS `Date` is the exact path that cost the rental build a silent day-west shift with ten green tests (its R-042).
- Banned by lint, repo-wide: `new Date(string)`, `Date.parse`, `get/setHours`, `toISOString().slice(0,10)`, `getTimezoneOffset`. Every one is a silent axis-crossing through the process timezone.
- **Slot identity is the instant.** No URL, token, form, or job payload carries `{date, time}` — on fall-back day "01:30" names two instants. (D-4)
- The engine takes `now` as a parameter. Nothing in `packages/core` reads the system clock.
- Appointment duration is physical seconds, not a wall-clock delta: a 90-minute service starting 01:30 on spring-forward day ends at 04:00 on the wall.
- CI runs the suite under `TZ=Pacific/Kiritimati` and `TZ=UTC` and expects identical results. A UTC-only CI hides exactly the bugs this project is for.

## Invariants the database enforces

- **No-overlap is the exclusion constraint** (`providerId WITH =`, `tstzrange(blockedStart, blockedEnd, '[)') WITH &&`, partial over active statuses), hand-written SQL. App code writes and maps SQLSTATE **`23P01`** (not `23505` — Prisma will NOT surface it as `P2002`) to `SlotTaken` → 409. Never check-then-write as the correctness mechanism; `READ COMMITTED` is sufficient *because* the constraint exists. (D-2)
- **Half-open `[start, end)` everywhere** — constraint, engine, tests. `'[]'` makes back-to-back appointments false-conflict and the salon can never book consecutive clients.
- `blockedStart`/`blockedEnd` (body ± buffers) are stored columns; the constraint ranges over them, so buffer-only overlaps are refused too.
- Time off / ad-hoc blocks are **outside** the constraint's table on purpose: blocking over an existing booking must *surface* the conflict for a human (AVAIL-05), not be refused by the database.
- `AppointmentEvent` is append-only by trigger; FKs into it are `onDelete: Restrict` (`SetNull` cascades hit the trigger and fail at runtime — rental learned this twice).
- Staff overrides write a **zero-width blocked range** plus `overriddenFromRange` for display — the constraint never lies, the day view renders the true collision. (D-8)
- Migrations with constraints/triggers are hand-written (`prisma migrate dev --create-only`, then edit). Never `db push`. Never edit an applied migration — add a new one.

## Traps that only fail at runtime

- **A status enum is never one edit.** Every list that reads appointment status (constraint predicate, busy-set query, reminder eligibility, day-view filters, transition table) lives in or is derived from one module. Adding a state means grepping every reader — rental's `VERIFIED` defect, structurally prevented here.
- **A CONSTRAINT is never one edit either** — the mirror of the status-enum rule, and the thing checkpoint 5 found three times in one item. A-063 split the chair invariant in two (envelopes may overlap for the same holder; bodies never overlap) and threaded every WRITE path. It missed three READERS that model the room independently of the database: the availability sweep (`fullSpans` counted holds, so the room stopped offering an empty chair), the push's in-memory chair planner, and — by inspection — anything else holding its own copy of the room. When you change what the database permits, grep for everything that *predicts* the answer, not just everything that writes it. A reader stricter than the constraint does not fail safe; it refuses work the salon needs.
- `no_show` and `completed` still **occupy** their time in the busy set; only `cancelled`/`cancelled_late` free it.
- The busy-set query is an **instant-overlap predicate** (`blockedEnd > windowStart AND blockedStart < windowEnd`), never `WHERE date(startAt) = day` — that misses the 23:30 booking that runs past midnight, and the engine then double-books 00:00.
- Reschedule is a same-row `UPDATE` in one transaction (D-6). Cancel-then-book across two transactions can leave a customer with *no* appointment. If an event-log row pair is wanted, cancel-then-insert **inside one transaction** is fine — the distinction is one transaction vs two, and the code comment must say so.
- Temporal (polyfill) at the boundary only; the engine core is integer epoch-millis arithmetic — DST-proof by construction and library-free.
- **A layout that declines to render `{children}` does not stop the page rendering beside it**, and on a streamed `force-dynamic` page the throw then lands *after* the shell has flushed — so the response is **200** with an error boundary where the content should be. Playwright's `webServer` probe reads that as healthy (`isURLAvailable` accepts 200–403), and so does any spec that checks `response.status()`. Guard the DATA at every reader, never once in a layout; assert what the page SAYS, never only that it answered. A-064 shipped the layout-only version and the log carried the `P2025` the green probe could not.
- Never expose slot-exclusion reasons on public routes: `overlaps-booking` tells an anonymous visitor exactly when the provider is with a client. `explain` is for tests and authenticated staff surfaces, enforced at the route.

## The gate

Nothing is done until all four pass:

```
npm run lint && npm run typecheck && npm test && PORT=3300 npm run test:e2e
```

- e2e runs against a production build (rental's 4x speed / memory lesson); `E2E_DEV=1` restores the dev server for stack traces.
- Read the e2e summary, not the tail: the gate is `passed + skipped + flaky` reconciling against `--list`'s total.
- The race tests are deterministic (barrier-based, spec §4.5) — a "flaky" race test is a broken race test, not a retry candidate. The nightly fuzz asserts the SQL overlap-invariant query returns zero rows, not a success count.
- Run the drift check before pushing any schema change; CI applies all migrations to a throwaway Postgres from scratch.

## Test suite rules

- Every engine test supplies a frozen `now`. A test that reads the clock is wrong even when it passes.
- Buffer fixtures always use **unequal** buffers on adjacent appointments — equal buffers hide whose-buffer bugs.
- Never write a fixture where service duration equals the grid interval — it hides the removes-multiple-candidates defect (spec GR-2).
- Absence assertions must check the *reason*: `expect(reasonFor('11:00')).toEqual(['overlaps-buffer'])`, not `not.toContain` — an absence test passes for a dozen wrong reasons.
- DST fixtures use the verified instants in `docs/reviews/03-slot-engine-spec.md` §3 — do not re-derive them by hand.
- The seed anchors to a **fixed date constant** spanning both DST transitions. A seed anchored to `now` makes the DST tests exist in March and vanish in July with nothing failing.
- **`seedSetup` runs twice with no reset between and every column of every table must be identical** (A-045). That diff is the only thing that can see an instruction applied before the rows it matches exist — checkpoint 3's dormant resource layer was a *column*, and the idempotence test in place at the time counted providers and services. Count assertions cannot see columns. `seedDensity` is deliberately **not** idempotent and refuses on a non-empty book; reset instead.
- **e2e exercises the FIRST seed run, not the second.** `e2e/fixtures.ts` TRUNCATEs before every test via an `auto: true` fixture, so a spec's `beforeEach` seeds an empty database. A feature that is dormant on a fresh install is dormant in e2e too — the thing that catches it is an assertion, not a harder reset.
