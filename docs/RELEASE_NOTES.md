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

## A-004 — The notification seam

**What it is:** one path every outbound notification goes through —
`enqueueNotification()` decides and records, `dispatchPendingNotifications()`
sends — built before anything in the product actually needs to send a
message.

**Why it's not boilerplate — talking points:**
- **Built in the wrong order on purpose.** The confirmation email doesn't
  exist yet; this does. Building the seam first, rather than retrofitting it
  once three call sites have already hand-rolled their own sending, is a
  structural decision carried over from a defect in a sibling project.
- **A kill switch that is still honest while it's off.** Setting
  `NOTIFICATIONS_ENABLED=false` doesn't skip writing the outbox row — it
  writes the row and marks it suppressed, with a reason. "What would have
  gone out during the incident" stays answerable, which a switch that simply
  skips the write cannot do. Verified that flipping the switch mid-backlog
  halts everything already queued, not just future decisions.
- **A sandbox redirect that never contaminates the record.** Point
  `NOTIFICATIONS_SANDBOX_TO` at a test inbox and every send goes there — but
  the outbox row keeps the real, intended recipient. A staging environment
  can exercise the entire path against real-looking client data and still
  never reach an actual phone number.
- **Idempotency proven, not just implemented.** Two enqueue calls with the
  same dedupe key produce exactly one row — verified with a *second* call
  carrying a *different* payload, confirming the first decision wins outright
  rather than merely deduplicating on later fields.
- **A dual-timezone test run caught a real bug that had nothing to do with
  time.** Adding this item's database-backed test file made the *previous*
  item's test file fail too — under both `TZ=UTC` and `TZ=Pacific/Kiritimati`,
  with two different failure counts. It looked exactly like the class of bug
  this project's whole CI design exists to catch. It wasn't one: two test
  files sharing a local Postgres database, both truncating tables in
  parallel, produced a genuine Postgres deadlock. Diagnosed by isolating each
  file (both pass alone) before touching any code, then fixed at the config
  level so it can't recur for the next database test file either.

---

## A-005 — Staff session and the audit actor

**What it is:** password hashing, a signed session cookie, and a route guard —
built with the Node standard library and no auth dependency.

**Why it's not boilerplate — talking points:**
- **The scope decision is the interesting one.** A sibling project in this
  series runs NextAuth with full role-based access control. Here the recorded
  decision is deliberately "one shared credential, real session, actor stamped
  on every mutation — and multi-user roles are explicitly a later phase."
  Knowing which one a product needs *this month* is the judgment; building the
  larger thing by reflex is the common failure.
- **No auth library, and a reason rather than a preference.** Nothing a JWT
  library offers — algorithm negotiation, JWKS, third-party verification —
  applies when one server signs a cookie and the same server verifies it.
  What is used instead: HMAC-SHA256 from `node:crypto`, with the expiry
  *inside* the signature so it can't be extended by editing the cookie.
- **Password hashing done properly, in ~40 lines.** scrypt with a random
  per-password salt, constant-time comparison, OWASP-floor cost parameters,
  and a self-describing stored format (`scrypt$N$r$p$salt$hash`) so the cost
  can be raised later without invalidating existing hashes or locking anyone
  out.
- **The login form is not a user directory.** An unknown email and a wrong
  password return the same message *and take the same time* — the
  user-not-found branch verifies against a dummy hash specifically so it pays
  the same ~100ms of deliberate scrypt work. There's a test for it, asserted
  as a ratio rather than an absolute millisecond bound, because a tight timing
  assertion on shared CI hardware is a flake generator.
- **Session revocation with no revocation list.** The guard re-reads the staff
  row on every request instead of trusting the cookie's contents, so deleting
  a user invalidates their live sessions immediately — no denylist to keep,
  no TTL to wait out.
- **The security properties are asserted end-to-end, not assumed.** Playwright
  specs prove an anonymous visitor never renders the protected content (not
  merely has it hidden), that a *tampered* cookie is rejected rather than
  trusted, and that the real cookie carries `HttpOnly`, `SameSite=Lax` and
  `Secure` — the last one checked against a production build, because a
  regression to `secure: false` is invisible locally and ships the session
  cookie in clear text everywhere else.
- **What was deliberately left undone, and written down.** There is no rate
  limiter on login yet; scrypt's cost is the only brute-force control. That's
  defensible for one credential on a single-tenant v1 and indefensible if it
  goes unremarked, so it's recorded in the code and the log with the specific
  upgrade path — a later item already needs the same limiter for a different
  route, so it gets built once and shared.

---

## A-025 — Business & provider setup

**What it is:** owner-configurable business policy and the provider roster,
built around one specific trap the previous milestone's operator review
surfaced.

**Why it's not boilerplate — talking points:**
- **A real trap, closed by construction rather than by a form hint.** The
  product's cancellation-cutoff rule was specified as "startup validation" —
  but a later decision let each individual service override the cutoff, and
  startup validation cannot catch a pair created by editing either side after
  the fact. Set a service's cutoff longer than the business lead time — both
  individually reasonable settings — and a client can book a slot she is
  structurally unable to cancel, then get charged a late-cancellation fee she
  had no way to avoid, counted by the product's own no-show tracking. Fixed by
  making the invariant a shared pure function, called from both write paths,
  that names the offending service in the error.
- **Domain-accurate error messages, and a test that enforces it.** A duration
  formatter deliberately renders "24 hours" rather than "1 day" for a
  cancellation policy, because that's how the trade actually states one — and
  a test pins the exact wording so a refactor can't silently drift it back to
  the technically-correct-but-tone-deaf version.
