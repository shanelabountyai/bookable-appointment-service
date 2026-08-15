# Release Notes — Bookable

Portfolio-facing log: what got built and why it's a genuine engineering artifact,
not scaffolding. Written for "walk me through something you built" — pair with
`docs/PROGRESS.md` (the mechanical build log: decisions, what was left behind)
and `docs/reviews/03-slot-engine-spec.md` (the deepest technical spec in the repo).

Updated once per backlog item, same cadence as `PROGRESS.md`.

---

## A-001 — Monorepo & app scaffold

**What it is:** Next.js (App Router) + TypeScript in `apps/web`, Prisma +
Postgres in `packages/db`, the pure-function domain core in `packages/core`,
npm workspaces tying them together. Playwright + axe for e2e/accessibility.
CI that migrates a throwaway Postgres from scratch (drift check) and runs the
unit suite under two timezones.

**Why it's not boilerplate — talking points:**
- **CI runs the test suite twice, under `TZ=UTC` and `TZ=Pacific/Kiritimati`**
  (UTC+14, the calendar's extreme edge) and asserts identical results. A
  UTC-only CI is the single most common way a timezone bug ships silently —
  this repo's CI is built to make that impossible from commit one, before a
  single time-handling line exists.
- **Postgres from commit one, not "SQLite for now."** The project's core
  correctness guarantee (no double-booked appointments) is a database
  exclusion constraint (`EXCLUDE ... WITH &&`), which SQLite cannot express
  and cannot meaningfully race-test (one writer per file makes the concurrency
  test measure the storage engine, not the code). Choosing the harder-to-set-up
  database was the correct engineering call, not the default one.
- **Local Postgres for every test run, zero exceptions.** `.env.test`
  overrides only the database URL and inherits everything else from
  `.env.local` — a deliberate first-file-wins `dotenv` layering, not an
  accident of config order.
- **One fixed port, in config, never on the command line.** `next dev -p 3300`
  is written into `package.json`, not passed as an env var — the failure mode
  it avoids (two projects silently testing against each other's dev server
  because Playwright adopted whatever was already listening on the shared
  default port) is a real incident from a sibling build in this series.

---

## A-002 — The time module (`packages/core/time`)

**What it is:** The single module in the codebase permitted to convert between
the two time axes, plus the branded types that make every other conversion a
compile error.

**The core idea, in one sentence:** a working-hours rule ("I work Tuesdays 9–5")
and an appointment ("Alice's cut, 09:00 on Mar 15") are *different kinds of
thing* — the first is wall-clock, the second is a point on the physical
timeline — and conflating them is the root cause of essentially every
scheduling bug.

**Why it's not boilerplate — talking points:**
- **The function signature encodes a mathematical fact most code gets wrong.**
  `resolve(day, time, zone)` does **not** return an instant. It returns
  `unique | gap | ambiguous`, because the local→instant map is neither
  injective nor total: on 2026-03-08 in America/Chicago, `02:30` names *no*
  instant; on 2026-11-01, `01:30` names *two*. Any function typed
  `(wallTime, zone) => Instant` is lying, and every call site is forced by the
  type system to decide what it does about the days when the clock isn't a
  bijection.
- **A real API-removal problem, solved from first principles.** The obvious
  way to detect ambiguity — Temporal's `getPossibleInstantsFor` — is gone in
  `temporal-polyfill` v1. The obvious fallback (compare the `earlier` and
  `later` disambiguation results) *silently doesn't work*: a gap and an
  ambiguity both yield two instants an offset apart, in the same order. The
  implemented discriminator is a round-trip — an ambiguous local time converts
  back to the time you asked for, a nonexistent one doesn't. Worth walking
  through in an interview because the wrong version passes a careless test.
- **Branded types make the sibling project's real production bug
  unrepresentable.** A prior build stored a calendar day in a Postgres `date`
  column; `date → JS Date → format in local zone` shifted it a day west, with
  ten passing tests. Here `CalendarDay` and `Instant` are structurally
  incompatible at compile time, and `@db.Date` is banned repo-wide — the fix
  is a type system, not a code review habit.
- **Enforced by lint, not by discipline.** `temporal-polyfill` is confined to
  this one directory by `no-restricted-imports` (the engine core is deliberately
  library-free integer arithmetic on epoch millis — DST-proof by construction);
  `new Date(string)`, `Date.parse`, `getHours/setHours`,
  `toISOString().slice(0,10)` and `getTimezoneOffset` are `no-restricted-syntax`
  errors repo-wide. After this item the codebase has **zero** `Date.parse` call
  sites and the ban has no exceptions.
- **Tests written before the implementation, against externally-verified
  values.** 29 tests, every expected UTC instant lifted verbatim from a spec
  document where they were verified by execution against the IANA tzdata —
  not re-derived by hand, which is how a test comes to agree with a wrong
  implementation. Includes the cases that break whole-hour assumptions:
  Lord Howe's **30-minute** DST shift and Kathmandu's **+05:45** offset.
- **Verified timezone-independent by execution**, not by assertion: the suite
  produces identical results under `TZ=UTC`, `TZ=Pacific/Kiritimati` (UTC+14),
  `TZ=America/Chicago` and `TZ=Asia/Kathmandu`.

---

<!-- Next entry: A-003 — data model & the exclusion constraint -->
