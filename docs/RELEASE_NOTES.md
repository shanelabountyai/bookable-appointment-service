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

## A-003 — The data model and the no-double-booking invariant

**What it is:** 22 tables, and one `EXCLUDE USING gist` constraint that makes
overlapping appointments *unrepresentable* rather than merely checked-for.

**Why it's not boilerplate — talking points:**
- **The correctness guarantee is in the database, not the application.** The
  headline requirement — "zero accidental double-bookings" — is enforced by a
  partial GiST exclusion constraint on `(providerId, tstzrange(blockedStart,
  blockedEnd, '[)'))`. Every code path is refused: the ORM, a migration, a
  script, a `psql` session at 2am. The tests prove this by writing with a raw
  Postgres client that knows nothing about the application's rules — an
  ORM-level test would only prove the ORM behaves.
- **`READ COMMITTED` with no retry loop, and that's a consequence, not a
  shortcut.** Because the constraint exists, two concurrent overlapping inserts
  resolve correctly without `SERIALIZABLE` and without the retry wrapper that
  `40001` would force. The alternative design (SELECT-then-INSERT) is textbook
  write skew and needs all of that machinery — machinery that, untested, is a
  liability of its own.
- **Half-open intervals, and why that's the single most important character.**
  The range is `'[)'`. With `'[]'`, back-to-back appointments abut at a shared
  endpoint and are rejected as conflicts — the salon could never book
  consecutive clients, which is most of a working day. There is an explicit
  test asserting back-to-back is *allowed*.
- **Six Postgres behaviours verified by execution rather than assumed**, because
  the spec flagged them as unverified and each one costs a day: generated
  columns are impossible here (`timestamptz + interval` is `STABLE`, not
  `IMMUTABLE`, and Postgres rejects the column outright); `EXTRACT(EPOCH ...)`
  *is* immutable so a whole-minute CHECK is legal; `btree_gist` is mandatory;
  and the append-only trigger surfaces `23001`, not the `2F004` I first guessed
  — the test caught that.
- **The ORM hides the error you most need to catch.** Prisma surfaces the
  exclusion violation as `PrismaClientUnknownRequestError` with **`code`
  undefined** — not `P2002` — with the SQLSTATE only inside the message string.
  The natural `e.code === 'P2002'` check silently falls through to a 500 while
  the race test still passes: the concurrency is correct and the user
  experience is broken. Verified and pinned with a test.
- **A structural fix for a real defect from a sibling build.** That project
  added a status to an enum and four separate readers silently kept the old
  list. Here every status list derives from one module, and a test reads the
  *live* constraint definition out of `pg_constraint` and asserts it still
  matches — so the SQL and the TypeScript cannot drift apart without going red.
- **Staff can override; customers still cannot collide.** A knowing staff
  double-book writes a zero-width range, which satisfies the constraint without
  weakening it, while the true intended range is preserved in a separate column
  for the day view and the availability engine. The constraint never lies, and
  a customer booking the overridden time is still refused — both asserted.

---

## A-008 — The slot engine

**What it is:** One pure function — `computeSlots(query) -> slots` — that answers
"when can this client book this service with this provider on this day?"
correctly on the two days a year when the clock is not a bijection.

**Why it's not boilerplate — talking points:**
- **It is a pure function, and that is a design decision with teeth.** No I/O, no
  clock, no ambient timezone: `now` is a parameter. That is what makes a
  daylight-saving bug reproducible in a unit test in June instead of being
  discovered by a customer in March.
- **Integer arithmetic on the physical axis, deliberately library-free.** Wall
  clock times are converted to instants exactly once, at the window edges, and
  everything after that — grid stepping, overlap tests, buffer maths — is
  integer epoch-millisecond comparison. The physical axis has no DST, so the
  hot loop is DST-proof by construction. A lint rule enforces that the Temporal
  library cannot be imported into the engine at all.
- **The subtlest bug in the codebase, and the test that catches it.** On
  spring-forward morning a provider's hours may be stored as two rows
  (01:00–02:00 and 03:00–04:00) because 02:00 does not exist. Those must union
  into ONE continuous three-hour window on the instant axis — if the code
  resolves the 02:00 close to the instant *before* the gap instead of after, it
  sees a phantom one-hour hole and silently refuses every appointment long
  enough to span it. The engine takes the later instant for both edges, and a
  mutation test proves the suite catches the alternative.
- **The doubled hour is treated as real capacity.** On fall-back day 01:00–01:59
  happens twice; naive implementations deduplicate by wall-clock label and
  silently delete an hour of bookable, revenue-generating time. Here both
  occurrences are offered as distinct slots carrying distinct offsets, and
  policy decides whether to show both — a business decision, made explicitly,
  rather than a default inherited from a date library.
- **Exclusions are explained, and that's a testing argument, not a UX one.**
  Almost every assertion about a scheduling engine is an assertion of absence,
  and `expect(slots).not.toContain('11:00')` passes if you typo the date, if the
  fixture has no hours, or if the engine threw and you swallowed it. The engine
  reports *why* each candidate was rejected, so tests assert
  `reasons == ['overlaps-buffer']` — which fails when the mechanism is wrong
  even though the outcome looks right. Explanations are suppressed on public
  routes, because "overlaps-booking" tells an anonymous visitor exactly when
  the provider is with a client.
- **58 engine tests: a hand-built edge matrix plus 21 property tests.** The
  properties assert the laws (a returned slot never overlaps a busy interval;
  adding a booking never *adds* availability; increasing duration never adds a
  slot) across thousands of generated queries weighted toward the transition
  days and a leap day.
- **The property tests were themselves validated two ways** — because a property
  test that silently generates empty results passes everything and proves
  nothing. First, generator sanity: 500 queries, 245 with non-empty results, up
  to 154 slots. Second, mutation testing: three deliberate bugs injected into
  the engine, all three caught.

---

<!-- Next entry: A-006 — service catalog -->