- **A seed built to expose bugs, not hide them.** The setup seed gives one
  provider a split shift, gives everyone but one a midday break, and makes one
  provider unqualified for half the catalog — because a seed where every
  provider works identical hours and does every service makes entire
  categories of bug invisible to every screen built against it afterward.

---

## A-006 — Service catalog

**What it is:** service CRUD, per-provider duration/price overrides, and
deactivation that never deletes — with the confirmation gate proven against a
real row rather than assumed to work.

**Why it's not boilerplate — talking points:**
- **A gate tested against reality, not against its own class definition.**
  The rule "deactivating a service with future appointments requires
  confirmation" has no real bookings to test against yet — the booking write
  path doesn't exist. Rather than constructing the error object directly (which
  proves the class has a field, not that the gate fires), the test inserts a
  real appointment row straight into the database, bypassing the application
  entirely, and proves the actual function refuses and then yields under
  confirmation.
- **The same defect, caught for the third time, and fixed differently each
  time it escalated.** A CI failure that looks exactly like a timezone bug
  and isn't one had already happened twice this project (parallel unit-test
  files racing each other; sequential unit-test runs leaving pollution for the
  next). This time it was end-to-end tests: different browser specs mutating
  the same global rows with no per-test isolation. Rather than patch the
  symptom a third time, the fix generalized: every e2e spec now resets the
  database in a `beforeEach`, the same discipline the unit suite already had.
  The suite got noticeably faster as a direct consequence — proof the fix
  was addressing real waste, not just correctness.

---

## A-007 — The availability model

**What it is:** the precedence chain that decides when a provider is actually
available — weekly hours, per-date overrides, breaks, time off — resolved
against the business's own opening hours.

**Why it's not boilerplate — talking points:**
- **The whole chain is computed in wall-clock minutes, and that is the design
  decision.** A window is minutes-from-local-midnight (an overnight close of
  `02:00` is 1560, not 120), so the arithmetic never touches a timezone at all.
  "Dana works Tuesdays 9–5" is a claim about the wall clock that stays true
  whatever the offset does that week — resolving it to actual instants is one
  separate, already-tested step. Keeping those two apart is what makes the
  daylight-saving edge cases someone else's solved problem rather than this
  module's recurring bug.
- **"Closed" and "no override" are deliberately different states.** A day with
  an explicit closure and a day with no special rule both produce zero
  available hours, but they are not the same fact, and collapsing them is how a
  public holiday silently becomes an ordinary working day next year. The schema
  represents both and the resolver preserves the distinction.
- **An override replaces, never merges.** "Open 10–2 on Christmas Eve" means
  exactly 10–2 — not 10–2 plus the usual 9–5. Easy to get wrong, and the wrong
  version books clients into hours nobody agreed to work.
- **Availability is the intersection of business and provider hours, not the
  union.** The salon being open is a precondition for a stylist working, so one
  business holiday closes everyone's day regardless of their individual
  patterns — with an explicit test for exactly that.
- **Recording time off over existing appointments SUCCEEDS, on purpose.**
  "Dana called in sick" must never be refused because she has nine appointments
  booked; what happens to those nine is a decision for a person, surfaced as an
  impact preview. There is a test asserting the *absence* of a refusal — the
  requirement is that nothing is silently cancelled, so the non-refusal is
  tested as deliberately as any behaviour.
- **The tests were mutation-checked.** Three deliberate bugs injected into the
  precedence logic — intersection turned into union, override merging instead
  of replacing, and out-of-range breaks silently dropped — all three caught.

---

## A-026 — The availability adapter

**What it is:** the seam where the availability rules, the appointment rows and
the pure slot engine finally meet — and the single highest-risk query in the
project after the no-double-booking constraint itself.

**Why it's not boilerplate — talking points:**
- **One query with two independent ways to be silently wrong, both guarded and
  both mutation-tested.** First, it must be an *instant-overlap* predicate
  rather than a date filter: a booking starting 23:30 and running past midnight
  belongs to both days, and a date filter drops it from the second one, after
  which the engine cheerfully offers midnight to the next customer. Second, and
  subtler, it must read the override column — a staff double-book deliberately
  stores a **zero-width** time range so the database constraint stays absolute
  without refusing the override, which means a busy-set built the obvious way
  returns an interval occupying no time at all, and the public booking page
  then offers the exact slot staff knowingly overbooked.
- **The proof that the test proves anything.** The override test asserts the
  *fixture* first — that the row's own range really is empty and the override
  column really is populated — before asserting the query picks it up. Without
  that, the test would pass just as happily against a fixture that was written
  wrong, which is the most common way a test about an edge case ends up
  testing nothing.
- **Deliberately mutation-tested.** Two real bugs injected: dropping the
  override handling, and hand-typing a status list that forgets that
  "completed" and "no-show" appointments still occupy their time. Both caught.
- **The unsafe option is not the default.** One flag controls both whether the
  booking horizon applies and whether internal exclusion reasons are exposed —
  and it defaults to the *public*, restricted treatment. A route that forgets
  to set it gets the safe behaviour, rather than leaking "overlaps-booking" to
  an anonymous visitor, which would tell them precisely when a stylist is with
  a client.
- **The date picker runs the real engine, not an approximation.** Computing
  "which days have availability" a cheaper way produces a calendar that greys
  out days the booking page will happily sell, or offers days it then refuses —
  a class of bug users experience as the software being broken.

---

## A-009 — The booking write path

**What it is:** the transaction that turns a chosen slot into an appointment —
and the concurrency story that makes double-booking impossible rather than
unlikely.

**Why it's not boilerplate — talking points:**
- **Three defences, in a deliberate order.** A database exclusion constraint
  (absolute, enforced against every path including a `psql` session), an
  advisory lock scoped to one provider-day, and an engine re-run inside the
  transaction. The lock is explicitly *not* the correctness mechanism — it
  exists to close the one gap the constraint deliberately does not cover,
  because a staff override stores a zero-width range so the constraint won't
  refuse it, which means only the re-check defends that time.
- **The race tests script interleavings rather than sampling them.** Two real
  database connections, explicit happens-before edges, no `setTimeout` and no
  polling — including one that proves a blocked transaction *fails* when the
  winner commits, and one that proves it *succeeds* when the winner rolls
  back. That second case is the difference between a system where an
  abandoned checkout frees the slot and one where it kills it forever.
- **Mutation testing found two real bugs by NOT failing.** Deliberately
  breaking the code and watching the tests still pass is the only way to learn
  that a behaviour is asserted nowhere. It surfaced that the advisory lock
  bucketed by *UTC* day rather than business day — so two bookings on the same
  evening either side of UTC midnight were never serialized, exactly the case
  the lock existed for — and that the write path read the system clock, making
  it untestable against a fixed date.
- **Reaching unreachable code, honestly.** Once the lock works, the
  constraint-violation path becomes unreachable through the normal flow, which
  makes its error mapping untestable. Rather than delete the mapping or assert
  it by inspection, there is a deliberately ugly, clearly-named test seam that
  skips serialization — because untested defence-in-depth is just an untested
  branch, and the requirement was explicitly to provoke a *real* constraint
  violation and prove it becomes a clean "that time has just been taken"
  rather than a 500.
- **The confirmation is enqueued inside the booking transaction.** A booking
  can never commit without its confirmation, nor a confirmation without its
  booking — and a walk-in with no phone number on file still books
  successfully, with the notification recorded as suppressed rather than the
  booking failing.

---

## A-028 — Multi-service visits

**What it is:** "cut then colour" as one appointment rather than two — which is
half the sample salon's Saturday, and which the database actively refuses to
model the obvious way.

**Why it's not boilerplate — talking points:**
- **The interesting rule is a subtraction, not an addition.** Durations sum,
  but the buffers between services do *not* stack. A buffer protects the gap
  between two clients — tidying the chair, washing the bowl. Inside one visit
  the client never leaves, so the second service's "10 minutes before" is time
  the stylist is already standing there with her. Stacking them would quietly
  add half an hour of dead time to every combination booking, and the salon
  would just notice its day stopped fitting.
- **It required no change to the scheduling engine at all.** Because a
  composed visit is simply a longer service with one buffer at each end, the
  whole feature lands as a composition function plus a plural field — which is
  the payoff for having shaped the data model plurally from the start, before
  anything needed it.
- **Order is part of the meaning.** Since the buffers come from the two ends,
  "cut then colour" and "colour then cut" produce genuinely different blocked
  ranges. That means caller order has to survive the round trip through the
  database, where the obvious query returns rows in storage order and would
  silently reorder someone's appointment. There is a test for it.
- **The old field was replaced, not supplemented.** Adding an optional
  "additional services" list beside the existing single one would have been the
  smaller diff and the worse design — two ways to express one thing is the kind
  of flexibility that quietly rots. Changing the canonical shape made the
  compiler enumerate every call site, which is exactly what should happen.

---

## A-011 — The density seed

**What it is:** a deterministic, realistic book — 225 appointments across four
stylists with deliberately different workloads — built so every screen that
comes next is developed against a real salon week rather than an empty
calendar.

**Why it's not boilerplate — talking points:**
- **The seed books through the real booking code, not raw inserts.** That makes
  it slower and much more useful: every seeded appointment is one a user could
  actually have made, and the seed doubles as an integration test that the
  booking path, the availability rules, the scheduling engine and the database
  constraint all agree with each other.
- **It is anchored to fixed dates, never "today".** A seed anchored to the
  current date would make the daylight-saving test fixtures exist in March and
  silently vanish in July, with nothing failing to say so.
- **It found a trap one level deeper than that.** Both DST days fall on
  Sundays, and the salon's seeded hours are Tuesday to Saturday — so the two
  days this entire project exists to get right would have contained *zero*
  appointments, invisibly. The seed now opens them explicitly, and a test
  asserts they are populated.
- **Writing the tests found three genuine bugs in the seed**, each of which
  would have quietly degraded the demo: picking services a stylist isn't
  qualified for, sizing "40% booked" off the number of offered start times
  (which overlap, so it filled every column solid and destroyed the whole point
  of having different densities), and a database query with no explicit
  ordering that broke reproducibility — because a seeded random generator is
  only deterministic if everything it indexes into is ordered too.
- **One of the failures turned out to be the test's fault, and that was worth
  proving rather than assuming.** The determinism check was comparing
  database-generated ids, which are random by design. Diffing the two runs
  showed the data sets were identical and only the ids differed — so the seed
  had been correct the whole time, and the test was asserting something that
  can never be true.

---

## Customer booking — five screens, and the browser never touches a date

The public booking flow: pick a service, pick a stylist, pick a day, pick a
time, leave a name and a phone number. Two text fields, no account, no page
reloads, and it works entirely from the keyboard with a screen reader
announcing the times as they change (checked by axe on all five screens).

- **Every date is formatted on the server, in the salon's timezone.** The
  browser is sent "Tuesday 9 June" already written out, never a raw date to
  interpret. The first draft had the browser working out weekdays itself — the
  arithmetic was right, but it is the wrong place for it: the customer's
  timezone is not the salon's, so a visitor in Auckland would have been offered
  a day the salon hadn't reached yet.
- **The day list starts from the salon's today, not the visitor's.** The same
  point, from the other direction, and the reason the window is decided by the
  server rather than passed up from the page.
- **A phone number alone doesn't identify a customer.** The name has to match
  too. Households share a number, and matching on the number alone would mean a
  mother booking for her daughter silently inherits her mother's record — notes,
  history, no-show count and all.
- **The confirmation carries the exact moment, never a date-and-time pair.** On
  the night the clocks go back, "01:30" happens twice; a form that posts back
  "01:30" is a coin flip between two real appointments.

**The bug worth reading about.** All seven tests failed against a database that
visibly had services in it. The cause: the page had no changing input, so the
framework rendered it *once when the site was built* and served the service
list as frozen HTML. In production that means a salon adds a service and never
sees it appear — and retires one and keeps selling it until the next deploy.
It cannot be reproduced on a development server, which rebuilds every request;
it only shows up because this project's end-to-end suite deliberately runs
against a real production build. That convention paid for itself here.

---

## The milestone checkpoint that found the bug no test could

At the end of each milestone the whole flow gets walked end to end, against
real seeded data, before anything moves on. It is a scheduled habit, not a
reaction to something looking wrong — the previous build in this series found
four defects that way, every one of them inside work already marked complete.

This one found a good bug, and it is worth understanding *why* it was
invisible.

Every notification the system had ever recorded — 228 of them — was **orphaned
from the appointment it was about**. The database column linking them existed,
was indexed, and had a foreign key protecting it. Nothing ever wrote it.

Three separate pieces of work touched that link, and **every one of them was
correct on its own**: one added the column, one built the notification recorder
(which was never given the field to store), and one recorded the booking
confirmation, putting the appointment's id inside the message payload. That
last detail is what made it invisible — the id genuinely was in the row, in
plain sight, in every test output. It just wasn't the kind of value you can
look anything up by. The screen that will ask "was this customer actually
told?" would have been built against a query that always returns nothing.

No test was wrong. The assertion that would have caught it didn't belong to any
of the three items — it belonged to the seam between them, which is exactly
what a checkpoint walks and what nothing else does.

**A second finding, in the fix for the first.** The regression test written to
lock the bug down included one assertion that passed *with the fix removed* — a
different safeguard was blocking the operation first, so the test could never
have failed for the reason it claimed. It was deleted rather than kept. A true
assertion that cannot fail is worse than no test, because it reads like
coverage.

**And one thing deliberately left unfixed.** A rare test failure recurred during
this work and was finally pinned to a specific test — but 23 consecutive clean
runs later, the cause is still unknown. Rather than ship a plausible-sounding
fix, the test now prints exactly what it received when it fails. Every failure
of that kind previously arrived looking identical, which is why two separate
investigations produced nothing. The next one will produce a diagnosis instead.

---

## The appointment lifecycle, and testing a table against the document

Eight states — booked, confirmed, checked in, in progress, completed, no-show,
cancelled, and cancelled-late — with a written table saying exactly who may
move an appointment where, and when. Every one of the 64 possible moves is
tested.

**The test transcribes the spec rather than reading the code.** The table in
the test file is written out as text, so it can be diffed by eye against the
product document it came from. This matters more than it sounds: a test that
loops over the implementation's own table proves only that the table is
consistent with itself. It would confirm a *wrong* table just as cheerfully.

Some decisions in it that came from thinking about a real salon:

- **Nothing marks an appointment as a no-show automatically.** A stylist
  running forty minutes behind would otherwise watch the system cancel her
  afternoon. The "system" actor exists and is deliberately given no power here,
  with a test to make adding that power a conscious decision.
- **A customer cancelling too late isn't blocked — it's reclassified.**
  Refusing outright just produces a no-show instead, which is worse for the
  salon and destroys the very data that separating "cancelled" from "cancelled
  late" exists to capture.
- **On the exact cutoff boundary, the salon wins.** Being told your
  cancellation counts as late is fixable with a phone call; the reverse quietly
  costs a chargeable slot.
- **A correction can erase a timestamp but never invent one.** Marking a
  no-show as "actually she was here" happens up to a week later, so recording
  *now* as when the appointment ended would be a made-up measurement that later
  turns up averaged into a utilisation report. It records nothing instead, and
  says why.
- **Completed and no-show appointments still occupy their time.** Only the two
  cancellation states release it. Getting this backwards would put a gap in the
  day view where a client was actually sitting.

**Two people at the front desk.** Both tapping "check in" on the same client is
an ordinary Saturday. The update is conditional on the status it was decided
against, so the database itself picks the winner and the loser gets told who
got there first — rather than both succeeding and writing two contradictory
entries in the history.

**A guard added for a bug that hasn't happened yet.** Adding a ninth state to
the database without adding it to the code would previously have left several
derived lists silently ignorant of a value that real rows could hold — the
exact defect that bit an earlier project in this series. The live database enum
is now asserted against the code's list on every run.

**Verified by deliberately breaking it.** Five sabotages — opening a forbidden
move, removing a precondition, shifting a deadline by one millisecond, giving
customers a staff-only power, flipping a boundary — and all five were caught.

---

## The link in the text message

Every confirmation carries a link that opens that one appointment. No login, no
password, no account — which is exactly why the interesting decisions here are
all about what the link *cannot* do.

**It stays usable, deliberately.** The obvious design is a link that burns on
first use. It was considered and rejected: confirming and then cancelling two
days later, or rescheduling twice, is the *ordinary* thing customers do, so a
single-use link fails on step two of almost every appointment — and the salon
answers the phone instead. Single-use is right where a link starts a session
(a staff password reset); it is wrong where a link *is* the session. The
controls that replace it are scope, expiry, revocation and a rate limit.

**It is a lookup, not a message.** The staff session cookie is a signed payload
that anyone holding it can read. That shape is unusable for a customer link,
because the URL is a customer surface and no internal identifier is allowed to
reach one. This link is 256 random bits: it contains nothing, it is looked up.

**The database stores a hash, never the link.** Deliberately a fast hash rather
than the slow one used for the staff password — the slow one exists to make a
*guessable* secret expensive to guess, and random 256-bit values are not
guessable. Paying that cost on every tap of a link from a text message would
buy nothing. The hash is there so a stolen database is not a folder of live
links.

**Expired, revoked, and never-existed all give the same sentence.** Anything
that told the difference would confirm to a script that one of its guesses had
named a real appointment.

**Sending a new link kills the old one.** A phone number corrected at the front
desk means the message that went to the wrong number stops working.

**Expiry is 24 physical hours after the appointment ends** — not "the next day
at the same time". Tested across both clock changes: 24 hours after a 4pm
Saturday appointment is 5pm on the wall in March and 3pm in November. The
calendar-day version of this passes every test written in any month except two.

**The rate limit is in the database, not in memory.** The deploy target runs
many instances, so an in-memory counter would enforce N times the configured
limit, with N decided by autoscaling — a limiter that lies about the number it
enforces is worse than none, because it gets trusted. It is also a single SQL
statement rather than a read followed by a write, for the same reason the
booking path leans on a database constraint: two simultaneous requests must not
both read 9 and both write 10. A test fires twelve at once and asserts none is
lost.

**The limit lives on the gate, not on the page** — so it cannot be walked
around by skipping the page and posting the action directly — and it is spent
*before* the link is looked up, so a guessing loop pays for its guesses.

**Cancelling never re-decides the cutoff.** The page asks to cancel; the
appointment lifecycle's own refusal is what reclassifies it as a late
cancellation. A second copy of that rule on a customer screen is exactly the
kind of duplicated status logic that quietly diverges.

**A test reads the rendered page, not the code.** It asserts that this
customer's appointment id, client id, provider id and business id appear
nowhere in the HTML, along with the internal status values and table names — a
component can be perfect while a layout, an error boundary or a stray attribute
puts an identifier in the markup. The cancel button sends the link back rather
than an appointment id, so there is nothing in the page to lift.

**And a flaw caught in a test before it could become a "flaky" one.** The first
version asserted a success message that lives inside the form the page removes
when it refreshes — a race against a re-render that would have failed once a
month and been blamed on the browser. It asserts the refreshed page instead,
which is what the customer actually sees.

---

## Moving an appointment without ever losing it

Rescheduling is one row, updated once, inside one transaction. The obvious
alternative — cancel the old appointment, book a new one — has four failure
modes and one of them cannot be recovered from: the cancellation commits, the
new time is taken in the meantime by somebody else, and the customer now has no
appointment at all while her original slot has been given away. It is also the
most common complaint about home-grown reschedule flows, which is why the
design note says so in the file that would otherwise be "simplified" into it.

The nuance worth stating exactly: cancel-then-insert is perfectly fine *inside
a single transaction*. The distinction is not what statements you use, it is
one transaction versus two.

**The bug that only appears when you actually try to move something.** The
database is happy to move an appointment from 09:00 to 09:30 — its no-overlap
rule compares the appointment against *other* appointments, not against its own
previous position. The availability engine is not: re-run inside the same
transaction, it sees the appointment sitting at 09:00 and refuses 09:30 as
"that overlaps a booking" — the booking being itself. Without a fix, an
appointment could never be moved anywhere within its own length of where it
already is, which is the single most common reschedule a salon does: "can we
push it half an hour?" The engine is now told to ignore the appointment being
moved, and the test that proves it is the one that fails when that is removed.

**Two taps, one appointment, two different times.** The update is conditional
on the time the decision was made against, so the second one loses cleanly and
is told the appointment has already been moved — rather than both succeeding
and leaving a history that contradicts the appointment it describes. The same
reflex as the database constraint: never check first and then write as the
safety mechanism.

**Moving it does not re-sell it.** The appointment keeps the duration it was
booked with, even if the salon changed that service last week. And the screen
that offers new times and the code that accepts one now go through a single
function, so the list can never offer a time the server then refuses.

**The link survives.** The customer's original confirmation message keeps
working through the reschedule — it is re-pointed, not reissued — which matters
because that link is what she opens next to cancel. A design that created a new
appointment row would kill it at exactly that moment.

**The cutoff applies to the customer here too.** A reschedule inside the
cancellation window is refused for the customer and allowed for staff, because
a reschedule is a cancellation with extra steps: without that rule a customer
inside the cutoff simply moves the appointment to next month and abandons it,
and the salon has lost the slot with none of the record a late cancellation
leaves. The page asks the same question the server does — with the real
deadline — so it never shows a form that would then say "call us".

**Verified by deliberately breaking it.** Four sabotages — letting the
appointment block itself, dropping the conditional update, never moving the
link's expiry, using today's service duration instead of the booked one — and
each was caught by exactly one test.

---

## The client record, and why a phone number is not an identity

A salon's client list is keyed on a phone number, and the phone number is
deliberately **not unique**. A household shares one. Making it unique would
silently merge a mother and her teenage daughter into a single client — one set
of allergy notes, one shared no-show counter, so the daughter's two misses
block the mother from booking online. Unwinding that after the records have run
together is data repair, not a migration.

So every lookup here returns a **list**, and nothing in the code ever decides
that two records are the same person. It only carries out that decision when a
human makes it.

**A merged-away record is never deleted.** It stays as a tombstone pointing at
the survivor, keeping its old phone number — because the moment that number
matters most is six weeks after the merge, when she rings from it. The screen
says so plainly ("found through an old number that was merged into this
record") rather than quietly showing a different name than the one the front
desk expected.

**Merge chains are flattened, not followed.** Merging B into C also re-points
everything that was already pointing at B, so looking up any old number is
always exactly one hop — no recursive query, no possibility of a loop, and no
depth limit to get wrong later.

**Notes are combined, never replaced.** This is the one failure in this feature
that could hurt somebody: a merge that dropped the losing record's note because
the survivor already had one would silently delete "allergic to PPD". Contact
details work the other way — they fill in gaps only, because overwriting the
survivor's number with the duplicate's would undo the decision staff just made.

**The history shows the no-shows.** Hiding them would make the front desk look
unprepared when the client who missed twice rings to book a third time, and it
is the same data the no-show counter reads — two sources eventually disagree
about the same appointment.

**"Rebook last visit" uses her rhythm, not the calendar's.** It reads the gap
between her last two kept visits — six weeks between colours is a fact about
her hair — and opens the day list there instead of at tomorrow. Six weeks is
six weeks regardless of what the clocks did in between; measured in
milliseconds it comes out as 41 days and 23 hours, which rounds down and drifts
the suggestion a day earlier every spring.

**A test of mine that was quietly proving nothing.** The check that "rebook
ignores cancelled appointments" had put the cancelled visit *earlier* than the
kept one — so sorting by date picked the right answer whether the rule existed
or not. Deleting the rule left the test green. It now puts the cancelled visit
last, where it actually bites. Three other deliberate sabotages were caught
first time.

---

## One screen for the whole day

Every stylist's day side by side: a column each, working hours shaded, breaks
and time off drawn in, and every appointment as a chip carrying the client's
name, phone, service and — marked, not merely present — the pinned note that
might say what she is allergic to.

**The riskiest part of building this was the temptation to redraw it.** The
booking engine already knows how to turn "we open at nine" into a moment in
physical time, and the rules are not guessable from outside: a working hour
that does not exist on the spring-forward morning resolves to the instant
*after* the gap, an hour that happens twice resolves outward at both ends, and
windows are merged only *after* that conversion. A grid that worked any of that
out for itself would eventually draw a window the engine refuses to sell from,
and neither screen would look wrong on its own. So the conversion moved out of
the engine into a shared module and both call it — all 205 engine tests passed
unchanged, which is what makes it a move rather than a rewrite.

**A fork found and deleted on the way past.** Two places in the codebase
already answered "what hours does this provider work today". They agreed, for
now. One is gone.

**A gap is not a slot.** A slot is "somewhere this 45-minute service fits, on
the grid, with buffers". A gap is "nobody is in this chair between 2:15 and
3:00" — which is the question the front desk is actually asked all day, and it
has no service in it yet. Lunch breaks are taken out too: offering them would
send someone to interrupt a stylist eating.

**The screen is never more than 30 seconds behind the book**, because the desk
is not the only thing writing to it — the other terminal, a customer's phone, a
stylist's own screen. It re-reads every 15 seconds by re-running the same code
that drew it the first time, so there is no second way of building the grid to
drift from the first.

**No clock in the browser.** Every time on screen is formatted server-side in
the salon's timezone; what reaches the browser is a distance from the top of
the grid and some text. A laptop still set to the timezone of somebody's
holiday shows the same day as the terminal beside it.

**Colour is never the only signal.** Every chip's accessible name is a full
sentence including the status, cancellations are struck through as well as
faded, and the colour map is exhaustive over the eight statuses — a ninth one
would fail the build rather than render an invisible chip on a Saturday.

**And an accessibility defect caught before it shipped.** The hour labels down
the side and the gap text were light grey at 12px: 2.6:1 against white where
the standard requires 4.5:1. It looked perfectly readable on this screen. The
automated check in the test suite disagreed, and it was right — small grey text
is exactly where contrast quietly fails. The measured numbers are now written
next to the constant, so nobody lightens it back.

---

## Booking from the desk, including the bookings a system is supposed to refuse

The front desk can now book from the day grid: tap a gap, pick the services,
find the client by any part of her name or number — or book her with no record
at all, because "walk-in, no name" is a real appointment and identity attaches
later.

**The lead time turned out to be the wrong shape.** The salon requires two
hours' notice, which exists to stop a customer booking a slot five minutes out
and finding herself instantly unable to cancel it. Applied to staff, the same
rule made the headline walk-in feature impossible: the front desk could not
book the person standing in front of them. It is now a self-serve rule, like
the booking horizon already was. The alternative — routing every walk-in
through the override path — would have made the override marker meaningless,
which is the thing that makes it worth having.

**A refusal is a step, not a wall.** This is the operator's hardest-won point:
every scheduling platform he abandoned died of a flat refusal. So when the
engine says no, it says *why* in the words the desk uses — "she already has a
client then", "it runs into another appointment's buffer" — with the override
box beside it. Typing a reason is the whole ceremony, and it is what makes the
marker on that appointment mean something to whoever asks next week.

**And the one case that got this wrong.** Booking *outside working hours* is
the first override the requirements name, and it was the only one with no way
past. The reason is subtle: the engine explains the times it *considered*, and
a time outside every working window is never considered at all — so it came
back with no explanation, and the screen only offered the override when there
was an explanation to show. The most important override was the one you
couldn't reach. Caught by the end-to-end test, fixed by making the override
available on any refusal.

**A hole in the type checker, found the hard way.** A database query filtered
on a relation by the wrong name. It should have been a compile error, and it
wasn't, because the filter was spread in from a conditional — which widens the
object and stops the compiler checking what is inside it. It reached the
browser as a server error instead. Rewritten as a plain conditional so both
branches are checked. Worth remembering as a rule: a conditional spread into a
typed query object is a blind spot.

**Two smaller judgements worth stating.** "Starting now" means *as soon as
possible*, not this exact minute — booking off the salon's own grid would
either flag an ordinary walk-in as an override or leave a four-minute sliver
nobody can sell. And the walk-in returns a *list* of who could take her,
because "Priya at 2:15 or Dana at 3:00" is a choice made out loud with the
client standing there.

---

## The thing a paper day-sheet does that software usually cannot

At 11:05 Dana is forty minutes behind. Her 10:00 client is still in the chair,
and the website is cheerfully selling her 11:15 to somebody else. That was the
headline finding of an operator review of this project: the system could record
that an appointment *ran* late, but not that the day *is* late. The desk's
answer to that gap is a sticky note — a shadow calendar, which is what kills a
scheduling product by week two.

So "running late" is now a first-class, stored value: one number per stylist
per day, with the name of whoever said it. The availability engine consumes it
as an interval covering the next forty minutes of her column, and the reason it
gives back is *provider-running-late* rather than a flat "unavailable" — so the
day view can say "Dana is behind" instead of implying she has gone home.

**It deliberately does not move anything.** Rewriting the appointment times
would change the time on the confirmation the client is already holding, and
would destroy the answer to "she was booked for 2 and seen at 2:40". The
projected start appears *beside* the scheduled one, never instead of it.

**Pushing the column is the other half, and it is a different mechanism on
purpose.** When it is not coming back — Dana is an hour down and the afternoon
has to move — "push from here" shifts everything still to come, in one
transaction, and tells every client whose time changed. That is the action that
*does* rewrite the times, and it is audited with a reason.

**Why it needs a database feature most projects never touch.** Shifting three
back-to-back appointments moves the first onto the second's old slot
mid-transaction. The no-overlap rule refuses that — correctly, in isolation.
Every ordering fails somewhere, and "just order the statements correctly" is a
rule the next person will not know. So the check is deferred to the moment the
transaction commits: the intermediate states are allowed and the final state is
still absolutely enforced. It is scoped to that one transaction, so nothing
else in the system quietly gains the same latitude — and removing that single
line breaks the test that proves it, which is how we know it is load-bearing
rather than decoration.

**All or nothing.** If any appointment would end up past closing time, the
whole push is refused and the preview names the client who is stuck. A column
that half-moved is worse than one that did not move at all.

---

## The morning somebody calls in sick

Nine clients are booked with Dana and she is not coming in. This is the moment
a scheduling product is judged, and the requirement is absolute: **nothing is
silently cancelled, moved, or hidden.**

Recording the sick day always succeeds — the database deliberately does not
refuse it, because "Dana is ill" is a fact, and what happens to her nine
clients is a decision for a person. That decision now has a screen: every
stranded appointment, with the client's name and a tappable phone number,
because the resolution to most of these is a call and a list you have to click
nine times to use is a list the front desk copies onto paper.

**A conflict is worked out, never stored.** It is a fact about *other* rows —
an absence, an edited window — so a saved `hasConflict` flag would go stale and
lie on precisely the day this screen matters. What *is* saved is the human
acknowledgment: "rang her, she's coming anyway". That is the one thing not
derivable from anything else, and it is what stops the second person in on
Saturday morning re-ringing three clients somebody already sorted.

**And that acknowledgment expires when the situation does.** If the absence
changes — she is off for the week now, or she is coming in after all — the flag
is cleared, because it was an answer to a question that no longer exists.
Clearing lives in the one place absences are written, so no future code path
can forget it. It is scoped to the overlapping times, so an afternoon absence
does not wipe a decision somebody made about the morning.

**Reassigning keeps the appointment.** Handing a client to Priya changes the
stylist and nothing else — same id, same time, same working manage link, so the
client may not need telling at all. Whether Priya is actually free is decided
by the database's no-overlap rule rather than by a check in the code, which is
what makes a bulk reassignment incapable of half-succeeding into a
double-booking.

**Bulk actions report what they could *not* do.** Nine appointments, three
moved, six that could not — a message that only counted the successes would
leave six clients quietly unhandled, which is the exact failure this feature
exists to prevent. Each move is independent, too: one awkward 2pm does not roll
back the eight that worked.

**Cancelling needs a reason; keeping does not.** Taking a client's appointment
away is the one action here that requires a sentence somebody can read back to
her on the phone.

---

## One appointment, and every question anyone asks about it

Four separate requirements pointed at a screen that nothing had built: the
history in plain language, the client's pinned note on every render, the
override marker with its reason, and "was she actually told?". They now share
one page.

**The history reads as sentences.** A row saying `status_changed
{"from":"booked","to":"no_show"}` is a database record. "Changed from booked to
a no-show by the front desk" is an answer to the question somebody is actually
asking six weeks later, when a client insists she was never marked absent. The
translation is exhaustive over every kind of event the system writes, enforced
by the compiler — a ninth kind fails the build rather than showing a raw
database value to whoever is on the phone.

**The buttons come from the rules, not from the screen.** Which status changes
are offered is decided by the same transition table the write path consults,
asked with this user and this clock. So marking a no-show before the
appointment has even started is not a disabled button — it is not there,
because the table says that move does not exist yet. Nothing on this page
decides what is legal; it only asks.

**And it says who got there first.** The page sends back the status it was
showing, so when two people at the desk tap different buttons, the second gets
"somebody else got there first — it is checked in now" rather than silently
overwriting a colleague's decision.

**Three mistakes worth recording, all in the tests rather than the app.** A
dynamically-imported workspace package broke under the test runner's module
handling. A test helper returned a promise from inside a `try/finally`, so it
disconnected the database while a transaction was still open — which surfaced
as "Response from the Engine was empty" and reads exactly like a database
fault rather than a harness one. And an assertion matched the override reason
in two places at once, because it genuinely appears twice and both are wanted.
The notes are written next to the fixes; the second one is the kind of thing
that costs an afternoon if you go looking in the wrong layer.

---

## A-020 — the no-show lever

**The counters are derived, every time.** There is no `noShowCount` column to
go stale. Correcting a mis-tapped no-show back to "completed" un-blocks the
client on the next page load, and a miss from thirteen months ago stops
counting on its own — there is no forgiveness job to run, and therefore none
to forget to run.

**A rolling twelve months is a calendar year, not 365 days.** Counting days
puts the boundary a day out either side of a leap year, so the same
appointment falls in or out of the count depending on which February you ask
in. The comparison is against the appointment's business-zone calendar day,
not its instant: an 8pm appointment on the last day of the window is inside it
in the salon's calendar and outside it in UTC, and the salon's calendar is the
one the client is arguing about at the desk.

**A threshold of zero means the lever is off.** The obvious `count >=
threshold` blocks every client in the salon the moment an owner turns the
number down to nothing — including everyone who has never missed anything —
and it presents as a website outage rather than as a setting. One guard, one
test, and the mutant that removes it dies.

**The block lives at the write path, not on the form.** The customer flow, a
hand-crafted POST and any future API client all go through the one function
that knows the rule. `audience: 'public'` is the whole of it; the front desk is
already the unrestricted caller, so the staff bypass needed no new flag to
build and no new flag to get wrong.

**What it costs the desk to book her anyway: one tap.** The flag is on the
client picker at the moment of the decision, and the booking records that it
happened over a flag — so the owner's report can find those bookings without
anybody having typed a justification into a field that would be full of full
stops by Friday.

**And the flag stops at the client record.** Blocking by phone number would
have been simpler and would have blocked a mother because her daughter, who
shares the number, missed three appointments. The households in this data are
the reason the phone number is not unique in the first place.

---

## The confirm loop

**Confirming is one function, asked twice.** A customer tapping "I'll be there" on her manage link and a staff member tapping "Confirm" on the appointment screen go through the exact same transition table, the same `booked → confirmed` edge, just with a different actor. There is no separate customer-confirm code path to drift out of sync with the staff one — the table has always permitted both, since the state machine was built.

**"No reply never auto-cancels" is provable, not just promised.** The transition table has no `system` actor anywhere in it. That is not an omission to remember to avoid — it is the whole mechanism: nothing in this codebase has the authority to move an appointment on its own, so there is no code path left that could someday grow a silent auto-cancel by accident.

**The call-down list is derived, like everything else that matters here.** "Who hasn't confirmed for tomorrow" is not a stored flag — it is `status = 'booked'` on tomorrow's business-zone day, recomputed on every page load. The moment somebody confirms, by either the phone or the website, the row is simply gone; nothing has to clear it.

---

## The reminder job

**The link in the reminder is a new one, on purpose.** The system never stores a manage link's raw token — only a one-way hash of it — so nothing running a day later can hand a customer back the exact link she was sent at booking time. The reminder mints a fresh one and the old one stops working, which sounds like a bug until you notice it is the same rule already governing what happens when the salon re-sends a confirmation to a corrected phone number: the newest message is the one that's live.

**"24 hours before" means 24 real hours, not "yesterday at the same time."** On the one morning a year the clocks skip forward, those two definitions disagree by an hour, and the difference is invisible unless a test is written specifically to look at it in the salon's own timezone. This one is.

**Nothing decides to skip a rescheduled appointment — there's nothing to decide.** A reschedule moves the same database row to a new time; the reminder job just asks "what's starting in the next few minutes' window, 24 hours out" and a moved appointment simply isn't there anymore at its old time. The correctness came from the reschedule feature keeping one row, not from the reminder job knowing anything special about rescheduling.

---

## The waitlist

**A cancellation is perishable inventory, and this is the recovery mechanism.** The moment a front-desk person cancels an appointment, a link appears right there on the screen: "who wants this slot?" It's the same salon-owner instinct as a restaurant working a reservation list — a slot that opens is worth ten seconds of looking before it just sits empty until whoever calls next happens to want exactly that time.

**The matching is honest about what it actually checks.** It isn't a second booking engine running quietly in the background — it's a duration-and-buffer arithmetic check against the exact window that just opened, plus whether the day and time of day are ones the waiting client said would work. That's a deliberately smaller promise than "here's every slot this week that would work for her," and the smaller promise is the one this feature can keep without drifting out of sync with the real booking rules the moment either one changes.

**Every provider-and-service pair a client will accept for a wait, in one search field.** "Any Saturday morning, Dana or Priya" is a real sentence an owner used to describe how this actually gets asked for, and it types into the form almost verbatim — a date range, a couple of checkboxes for which stylists are acceptable, and which parts of which days. No new client-lookup was written for it; it's the same phone-and-name search the booking screen and the client-merge tool already use, because a salon has exactly one way its front desk finds a person, not three slightly different ones.
