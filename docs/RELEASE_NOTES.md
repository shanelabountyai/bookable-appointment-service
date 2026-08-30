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

---

## The owner dashboard

**The utilization formula was frozen before a line of code existed, and the number it produces here was earned, not typed in.** "Booked minutes over available minutes" sounds simple until someone asks what counts as available — does a lunch break? A stylist's day off? The fifteen minutes on either side of a haircut that exist so the chair doesn't get double-booked? Every one of those questions was answered in writing months before this screen, and the one number a reviewer can actually check against isn't a plausible-looking round figure someone typed into a spec — it's whatever a real, reproducible dataset actually produces when the formula runs against it, pinned as the test's own expected value.

**A tile that only shows a number is a number nobody trusts by the second week.** Every count on this screen — bookings, cancellations, no-shows — is a link, and clicking it lands on the actual list of appointments behind it. An owner who sees "3 late cancellations this week" and wants to know who can find out in one click, not by asking the front desk to go look it up.

**Reschedules don't quietly inflate the cancellation rate, and nobody had to remember to exclude them.** A rescheduled appointment is the same database row, moved — so when the dashboard counts what got cancelled this week, a client who simply moved her Tuesday to Thursday was never in that count to begin with. The correctness comes from how reschedule was modeled months earlier, not from a rule bolted on here.

---

## Segmented durations

**A colour is not two hours of work — it's fifty minutes, forty minutes of chemistry, and thirty minutes more.** The service catalogue can now say so, and the day grid draws the middle stretch hatched, labelled with how many minutes are genuinely free. That's forty minutes per colour the front desk can see and use, on a screen that previously showed a solid two-hour block.

**The gap never scales, and that's the detail the feature lives or dies on.** A quicker colourist gets a shorter application and a shorter finish — she does not get faster chemistry. A provider's duration override re-times only the parts she is actually working, proportionally, with the rounding remainder landing where it keeps the total exact. An override too short to leave room for the developing time is refused at the moment it's typed, saying how many minutes will never shorten, rather than producing an appointment whose parts silently don't fit.

**The database still defends the whole slot, deliberately, and a test exists to make sure the next person knows why.** The exclusion constraint ranges over one time range per appointment, and a range cannot express a hole — so offering the gap as a bookable slot is a migration of the single most load-bearing invariant in the system, not a rendering change. That work is scoped, sized, and blocked on a written decision about what the constraint's unit becomes. Until then the gap is visible and staff book it through the override path that already exists, and a constraint test asserts the old behaviour on purpose: it is designed to fail the day the migration lands, so nobody can change that invariant without reading the decision first.

**Nothing needed backfilling.** A service with no parts has exactly one implicit part — its whole duration — so every service in the system was already correct on the day the feature shipped, and the migration is a single dropped index.

---

## Booking into a colour's processing time

**A stylist mixing colour is busy for fifty minutes, free for forty, then busy again — and the salon can now sell those forty minutes.** The scheduling engine offers them as ordinary slots, the front desk books them like any other, and the colour does not move. On a four-chair salon with two colourists that is real recovered revenue from time the software previously threw away.

**This required changing the invariant the whole system is built on, and it got stricter rather than looser.** Double-booking is prevented by a database exclusion constraint, not by application checks — but a constraint over one time range per appointment cannot express a hole. So the unit became the *worked span*: an appointment now writes one row per stretch the provider is genuinely occupied, and the same constraint ranges over those. A booking that lands inside the gap is accepted; one that spills a single minute into the second half of the colour is still refused by the database, in the same transaction, with the same error the booking path already knew how to translate.

**The rows are written by a database trigger, never by application code.** That was a deliberate constraint on the design: if a write path could forget to record a block, it would under-block and double-book, and the constraint would have no way to know. Because the trigger owns them, every existing path — booking, reschedule, the running-late column push, bulk reassignment — kept working untouched, and all nine concurrency tests passed against the new shape without modification.

**The pure scheduling engine was not modified at all.** A segmented appointment simply presents as two busy intervals instead of one. The engine that was built and property-tested against a DST edge-case matrix never learned what a segment is — which is the payoff for having kept it a pure function of its inputs.

**One finding worth naming: a gap that doesn't line up with the booking grid is a gap nobody can sell.** A failing end-to-end test caught it — the demo colour's parts left its free window starting at a time the 15-minute grid never offers, so the feature was visible and useless. The sample data was corrected. Visible free time and *sellable* free time are not the same thing, and only one of them is worth building.

---

## The room is now something the software can count

**Shipping gap-booking created a problem, and this closes it.** Once a client can sit developing colour while her stylist works on somebody else, a four-chair salon with four stylists can want eight chairs — and until this landed, every one of those bookings was accepted. The system would cheerfully put more people in the room than the room holds. The scoping pass for this feature is what caught it, from a test that was already passing.

**Chairs are real, and nobody ever picks one.** The owner names them once at setup. Booking assigns the first free chair automatically; the front desk types nothing and chooses nothing. A chair only ever reaches a human when there isn't one — which is exactly the moment they need to know.

**"No more than four at once" is the thing a database cannot enforce, so it wasn't built that way.** An exclusion constraint answers overlap questions, not counting questions — a capacity number could only have been implemented as read-the-count-then-write, which two simultaneous bookings defeat, and which is the precise pattern this system refuses to rely on for double-booking. Naming four chairs converts one counting question into four overlap questions, and those the database answers absolutely — against the application, against a script, against someone typing SQL directly. A test proves that last one by bypassing the application entirely and being refused.

**Staff can still override, and it costs a chair nothing.** An override holds no chair at all, deliberately, on the same principle as every other override in the system: the constraint exists to prevent accidents, never to refuse a human a decision they're making knowingly. "We'll do her at the backwash" stays a valid answer.

---

## The full room stops being a surprise at the checkout screen

**The previous feature made the room countable; this one makes it visible before somebody commits.** Chair capacity was enforced by the database from the moment it shipped — correctly, absolutely, and *at the last possible second*. A customer picked a time the page had just offered her, pressed the button, and the booking was refused because every chair was taken. The stylist was free; the room was not; and nothing on the way in had said so.

**A "how many are left?" question was turned into a "when is it full?" answer, so a pure function could stay pure.** The scheduling engine takes busy intervals and nothing else — it has no concept of a chair, and teaching it one would have meant giving it a counting problem and a database. Instead the adapter sweeps the chair holds once and emits the spans where the count of concurrent holds reaches the number of chairs. Those go in as ordinary busy intervals, and the engine subtracts them exactly the way it subtracts a lunch break. The engine's code changed by one line: a new interval kind reports a new reason.

**The reason it reports is the point.** "She already has a client then" is *false* when the stylist is idle and the room is full, and a screen that explains itself wrongly is one staff stop reading. So a full room is its own reason with its own words — the desk is told the room is full, is offered the override that exists precisely for it, and the customer is told only that the time has gone, with the times that remain. Which chairs are occupied and how full the salon is are facts about the business, and they stay inside it.

**The refusal path stayed, and that is deliberate.** Two people booking the last chair at the same moment will still see one of them refused by the database, because the check that filters the list and the constraint that guarantees the chair are — and must be — different mechanisms. What changed is that the refusal is now the rare race it was designed to be, instead of the ordinary Saturday experience.

**And it no longer crashes.** Before this, the full-room refusal escaped the customer's booking action entirely and rendered an error page. That was a live defect on the revenue path, found by an operational review rather than by a test, which is its own lesson: the write path was right and nobody had walked the screen.

---

## The most common phone call in the salon had no button

**"Can you push my three o'clock to four?" — and the front desk had no way to do it.** The reschedule machinery had been built and tested fifteen items earlier: one transaction, one row updated, the appointment keeping its identity so the client's existing link keeps working. It had exactly one caller, and it was the *customer's* self-service link. Nobody at the desk could reach it.

**The workaround was worse than an inconvenience — it falsified the record.** Cancel-and-rebook is the only other way to move an appointment, and a cancellation that close to the appointment is correctly classified as a late cancellation. So every one of those calls put a black mark on a client who had done nothing wrong: on her record, on four staff screens, and in the owner's cancellation report. A busy Saturday would have manufactured a cancellation problem the business did not have. The regression test asserts the absence directly — after a staff move, the count of cancellations is zero.

**Nothing was rebuilt. The gap was a missing caller.** Four separate features each deferred this screen to the next one, and each deferral was individually reasonable — the write path had nowhere to live, then the grid had nowhere to send it, then the detail panel ran out of room. It took an operational review, from the perspective of someone running a front desk rather than reading a backlog, to notice that the circle had closed with nothing inside it.

**Two things were deliberately NOT built, and that is the more interesting decision.** The write path documents, in its own header, that changing an appointment's stylist and overriding the engine are both out of scope, each with a stated reason. Both would be useful here. Both were left closed and written up as an open question instead — because a decision about a write path that six other paths depend on is not one to take while building a screen, and this project has twice paid for answering that kind of question up front. The write-up includes the finding that motivates it: the sick-stylist case genuinely cannot be assembled from the two existing operations, because each fails on an intermediate state while the destination stands free the whole time.

---

## A decision that survived contact, and a lock that did not

**The feature is small: the front desk can now move an appointment to a different stylist and a different time in one action.** It matters because the case that motivates it cannot be assembled from the two operations that already existed. "Dana's off sick — put her client with Priya at two instead of three" fails as a stylist change, because Priya has her own three o'clock. It fails as a time change, because Dana is off at two. Each attempt is refused by an intermediate state, while the destination — Priya at two — stands free the entire time.

**The interesting part is what happened to the plan.** The decision was recorded before the work started, with an explicit argument for why this move needed only one lock: the appointment vacates one stylist's calendar and occupies another's, so only the destination can gain a conflict. That argument is sound, and it is about the wrong mechanism. A Postgres exclusion constraint does not reject an overlapping row belonging to an uncommitted transaction — it *waits* for that transaction to finish. So two people performing the two halves of a swap each wait for the other's old booking to disappear. That is a deadlock, and its error code is not the one the booking path knows how to translate into "somebody just took it" — it would have reached the front desk as a server error, intermittently, under exactly the pressure that produces swaps.

**Re-deriving the claim before writing the code is what caught it, and the fix was three lines.** Sort the two keys, take them in order. The same reasoning revealed that the identical deadlock had been reachable for months on a much more ordinary operation — two appointments swapping days with the same stylist — because only one of the two days was ever locked. Nobody had hit it. It was there.

**It is tested as a property, not as a race.** Both halves of a swap must produce the same lock order; that is asserted directly and deterministically. The alternative — run the swap concurrently and see whether it deadlocks — would pass on a broken build most of the time, which is the definition of a test that costs more than it gives.

---

## The chair did not follow the client, and the ordinary case proved it

**The first thing written for this feature was a test designed to fail, and it did — on the most routine action in the salon.** One stylist, two clients back to back, the front desk saying "we're running half an hour behind, push everything." Both clients are legitimately assigned the same chair, because one finishes exactly as the other begins. Shifting the pair put the first client on top of the second's chair, and the database refused it *in the middle of the write*, as a raw error, on an operation the preview screen had just promised would work. No unusual room, no concurrency, nothing contrived.

**The cause was two independent mistakes that each looked harmless.** Moving an appointment carried its chair along unchanged — reasonable, until you notice the chair she is sitting in is not necessarily free an hour later. And the constraint protecting chairs had never been added to the one place in the system that deliberately relaxes constraints for the duration of a transaction, even though it was built with exactly that capability, for exactly that reason, by the feature immediately before it. Either mistake alone still breaks. That is the shape of defect that survives review: two correct-looking decisions in two different files.

**One of the three named write paths turned out to need no change at all, and proving that was the work.** Reassigning a client to a different stylist moves the stylist and nothing else — same time, same chair, same room. Re-choosing a chair there would have churned a client into a different seat for no reason. So instead of code, that path got a test that pins the reason it is safe, and which will fail the day somebody makes a reassignment move the time.

**The chair is chosen by the preview, not by the action.** This system has a standing rule that a preview must run the identical check the action executes, so the screen can never promise something the write then refuses. Choosing a chair halfway through the writes would break that twice over: it could not be shown in advance, and finding no chair available mid-operation leaves nothing to do but abandon the whole push. Now the preview names the client who has nowhere to sit, before anything moves.

**Two kinds of "cannot move" turned out to feed each other.** A client with no free chair stays where she is — and a client who stays where she is blocks anyone who would have been shifted onto her time, who may in turn block someone else. The two conditions are resolved together until they settle, rather than one after the other. The test for it pulls a column an *earlier* hour: a chair shortage at one o'clock strands a three o'clock appointment for an entirely different reason, in the same result.

**Keeping people in the chairs they are already in is a feature, not a nicety.** The obvious implementation re-seats the entire column from scratch, which walks clients between chairs for no reason and can exhaust a full room that the previous seating fitted perfectly. Preferring the current chair means the ordinary half-hour delay changes no seating at all.

---

## The most frequent action in the salon finally has a button

**Checking a client in cost four interactions and two page loads.** Read the day, open the appointment, press the button, navigate back — for the thing a front desk does more often than anything else. The day screen showed "Checked in" as a word with nothing behind it. No revenue attaches to this, which is exactly why it kept being deferred, and it is the gap where paper comes back out.

**The feature is one button; the work was making sure two screens can never disagree about what it offers.** The appointment detail panel already computed which status changes are legal right now — asking a single transition table with the real staff member and the real clock. Putting buttons on the day meant a second screen asking the same question, and a second screen answering it *for itself* is precisely the defect that bit an earlier project in this series: two surfaces confidently agreeing with each other and quietly disagreeing with the write path. So the computation became one function that both screens ask, and neither holds an opinion of its own.

**What appears on a chip is decided by asking the table a slightly different question — not by a second list.** The chip has no box to type a reason in, so it asks "what is allowed *with no reason given*?" That single change is what keeps the two changes that genuinely require an explanation — a client walking out mid-service, and correcting a record after the fact — on the detail panel where the explanation can be typed. Nothing hardcodes which buttons belong where.

**The button is always the next step, never a fixed one.** A booked client offers "Check in"; once she is checked in the same chip offers "Start"; once she is in the chair, "Finish". A hardcoded "Check in" would look right in a demo and be wrong five minutes later.

**Two things were deliberately kept off the chip, for reasons worth stating.** Cancelling is perfectly legal from a chip and takes no reason — which is the problem: a mis-tap on a phone would end someone's appointment with no record of why. And confirming belongs to the call-down, a different errand done at a different time of day; a fifth button costs the four that matter. Both exclusions are written down where the code makes them.

**A chip is as tall as the appointment is long, so the room for a button is arithmetic, not taste.** The shortest seeded service is a ten-minute fringe trim. The chip counts the lines it has already spent — a client's name, a pinned allergy note, a running-late projection — and shows the button only if what is left will hold it, because a *clipped* button is worse than an absent one: invisible to the eye and still reachable by keyboard. Where it does not fit, the chip is a link to the panel that has everything, which is where every one of these actions was yesterday.

## Three clients moved to a different stylist, and nobody told them

**The product's rule is that nothing is silently cancelled, moved or hidden — and two write paths were breaking it.** Booking a client, rescheduling her, and pushing a running-late column all put a message in the outbox. Bulk reassignment and staff cancellation did not. Those are the exact two things that happen on the morning a stylist calls in sick, to nine people at once. The system was at its most silent precisely when it had the most to say.

**The fix went one level deeper than the ticket.** The gap was reported against the conflicts screen — the "Dana is off sick, here are her nine clients" list. But the conflicts screen is one of four places a member of staff can cancel an appointment; the detail panel and the day view can too. So the notice was attached to the single function that writes an appointment's status at all, which every one of those screens already goes through. Fixing only the screen that was reported would have left the other three silent, which is the same defect wearing a different hat.

**The message is written in the same database transaction as the change itself.** A move that the database refuses — because the destination stylist turns out to be busy — must not leave behind a text telling a client she has been moved. Equally, a cancellation that commits must not be able to lose its notification. Two of the tests exist only to make those writes *fail*, and assert that nothing was queued.

**Which statuses count as "a cancellation" is derived, not typed out.** This codebase keeps every list that reads appointment status in one module, because an earlier project in this series added a state to the enum and left four readers quietly working from the old list. So the notice fires on whatever that module calls slot-freeing — meaning a ninth status added next year cannot become a new way to cancel someone silently.

**A late cancellation gets a message too, and that took a deliberate decision.** The system distinguishes an ordinary cancellation from one inside the notice period, because the two mean different things for the client's record. It is tempting to treat the late one as needing no message. But the split is about who wears the cost, not about who gets told — and when the salon is the one cancelling late, that is the message the client most needs.

**Staff can silence it, and the box starts unticked.** Plenty of front desks phone first, and a text arriving afterwards contradicts the person the client just spoke to. The alternative — an opt-in "and text her" tick — was considered and rejected: an unticked opt-in box is exactly the silent cancellation the rule forbids, and it will be unticked on the busiest, most distracted morning the salon has. Default-on means the worst case is a redundant text after a phone call, rather than a client arriving to a salon that is not expecting her.

**And the list now shows what each client has already heard from you.** Working down nine names on the phone, "she got a text about this an hour ago" changes what the next call says. It reads from the same indexed link between a message and its appointment that answers "was she actually told?" on the appointment screen — asked here from the other direction.

## Four people, one login, and an audit log that said "the front desk"

**Every change an appointment has ever recorded was stamped with the same anonymous actor.** The system had been carrying the staff member's id on every single mutation since the fifth item in the backlog — it simply had no name to resolve it to, and no screen that tried. So the history read "Changed to checked in by the front desk" whether that was the owner, the Saturday temp, or whoever was nearest the terminal. The product's own rule is that "who moved this appointment and when" always has an answer, and it did not.

**The interesting question was not how to name people. It was where to put the PIN.** Three shapes were on the table. Give each person their own email and password: strongest, least code, and completely ineffective — signing out and back in all day is exactly *why* four people share one login, so it ships and nobody uses it. Replace the password with a PIN: fastest, one concept, and it puts a four-digit secret on a publicly reachable form with no rate limiter, which is the salon's entire appointment book behind ten thousand guesses. The shape that was built keeps the sign-in boundary exactly as strong as it is today and makes only the *switching* cheap: the terminal authenticates once in the morning with a real credential, and a name plus four digits then decides whose name goes on the next thing that happens. The PIN is not holding the door; it is deciding who is standing inside it.

**A staff identity is not necessarily an account, and that turned out to be a schema change.** A stylist who needs her name on a check-in does not need a way to sign in from home. Issuing her a credential anyway to satisfy a not-null column is a credential somebody has to rotate later, so email and password became optional — and the login path matches on email, which means such a row can never sign in at all. Two tests come at that from both directions.

**Removing somebody deactivates them; it never deletes them.** This one is forced by the feature's own purpose. The stamp on each event is a bare id with no foreign key behind it, so deleting a departed employee's row would silently strip their name from every event they ever recorded — the exact answer this work exists to preserve, destroyed by the off-boarding step. Deactivating instead ends their live sessions on the very next request, with no revocation list to maintain, and leaves the history intact. A test checks specifically that somebody who has left is still named on the check-in they did last month.

**Who is currently at the desk travels inside the signed session, and switching does not extend it.** An identity a browser could edit would let anyone put anyone else's name on anything, which would be worse than the anonymous log it replaces. And taking the desk is not signing in, so it must not quietly buy another eight hours of session. Both a forged identity and a malformed one are tested.

**The switcher lives in a layout, so it is on every staff screen rather than fifteen copies of itself.** It is only useful where the person already is. And every failure gives one identical message — wrong PIN, unknown person, somebody with no PIN set — because a switcher that distinguishes them is a way to find out who works here, on a screen anyone leaning on the counter can read.

**Names, not roles.** No permissions matrix arrived with this. Everyone can still do everything they could do yesterday; the only thing that changed is that the record knows which of them did it.

## Forty-two taps to book "same again in six weeks"

**The highest-conversion moment in a service business is a client at the register, and the software could not reach it.** Rebooking someone six weeks out — the most ordinary thing a front desk does all day — required tapping "next day" forty-two times, because the day view's navigation was Previous, Today, and Next and nothing else. A stylist's own booking screen inherited the same limit: it could show the times offered for one day, and the only way to see a different day was to start over from the calendar. An operator review that walks the product the way a real desk would use it is what surfaced this — every write path underneath already accepted an arbitrary date; nothing above it offered a way to type one in.

**The fix is not a calendar picker.** It is a plain date field, because the desk is not browsing — someone on the phone has already said "next Tuesday" or "same time in six weeks," and a date box turns that sentence directly into a jump, in one gesture, with no extra database queries to render a month grid nobody asked to see.

**The booking screen got its own copy rather than reusing the grid's, and that distinction mattered.** A date field that only lived on the day view would still force a trip back to the calendar mid-booking. Putting one inside the booking panel itself meant the panel's day became something the screen could change on its own — which broke an assumption one line of existing code was quietly relying on: a gap tapped on the grid was being used to preselect the closest offered time regardless of which day the panel eventually settled on. Once the day is a moving target, an instant from a different day is not a hint anymore, it is a bug — the preselection now only applies on the day it was actually tapped on.

**A client's own history stopped being read-only.** Her upcoming and past visits used to render as plain text — visible, but with nowhere for a click to land. Splitting the two apart and linking every row means the desk can go from "when does she come back in" directly to moving that appointment, without first walking the calendar to the date printed on the screen.

**This is the second of two operator reviews in a row that found the same shape of gap** — a mechanism the backlog had already paid for, with no door into it from the screen a real desk uses. The fix, both times, was cheaper than it looked: neither the day view, the booking write path, nor the client record needed new logic underneath. They needed one honest way in.

## The button said "Cut + Colour" and booked a cut

**One character was the whole bug: an index.** The client's record showed "Cut + Colour with Dana — she comes about every 42 days," and the Rebook button beneath it carried only the *first* service into the booking flow. So a three-hour colour appointment was booked as a forty-five-minute cut, and nothing anywhere said so. The stylist finds out when the client sits down. That is two hours of a Saturday sold for nothing, plus a client turned away at the chair.

**The data had been right the whole time.** The function behind that card already returned every service, in order — the link simply took `[0]` and dropped the rest. Bugs that read as a typo are the ones worth being careful about, because the fix is trivial and finding the *rest* of what the same line broke is not.

**Three more defects came free with where the button pointed, and none is visible from the button.** It sent staff into the *customer's* booking flow. That meant the appointment engine ran under public rules on the screen the front desk uses most: the minimum-notice window that staff are deliberately exempt from, and the ninety-day limit on how far ahead a customer may book, both silently reapplied. It meant the client record the desk was already looking at got thrown away and re-matched by name and phone — so typing "Jen" where the record says "Jennifer" creates a *second* client, splitting her visit history, her allergy note and her missed-appointment count across two records that no longer know about each other. And it meant a client with too many missed appointments, standing at the counter with her card out, was told to please ring the salon — by the salon.

**The fix changed no booking logic at all.** The staff booking path already did every one of those four things correctly: it takes an ordered list of services, it books under staff rules, it accepts a client by identity, and it shows a missed-appointment flag as a warning rather than a wall. Nothing underneath needed rewriting. The button was pointed at the right door, and the screen it lands on learned to accept what the button brings. This is the second time in two work items that a real gap turned out to be a capability the system already had and no way to reach it.

**The one thing a rebook deliberately does not carry is the time.** "Same again in six weeks" names a day; it never names a time. The screen arrives with the right stylist, the right services in the right order, the right client and the right date, with that day's available times already listed — and no time chosen, so the desk picks one. Defaulting to the first free slot of the morning would have been the same class of mistake as the one being fixed: a confident, invisible, wrong answer.

**A service that can no longer be booked is announced, not quietly dropped.** If a stylist is no longer qualified for something the client had last time, or the salon retired it, the prefill leaves it out — and says so above the form. Silently selecting a shorter visit is precisely the failure this work exists to remove; reintroducing it one layer down would have been a poor trade.

## A resignation used to grey out a row and tell nobody

**The preview screen already existed. Nothing called it.** A stylist hands in her notice, the owner clicks Deactivate, and the row goes grey — that was the entire behavior. The function that lists every appointment she is still booked for — client, phone, date, service — had been sitting in the codebase since an earlier milestone, built for exactly this moment, wired to nothing. One grep confirmed it: the function's own definition was its only reference anywhere in the app.

**The fix mirrors a pattern this codebase already trusted for a smaller case.** Deactivating a *service* with future bookings already asked for confirmation before an earlier piece of work. Deactivating a *provider* is the same shape of decision, at a much higher cost — a service has a handful of bookings; a stylist can have forty. So the same two-step confirm now guards both, except the provider version shows the actual list of who is affected rather than a bare count. "Forty appointments" and "forty appointments, with names and phone numbers" call for different afternoons.

**A quieter version of the same gap was sitting one screen over.** Recording time off or an ad-hoc block was never meant to be blocked by what it collides with — a stylist calling in sick has to go on record immediately, full stop, no exceptions, and that rule stayed exactly as strict as it was. What changed is what comes back afterward. The screen has said, in its own explanatory text, that "which appointments it strands is shown for a person to resolve" since the day it was built. Nothing had ever computed that number. It now does, with a direct link to the list of people to call.

**The two fixes are not the same shape, deliberately.** A stylist's active/inactive status is a real switch with an obvious moment to pause at before flipping it — so that one gates. An absence has no such moment; the whole point is that it cannot wait on anyone's confirmation. Building both as confirmation gates would have made an urgent write wait on a click. Building both as after-the-fact summaries would have let a resignation's forty appointments slip through with only a passive notice nobody had to read. Matching the shape to the moment, instead of a generic rule, is doing the actual thinking a "just be consistent" instinct would have skipped.

## The escape hatch nobody could reach

**The hardest-won rule in this product is that software must never flatly refuse a salon owner.** A stylist agrees to stay late; two clients genuinely can be squeezed into one hour because one is under the dryer. Every system the operator abandoned died of a screen that said no with no way past. So the double-book you *mean* is a first-class feature here: it records who authorised it and why, it writes an appointment that occupies no time so the database's no-overlap guarantee is never weakened, and the day view still draws the true collision so nobody is surprised at 2pm. All of it built, all of it tested.

**None of it was reachable.** The booking screen could only ever be pointed at a time the scheduling engine had *offered* — and the one link in the entire product that carried a specific time was a "gap" chip on the day grid, which by definition points at time that is already free. Booking over something requires naming a time that is taken, and there was no way to name one. The override appeared only after a refusal the front desk had no way to cause.

**The test suite was the evidence, and the reason it went unnoticed.** A passing test proved the override worked end to end — by typing a URL into the browser directly. It was a URL the application has never generated anywhere. Green the whole time, and testing a door that exists only in the test.

**The fix is that the screen stops hiding the times it cannot sell.** The engine has always returned the rejected times along with a reason for each one, on staff screens only — that detail matters, since "she already has a client at ten" tells an anonymous visitor exactly where a stylist is at ten. The desk simply never saw them. Now a stylist's day lists every time on the grid: the free ones as buttons, the taken ones dimmed and annotated — "10:00 — she already has a client", "10:30 — it runs into another appointment's buffer" — and every one of them still tappable. Tapping a taken one is what produces the refusal, in the salon's words, with the override and its reason box beside it. The list is the door, and the reason next to each time is what makes the tap a decision rather than a fumble.

**A time after closing needed a different answer, because it does not exist on any list.** The grid is built out of the stylist's working hours, so six in the evening on a day that shuts at five is not a rejected time — it is not a time at all. That case gets a plain time field. What it deliberately does *not* get is a time the browser turns into a real moment: this application never lets a wall-clock reading and an actual instant be converted anywhere but in one audited module on the server, because a browser in a different timezone silently produces a different appointment. The desk types "18:00"; the server answers with the instant. On the night the clocks go back that answer is *two* instants an hour apart, and the screen offers both — "first time round" and "second time round" — rather than picking one and being wrong for half the year. On the morning they go forward and 02:30 does not exist, it says so instead of quietly booking 03:30.

**One wrong sentence was fixed on the way past.** When a time was refused because it collided with something, the screen always said "she already has a client" — true when a real booking was in the way, and wrong when it was a buffer, a block, or time off. That was survivable while the only way to hit it was losing a race. It stops being survivable the moment the desk is choosing occupied times on purpose, which is what this work makes possible. A screen that explains itself wrongly is worse than one that says nothing, because staff stop reading it.

**Three items in a row have now found the same shape of gap:** a capability the product genuinely had, fully built and correct underneath, with no honest way in from the screen someone actually uses. The fix each time cost far less than the original feature — and would have cost nothing at all if the test had been written to walk in through the front door.

## A cancelled appointment that nobody found out about

**A client cancels next Thursday's colour on a Saturday, through her own link. The salon is not told, and no screen shows the hole.** The day view draws it only on Thursday, and there is no reason for anyone to open Thursday until Thursday. Three hours of the most expensive service on the menu go unsold for six days — while the client who has been waiting for exactly that appointment sits on the waitlist, one screen away.

**The matching was already built, and it was good.** Given a freed slot, the system finds everyone on the waitlist who wants that service, with that stylist, on a day in their range, in a part of the day they said they could do, and it checks the service actually fits the gap that opened. All of it correct, all of it tested.

**It had one door, and the door needed a key nobody had.** The only way in was a link on the cancelled appointment's own page. So finding out who wants the slot required already knowing which appointment had been cancelled — which is the single fact the front desk does not have on Saturday morning. The feature answered a question nobody was in a position to ask.

**The fix is a list, and most of the work went into what is NOT on it.** Freed time that has already passed is gone. A cancellation from two months ago is not news. A slot somebody has since re-booked is not open. Neither is one the stylist has since taken as time off — that belongs to a different screen, and a product where two screens disagree about the same Thursday is a product staff stop believing. What is left is ordered by how soon it expires, not by how recently it was cancelled: a Thursday 2pm dies on Thursday at 2 whether the news is an hour old or a week old, and the row at the top is the one worth a phone call right now.

**Nothing is stored, which is the point.** "This slot is open" stops being true the instant someone books it. A stored flag would need clearing code in every booking path, every reschedule, every override — and the first path anyone forgot would leave the desk ringing round for a slot that had already gone. The list is recomputed on every read from facts that are already true.

**The re-used check was the deliberate choice.** Asking "is this time still empty?" already has one correct implementation in this codebase — the one that understands intentional double-bookings and the gaps inside a colour service. Writing a faster, cleverer query here would have saved a round trip and risked offering the desk a slot that a stylist had knowingly given to someone else. The list runs the existing check once per candidate instead, and the bounds above keep that to a handful.

**Four items running, the same shape of gap each time:** a capability the product genuinely had — built, correct, tested — with no honest way in from the screen a person actually uses.

## The signature that anyone at the counter could forge

**The appointment history says "by Priya" — and until now, Priya was the one person who could make it say "by Dana".** Naming who did what was the point of the previous work on staff identity: four people share one terminal, so "the front desk changed this" was a shrug rather than an answer. The names went in. The roster screen that hands out the desk PINs went in with them, reachable by anybody, which meant the credential the whole trail rests on could be reissued in about thirty seconds by exactly the person with a reason to.

**The fix is a guard on one thing, not a permissions system.** Every staff member can still do everything they could do before — book, move, cancel, add somebody to the roster, take somebody off it. One action now requires the account the terminal actually signed in with: setting or clearing a desk PIN. That is not an administrative privilege, it is the key to an identity, and a signature anyone can mint is not a signature.

**Hiding the field would not have been the fix, and the test is built to prove it.** The roster is opened by the owner, so the PIN box is really there on the screen. The desk is then handed to someone else in a second tab — the same browser, the same terminal, which is what sharing a machine means — and the form the owner left open is submitted. The refusal happens when the values arrive at the server, not when the page decides what to draw. A screen that only hides an input protects nothing from anyone willing to use the form that is already in front of them.

**And the test proves the PIN is unchanged by trying to use it.** Checking that the stored value "isn't 9999" is the kind of assertion that passes in precisely the case it was written to catch — a successful change to 9999 also isn't the literal string. So the test attempts to take the desk with the PIN the attack tried to install, and requires that to be refused.

**The second half: the desk now comes back on its own.** Whoever tapped in stayed named all day, including after they had gone home — which is when their name on an action stops being true. It lapses after half an hour and falls back to the account holder. Never to a logged-out terminal: throwing the front desk at a sign-in page mid-Saturday would be a worse bug than the one being fixed. The window is short on purpose, because the two ways of getting it wrong are not equal — a name that expires too early costs the history some detail, while one that expires too late puts somebody else's name on what you did.

**There is deliberately no "hand the desk back" button.** A one-tap way to become the account holder would undo the guard in a tap. The fast way back is for the owner to give themselves a PIN like everyone else, and the screen now says so.

**One sentence of copy, for the same reason as all of the above.** A column on the conflicts screen said "Told: Cancellation — sent". No message service is connected yet; a send writes a line to the server log. Staff read "sent" as "she knows, no need to call" — so the screen now says **queued**, and the label says "Notice" rather than "Told". A system that overstates what it did is worse than one that says nothing, because the front desk stops making the call.

## Four chairs the salon owned and never used

**The third milestone walk found a feature that was switched off.** Not broken — off. The salon's chairs had been modelled for four items: a pool of them, a rule that a stylist and a developing client need two, a chair that follows an appointment when it moves to another day or another stylist, and a database constraint whose only job is to stop two clients being put in the same one. All of it written, all of it tested, all of it passing.

**On a freshly installed system, not one service asked for a chair.** Zero of eight. So no appointment ever took one, the constraint spent its life guarding an empty table, and the room could never be full because nothing was ever in it.

**The cause was four lines above where they should have been.** The setup routine created the chairs, then said "every service happens in a chair", then created the services. On an empty database that middle instruction applied to nothing.

**Why two full test suites missed it is the part worth telling.** Setup routines are written to be safe to re-run, and this one was: the second time through, the services already exist and the rule lands correctly. Measured directly — after one run, none of the eight services required a chair; after a second, all eight did. Every browser test in the project sets itself up on top of an already-prepared database, so every one of them was seeing the second run. Every unit test built its own data by hand and set the requirement itself, correctly, because it was testing the chairs rather than the setup. The only arrangement nobody ever created is the one a real installation begins in.

**The suite wasn't failing to look. The way it prepares its data is what hid the problem.** That's a more uncomfortable finding than a bug, and a more useful one.

**The fix is one statement moved. The test is one sentence rewritten.** It asserts the requirement after a *single* run on a clean database — the only phrasing that catches this — and it names the services that fail rather than counting them, because "none of them" and "all of them" both pass a check that counts against itself. Confirmed by putting the bug back: the new test goes red, the other fourteen stay green.

**And with the chairs finally live, the thing they were built for happened for the first time.** A colour at nine o'clock, forty minutes of which the client spends developing while her stylist is free. A blow-dry sold into that gap at 09:45. Two clients, one stylist, one moment — and two different chairs, because the developing client is still sitting in hers. That is the exact scenario the constraint was written to protect, and until this walk it had never once occurred outside a hand-built test.

**Two of the walk's first three findings were the walk's own mistakes.** It checked that an appointment's blocked time started no earlier than its new start — forgetting that blocked time deliberately starts earlier, to hold the preparation buffer. A checkpoint is only worth running if its findings are believed, and a false alarm costs more than a missed one, so the assertion now compares how far things moved rather than where they landed. Prove the assertion before reporting the defect.

## Asking the database what the seed forgot

**The previous entry ended on an uncomfortable question.** A feature had sat switched off in every real installation because one instruction ran before the data it applied to existed, and it healed itself the second time anything ran. The obvious follow-up: *what else is only true the second time?*

**That question can be inspected, or it can be measured.** Inspecting means reading the setup code and reasoning about ordering — which is exactly what had already been done, four separate times, by people writing features on top of it. So instead: run the setup twice on a clean database with nothing cleared in between, and compare every column of every row of every table. An instruction that depends on data created later in the same pass cannot survive that comparison. The two runs disagree, and the comparison names the table.

**It found two things, and neither was the predicted one.**

The main setup routine came back byte-identical across both runs — genuinely repeatable, across twenty-five tables. The routine that fills the demo book with appointments did not: run twice, it wrote eleven more appointments and then crashed partway through, leaving a book that was neither the first run's nor the second's. Anyone who ran the demo-data command twice on their own database got that, silently, until the crash.

**The fix there was to stop pretending.** Making it repeatable means making it count what is still free rather than what it wants to book, and re-walking appointments that have already been completed — real machinery for a situation with no legitimate caller, since every real one starts from an empty book. It now refuses up front and names the command to run instead. The test checks that nothing was written before it refused, because a guard that refuses *after* writing passes a naive test perfectly and prevents nothing.

**The third finding was a file that did nothing.** A setup script left over from an earlier arrangement, referenced by no configuration and imported by nothing. Deleted.

**But the most useful outcome is a correction to the previous walk's explanation.** It had recorded that the browser tests all prepare themselves on top of an already-prepared database, and had therefore only ever seen the healed state. That is not what happens: the test harness wipes every table before each test, so those tests have always exercised a *first* run. The feature was dormant in that suite too — and it survived because no test ever asserted the thing that was missing.

**One explanation was structural and blameless. The other was "nobody wrote the assertion."** The flattering one went unchallenged. The previous walk had itself concluded that a false finding costs more than a missed one, and that assertions must be proven before defects are reported — and that rule turns out to apply to a review's conclusions just as much as to its findings.

**The measurement is now a test, not an audit.** It runs on every build, compares the whole database rather than the handful of facts someone thought to name, and discovers its own table list — because a table nobody remembers to add is precisely where the next one of these will live. It was proven by putting the original defect back: it goes red, and it says which table.

## The chair nobody could see

**The scheduler had been refusing bookings on the authority of a thing it never showed anyone.** A salon has chairs, and since the previous milestone the software had been counting them — correctly, and at the database, where a client developing colour holds her chair through the hour her stylist spends with somebody else. Four stylists can want eight chairs, and the ninth client genuinely cannot be seated.

**All of which was invisible.** Searching the entire front end for the word "chair" returned two sentences and both were rejections: *no chair free at the new time*, and *every chair is taken at that time*. There was no screen listing the chairs. Nothing on an appointment said which one the client was in. There was no way to add a fifth, take one out of service for the afternoon, or record that a blow-dry at the basin needs none at all — those facts were written once by the demo data and could not be changed without a database client.

**A refusal that names something the operator cannot see or change is how a salon ends up booking on paper.** It is the worst possible combination: the software is right, and it is unarguable.

**So the room became a thing you own.** A settings screen for the chairs, with capacity, which services need one, and the state that quietly closes the business — a required resource with nothing in service — called out rather than left to look like an ordinary empty day. A selector on each service that says what it occupies, including *nothing*. The chair named on the appointment itself. And the day view gained a second half: a track per chair, running down the same timeline as the stylists beside it, so the difference the whole feature is about is something you look at rather than something you argue about. A colour's block in the room runs straight through its developing hour, while the same colour in its stylist's column has a hole in it with somebody else booked into it.

**Taking a chair out of service does not move anyone.** It is not a deletion — the appointments already in that chair keep it until they are done, and the chair keeps appearing, marked out of service, until its last client leaves. What changes is that nobody new is seated there. Doing it with clients already booked is confirmed rather than refused, because the salon that loses a chair to a burst pipe on a Saturday has to be able to say so with nine people in the book. What it must never be is silent, so the count comes first.

**The test that matters is the one that changes the answer.** Fill the room, be refused, then clear one service's requirement through the same form an owner would use — and the client who was just turned away books, holding nothing. Two siblings run the other directions: add a chair through the settings screen and the refused client is seated in it; retire one and the refusal arrives a client earlier. Proven by putting the old behaviour back, where the first of those goes red on its own.

**Two of the new tests were wrong before they were right, and both were caught by the same habit.** One hand-wrote a value that the database derives, and read a zero it had caused itself. The other placed its "someone is still in this chair" appointment on a date in the past, where the answer is correctly nobody. Both now prove their own premise before asserting anything about it — the rule the previous walk arrived at, applied to the tests that were meant to enforce it.

## The doors that closed quietly

**One way of taking hours away had learned to speak. The other four had not.**

Entering a sick day already told the desk what it had just stranded — nine clients, here they are, with phone numbers. That was the previous milestone's work, and it was wired to exactly one of the five places a salon can take working time away.

The other four said nothing. Changing a day's hours said "Override saved." Removing them said nothing at all — and the form threw away even that. The worst of the four was the one nobody had listed: **deleting a weekly window is how a salon says "I don't work Thursdays any more,"** and it quietly orphaned every future Thursday booking on the books.

**The fix was not four fixes.** It is tempting to reason about each case separately — surely adding hours cannot strand anyone; surely removing a "closed for the holiday" only frees time up. Every one of those arguments is a chance to be wrong once and never find out. So instead of arguing, the system re-derives who no longer fits the working hours, whatever the change was, and says nothing when the answer is nobody.

**That decision justified itself within minutes.** The first end-to-end run of the new behaviour reported that *adding* a stylist's hours had stranded a client — which turned out to be correct, because working time is the overlap of the salon's hours and the stylist's, and the salon had no hours that day at all. The careful per-case argument would have declared adding hours safe and shipped.

**How far ahead does it look?** As far as the appointment book actually goes, and no further. A salon with nothing booked past Friday checks nothing; one booked eleven months out is answered exactly. And it says nothing about the past, because changing next month's hours cannot strand a client who came in last Tuesday.

**Deleting something takes its history with it.** Every change to the hours records who made it — but the record lives on the row, and deleting the row deletes the record. So when a deletion strands people, the note goes where the question actually gets asked: on each affected client's own appointment history, in plain language. *The weekly hours this sat in were removed by Sam, leaving this one outside them.* Nothing is written when nobody was affected; a history full of "nothing happened to you" is a history nobody reads.

**And a lock that was never fitted.** All four deletion paths took an identifier straight from a form field and deleted whatever it named — including, in principle, another business's Thursday. Now every one of them is scoped to the business doing the deleting. That was not in the plan for this work; it was found while reading the code the plan pointed at.

## Fixing the messaging queue before it can cost money

**Nothing here was broken. That is the point.**

The system that sends reminders and confirmations has always written to a server log rather than to a real email or SMS provider — deliberately, because a provider account, a verified sending domain and an approved SMS campaign are all things other people have to grant you, and an untested integration that merely *looks* finished is worse than an honest seam.

But three known shortcuts had been sitting in that code with comments explaining exactly how they would fail, and every one of them fails on the same day: the day a real provider is connected.

**The first was a double-send.** Two overlapping runs of the sender would both pick up the same queued message and both deliver it. Harmless against a log file. Against a real phone, it is a client texted twice — and the place you find out is the bill. Now a message is *claimed* in a single database statement before anyone sends it, so a second run finds nothing to take. A claim that is never released — a process killed halfway through, which on modern hosting is routine — is reclaimed after fifteen minutes, because a message nobody ever sends is worse than one sent twice.

**The second was a screen that would start lying retroactively.** The appointment history says whether a client was told, and it drew a careful distinction: with no real provider, "sent" really meant "written to a log", so it said "queued" instead. The trouble was *where* it asked the question — of the running software rather than of the message. Connect a real provider and every message ever queued, going back to the first one, would have flipped to "sent" overnight. Now each message records which sender handled it, so a message the log adapter handled last March still reads "queued" forever, which is the truth about that message.

**The third was throwing away the receipt.** Providers return their own identifier for every message, and it was being discarded because there was nowhere to put it. It is the only thing that lets you go back later and ask what actually happened to a specific message. There is now a column for it.

**And two things nobody had listed.**

The first was found by testing an assumption rather than trusting it. When a booking and its confirmation are saved together, and the confirmation turns out to be a duplicate, the code caught that and looked up the existing one. It could not have worked: a database that hits a uniqueness conflict inside a transaction refuses everything else in that transaction, so the lookup failed and the *booking* was rolled back. The guarantee that this system was built around — record it once, safely, however many times you ask — was only ever true outside a transaction, which is not where it is used. Every test passed because every test called it the easy way.

The second was in the reminder job, and it was mislabelled by its own warning comment. The risk was described as sending two reminders; the database had always prevented that. The real damage was to the link in the message. Each run issues a fresh manage link and cancels the previous one, so the run that *lost* the race was cancelling the link belonging to the message that actually went out. The client would have received a reminder whose link was already dead.

**Two tests that only failed when the machine was busy.** One older test — two front-desk staff moving the same appointment at the same time — turned out to pass or fail depending on timing. Setting the current work aside and re-running it against the previous version showed the same one-in-six failure, so it had been that way for some time. A test like that is worse than no test: it teaches everyone to re-run and move on. It now *forces* the collision it claims to be about instead of hoping for one, and it was checked in both directions — green eight times running, and correctly red when the protection it guards is removed.

**The second one is only half fixed, and saying so matters more than the fix.** A group of tests that drive the customer booking screens were timing out after thirty seconds waiting for a form field. The first explanation was tidy and wrong: the tests book "today's first free time", the salon shuts at six, and the run was happening at half past nine at night. The screenshot the test saved disproved it — the booking screen had correctly offered a day two weeks out and was simply stuck one step earlier. The actual cause was that these tests clicked through the booking steps without waiting for each step to appear, and every step draws the same list of buttons, so a click sent a fraction too early re-clicks the step you just left. The sister test file had been waiting properly all along; this one never learned to.

That change turns a thirty-second mystery into a five-second failure that names the step it is stuck on. It does not make the problem go away entirely: a click on a stylist's name is still occasionally lost, because the button is drawn before the page is ready to respond to it. The tempting fix is to click again and move on. That is how a test starts passing for the wrong reason, so it is recorded as an open problem instead.

## The appointment that repeats itself

A salon's forward book is mostly standing appointments. The colour client who comes every four weeks, the blow-dry every Friday — the diary is largely built out of them, and until now the front desk created each one by hand, one at a time, tapping forward through the calendar.

It is now two fields beside the Book button: how many, and how many weeks apart. The button then says `Book 6 appointments`, because six new rows in the diary is not something anyone should discover afterwards.

**The interesting part is not the happy path.** Six appointments a month apart will meet a week that is already somebody else's. The refusal everyone writes first is all-or-nothing: one week is taken, so book none of them. The other easy answer is worse — book five and say nothing about the sixth, which the client discovers in five months when she turns up to a chair that has someone in it.

So it books what it can and reports every week it could not, with the reason in the salon's own words: "Tuesday 15 September — not booked — she already has a client then." The desk reads the list and makes one phone call, which is what it was going to do anyway. Each booked week is a link, so adjusting the fourth one is a tap rather than a search.

**Every occurrence is a real appointment, not a rule the software expands when asked.** That is the load-bearing choice. This system's guarantee against double-booking is enforced by the database itself, and a database can only defend rows that exist. A "virtual" recurring appointment is a booking the database has never heard of: it cannot hold a chair, cannot be raced against, and does not appear when the system asks who is busy — so every guarantee the product is built on would quietly stop at the edge of a recurring appointment. Materialising them costs storage and buys correctness that is otherwise unavailable at any price.

**And the reason a repeat is stored as "Tuesday at 2pm" rather than "every 2,419,200,000 milliseconds".** Four weeks is 672 hours only if no clock changes in between. Add the physical duration to a 2pm appointment across the spring clock change and the client is booked at 3pm — an hour she never agreed to, with nothing failing anywhere. So the repeat is calendar arithmetic on a weekday and a wall time, converted to a real moment once, at the end.

Repeat anything long enough and it lands on both of the two days a year that break: the week where the time does not exist at all, and the week where it happens twice. The first is skipped and named — never nudged to the nearest real time, which is what most date libraries do and is how a client gets told a time she never chose. The second books the first of the two and says so.

There is one more case, and it is the kind that is normally found in production in November. The desk can already pick either of the two 1:30s on the day the clocks go back — they are offered by name. But a repeat is stored as a wall time, and reading a wall time back on that day gives the *first* one. So a repeat started deliberately from the second 1:30 would have booked its own first appointment an hour away from the time just agreed with the client. It is refused, with both ways forward, at the one boundary where writing an instant down as a wall time is not reversible.

**What is deliberately not here.** There is no "cancel the whole series" button. Cancelling a standing appointment sounds like one button and is not: the late-cancellation window applies to some of those occurrences and not others, each one owes the client a message, and "the remaining ones" and "all of them" are different requests. Every occurrence already lists the rest of its series, one tap apart, through the ordinary cancel that already handles the cutoff and the message. It is written down as a decision with the condition that would change it, rather than left as a gap someone assumes was an oversight.

## Four names, one password, and the door that never locked

The salon had four people on its audit trail and one password under the desk.

An earlier release made every action say who did it — Dana checked her in, Priya moved it, Marcus marked the no-show. That was real, and it was also only half of an identity: the names were attached to a single shared sign-in that everyone typed. Which meant the audit trail said four things and the front door said one, and anyone who came through that door could open the owner's dashboard — the week's revenue, each stylist's utilization, and every colleague's no-show count.

**Now each person can have their own sign-in, and there are exactly two roles.** Owner, and everybody else. That is not a placeholder for a permissions matrix; it is the decision. A four-chair salon has an owner and it has stylists, and every extra role is a screen somebody has to maintain and a distinction nobody actually draws out loud. The one distinction that is real is money, and money is now owner-only.

**The subtle part is *whose* role the software reads.** The salon signs in once in the morning and four people share the terminal all day, tapping a short PIN to say who is at the desk. If the software had checked the role of the *account that signed in*, then a stylist who tapped in would still have been holding the owner's dashboard — the PIN would have handed her a name while handing nothing away, which is the opposite of what it is for. So the role belongs to whoever is at the desk right now: taking the desk hands the money back, and the owner takes it again with her own PIN or her own sign-in. There is a test that walks exactly that sequence, because it is the version a careful implementation gets wrong.

**Upgrading an existing salon is where this kind of change usually goes wrong**, in one of two ways. Give everybody the new role and nothing is protected. Give nobody the role and the salon is locked out of its own dashboard on the morning of the deploy, with no screen left that could grant it back. The upgrade here marks exactly the accounts that already had a password as owners — the people who could already see everything — so nothing anybody could do yesterday changed today. Anyone added from now on starts with the least access, which is the direction that fails safely.

For the same reason, the last owner cannot be demoted, and cannot be taken off the roster either. That is a state nothing in the product can recover from, and it is reachable through two different buttons, so the refusal lives in the one place both of them go through rather than on either screen.

**And the front door now locks.** Until this release the only thing standing between a guessed password and the salon's diary was that checking a password is deliberately slow. That is a real defence and it is not a limiter. There are now two:

- **Ten wrong passwords in a quarter of an hour** and that email address stops being tried for a while. It is counted before the account is even looked up, so an address that does not exist locks out exactly like a real one — otherwise "locked" would itself have told an attacker which addresses are real, undoing a protection that was already carefully built.
- **Five wrong PINs and that one name closes** — tighter, because four digits is ten thousand possibilities and the PIN pad stands in a room the public walks into, with the names listed next to it. Per person, so one stylist mistyping hers cannot lock the front desk out of everyone else's on the busiest afternoon of the year.

Both count *failures*, not attempts: signing in correctly forgets the count. A desk that legitimately signs in eleven times on a Saturday must not lock itself out, and an attacker who has already guessed right has no use for the budget they just cleared.

The lockout also gets its own message, and it is the only sign-in failure that does. Every other failure says the same deliberately vague thing, because a form that distinguishes "no such user" from "wrong password" is a directory of who works here. But a desk typing the right password into a door that has quietly closed needs to be told the door is closed — otherwise the software has produced a phone call instead of preventing one.

## The message that was never sent again

A notification that failed once was never tried again. It was recorded as failed, and that was the end of it — no second attempt, no delay and retry, and no screen anywhere that would tell a human it had happened.

That was invisible, because this system's message sender currently writes to a server log rather than to a real email or SMS provider, and a log file does not have bad minutes. Real providers do. A rate limit, a five-second outage, a 503 from a datacentre having an afternoon — every one of those is a temporary condition that clears on its own, and every one of them meant a client who was simply never told, permanently, with nothing on any screen to say so.

**Now a failed message is tried again on a widening schedule**: a minute later, then five, then twenty-five, then two hours. Five attempts in all, and then it stops. The whole sequence is spent in a little over two hours, which is deliberate — it is comfortably longer than a provider's bad minute and comfortably shorter than the useful life of a reminder for tomorrow morning. A reminder that finally goes out at midnight is not a reminder.

**The interesting decision is which failures are worth retrying.** Not all of them are, and getting this wrong is expensive in both directions. A phone number that is not in service will not be in service in five minutes; retrying it four more times is four more charges and, on some providers, a reputation penalty for repeatedly messaging a dead number. So failures that are about *the recipient* — a dead number, an address that does not exist, someone who has unsubscribed — are permanent, and are given up on immediately.

Everything else is retried. Including, deliberately, failures the software does not recognise.

That default is worth explaining, because the instinct runs the other way. The two mistakes are not equally bad. Retrying something that was actually permanent costs a handful of attempts that fail, and the message still lands on the "nobody was told" screen at the end with its reason attached. *Not* retrying something that was actually temporary costs a client who never hears from the salon and nobody who ever finds out. One of those has a floor under it. The other is the exact problem this release exists to remove — so the unfamiliar case gets the safe treatment, not the strict one.

**And there is now a screen.** A retry policy nobody can see is the same silence with better manners.

It shows two things at once, on purpose, because the front desk is asking one question — *is anybody not going to hear from us?* At the top, the messages that were given up on, each with the provider's own reason written out rather than a friendly paraphrase: "the number is not in service" is what sends someone to fix the number, and a softer wording throws that away. Below them, the messages still working through their retries — which is there to be *reassuring*. Without it, a message quietly waiting five minutes for its next attempt is invisible, and the desk phones a client the system was about to reach anyway.

The count on the staff home page counts only the first group. A message still trying is not something anybody should act on, and a badge that lights up for it is a badge people learn to ignore.

Fixed the phone number? There is a button that puts the message back in the queue with a full set of attempts again — not the one remaining attempt it had left, which would fail once more and look, from the desk, like the button was broken.

**Two smaller things came with it.** A message with no contact details on it at all used to be handed to the sender as an empty address, which the log adapter cheerfully reported as delivered; it is now recognised for what it is and said out loud once. And the call-down list — tomorrow's unconfirmed appointments — now shows each booking's value and any no-show history next to it. It stays in time order deliberately: the desk works down the day with the diary open, and silently re-ranking that list would make every row's position mean something the person reading it does not know. The information to triage by is on the row; the choice stays with the person.

## The oldest unanswered question in the file, answered

"Who blocked Dana's Thursday afternoon, and why?" has been askable at the front desk since the very first version of the availability screen — and until this release, unanswerable. The system recorded the answer every single time somebody changed a stylist's hours or blocked out a slot. It just never showed it to anyone.

That is now on the screen, next to the hours it explains: "blocked by Priya", right beside the reason she already typed in. Every weekly hour, every one-off date, every block of time off now carries who set it.

The interesting part is not the feature — it is a single sentence answering a question that was already being logged in the database and simply never surfaced. The two things worth noting are both about not repeating work already done elsewhere in the system:

The logic for "turn a list of staff IDs into their names" already existed, built for the appointment history a few releases back. Rather than writing it a second time for this screen, it was pulled out into a shared piece both features now call — so a name shown on one screen and a name shown on the other will never quietly start disagreeing about who a departed employee was.

And a blank space where a name should be is treated as real information, not an oversight to paper over. A handful of availability records exist from before the system started tracking who made a change; for those, the screen shows nothing rather than guessing. A wrong name is worse than no name — it is a wrong answer to exactly the question this feature exists to answer correctly.

## Reminding someone about an appointment they already cancelled

Every few weeks this project stops adding features and instead walks the system the way a person would, deliberately choosing the places where two separate features meet rather than the middle of either one. Every feature has passing tests. What nothing owns is the seam.

This walk found two problems. The second one is the interesting one, because it was created three weeks ago *by a fix*.

**The system decides what to send and sends it as two separate steps.** That separation is deliberate and correct — deciding happens inside the booking transaction so a message can never be promised and then lost, while sending happens later against an external provider that can be slow or down. But nothing was checking whether the world had changed in between.

So: a client is booked for Tuesday at ten. The evening before, the reminder is prepared. A minute later she rings and cancels. A minute after that, the sender runs — and sends both messages. She is told her appointment is cancelled, and then reminded to come to it. The reminder is the one she reads last.

That gap used to be milliseconds wide, which is why nobody had seen it. **Then the previous release widened it to two and a half hours.** That release added retries, so a message failing against a provider having a bad minute is tried again later instead of being silently dropped — a genuinely good change, and one that made this much worse. The walk confirmed it: the reminder failed, the client rescheduled to Wednesday, and the retry cheerfully sent her a reminder naming Tuesday.

**The fix is to ask, at the last possible moment before handing the message to the provider, whether it is still true.** And only reminders are checked, which is not a shortcut but the actual distinction: every other message reports something that *happened* — you're booked, we moved you, we cancelled, the stylist is running late. Those are still true when they arrive late. A reminder is the only message that makes a claim about the *future*, which makes it the only one the world can turn into a lie while it sits in a queue.

A reminder that has stopped being true is set aside with the reason recorded, not marked failed. Nothing went wrong, and it does not belong on the "nobody was told" list next to a disconnected phone number. She is not left unreminded either: if she moved to Wednesday, the system reminds her about Wednesday when Wednesday comes round.

**The second problem was a promise the system could not keep.**

Each appointment has a private link the client uses to confirm, reschedule or cancel. When the reminder goes out it carries a fresh link, and the old one stops working — deliberately, decided long ago, on the reasoning that "the reminder always carries a fresh link, so nothing is left dangling."

The word doing the work in that sentence is *carries*. The link was being killed at the moment the reminder was **written**, not the moment it was **delivered**. The walk killed her working link, then failed the reminder permanently — a dead email address — and left her holding a link that no longer opened her own booking, with no replacement, and no way to know.

What makes this one worth writing down is that the original decision *already contained the correct test*. One sentence earlier it explains why rescheduling doesn't do the same thing: because a reschedule message carries no link, "there would be nothing to replace the one it broke." Exactly right — and a reminder that never arrives carries no link either. The rule was sound; it was being applied a step too early.

Now the reminder mints its new link and leaves the old one working. Two live links to the same appointment is a non-event: same booking, same expiry, same page. Every other part of the system still retires the old link when it issues a new one.

**And a third problem, found by the test sweep rather than by the walk itself.**

The front desk's booking panel can change which day it is looking at without going back to the calendar. Choosing a service asks the server for that day's available times; changing the day asks again. Nothing was keeping track of which question each answer belonged to — so whichever answer came back *last* was applied, even if it was answering a question the desk had already moved on from.

The result: change the day while the previous day's times are still loading, and the panel quietly re-selects a time on the day you just left, underneath a heading naming the new one. Book, and the appointment lands on the wrong day. The sweep caught it doing exactly that — the panel said 1 September, the appointment was written on 25 August, and nothing on screen suggested the two disagreed.

Answers to superseded questions are now discarded. An empty list for half a second is recoverable; a time silently selected on the wrong day is not.

**Also in this release:** a comment in the test tooling claimed that forgetting to list a new database table would fail loudly. It measured false — the cleanup silently handles unlisted tables — and a comment that describes a safety net which does not exist is worse than no comment, so it now says what actually happens. And an old public booking link format, replaced a while back by the front-desk version and emitted by nothing since, was deleted along with the code that supported it.

## "And can you do my roots while I'm here?"

Until this release, the answer was no — or rather, the answer was one of three bad workarounds.

A client is booked for a cut. She sits down, and asks for something else as well. That is not an edge case; it is a Tuesday. And a booked appointment in this system could be moved, cancelled, confirmed or marked a no-show, but it could not become a *different appointment*. The list of what she was having was written once, at booking, and nothing could change it afterwards.

So the front desk had three options and every one of them was wrong:

**Cancel and rebook.** This records a late cancellation against a client who did nothing wrong — it lands on her record, on the owner's dashboard, and on the number used to decide whether to start taking deposits. It also sends her a cancellation message while she is sitting in the chair.

**Book a second appointment right after the first.** The system refuses this, correctly: each service carries padding before and after it, and back-to-back appointments for the same person collide in that padding. This was written down as a known case years of decisions ago and deliberately forbidden.

**Force it through as an override.** Overrides exist for genuine judgement calls — staying late, squeezing someone in. Using one for an ordinary add-on is how a warning marker becomes wallpaper.

**Now the appointment simply changes.** Add a service, take one off, or reorder them, on the appointment's own screen. It stays the same appointment throughout — same booking, same history, same link in the client's email. Nothing is cancelled and nobody is told anything false.

Three details are worth calling out, because they are where this kind of feature usually goes wrong.

**It works while she is in the chair.** Moving an appointment to Thursday is refused once a client has arrived — obviously. Changing what she is having is the opposite: that is *exactly* when you do it. Two questions that look identical and have opposite answers, and the software now knows the difference.

**A price already agreed never changes.** If she booked a cut in January and adds a colour in August, the cut still costs January's price. The colour costs today's. Prices rise; what someone was quoted does not.

**The system re-checks that the longer visit still fits, and says so in the salon's own words.** A visit that would now run into the next client, past closing, through the stylist's lunch, or out of chairs comes back with the actual reason — "during her break" — and the same "do it anyway, and say why" door the booking screen has. Shortening a visit is never re-checked, because giving time back cannot make an appointment less bookable. Time released this way goes straight back on the board as bookable.

**Also fixed:** a bug introduced by the previous release's own housekeeping. A tidy-up to the test tooling had quietly widened a database lock, so resetting the test database could deadlock against the tests that deliberately run bookings at the same instant — the exact tests that exist to prove two people cannot book the same slot. It was invisible until it wasn't: it passed everything on the way in, and then failed twenty-eight ways at once. Reverted, with an explanation left behind so the same tidy-up is not attempted again.

## "Anything Thursday? I don't mind who"

That is the most common call a salon takes, and until now this system could not answer it.

The booking screen would not show you any times until you had picked a stylist. So "anything Thursday?" meant checking Dana, then Priya, then Marcus, then Tess — four passes for one day, sixteen if the client offers two days. Nobody does that with someone waiting on the phone. They say "let me ring you back", and a good share of those never get rung back.

The customer-facing side had the mirror image of the problem: choosing a stylist was a required step with no way past it. A first-time client who has never heard of any of these people either picks whichever name is at the top or gives up. That is not a small thing — it is a plausible explanation for something the owner's dashboard has been reporting without being able to explain, which is the senior stylist booked solid while the newest is at 40%.

**Both now have a "doesn't matter who" answer.** One screen, the whole day, every stylist who can actually do the work, merged into a single list in time order — with the name of the person you would get on each row, because that is the next question.

**One row per time, not one per stylist per time.** If four people are free at two o'clock, that is one offer to the client — "two o'clock" — not four identical-looking rows. The row does quietly say how many are free, which the front desk reads as slack: three free at two is a time you can offer around, one free is a time to sell now.

**Who you get is not arbitrary.** The system assigns the stylist with the fewest minutes booked that day, and settles ties in a fixed order. That is deliberate load-balancing: picking the first qualified name every time is exactly how one person's column fills while another's stays empty. It has been in the product specification from the beginning and had simply never been built.

Two details worth stating because they are the kind of thing that goes wrong quietly:

**The name shown is the name you get.** The stylist is chosen when the list is drawn, and that choice travels with the row you tap. The alternative — deciding again at the moment of booking — would let the desk read "two o'clock with Dana", tap it, and book Priya because someone else booked in the intervening seconds. If the named stylist genuinely is taken in that window, the booking is refused the same way any other lost race is refused, and the desk picks again.

**A no-show still counts as that stylist's time.** She was there; the hour was hers; the client did not turn up. Not counting it would send the next booking to her on the grounds that her day looks empty, which is balancing against a fiction.

Nothing about how free time is calculated changed. This asks the existing engine the same question once per stylist and merges the answers — there is no second opinion about whether a time is available, which is the only way two answers can ever disagree.

## "End this series here"

A client with a standing appointment rings on a Saturday to stop it. Until now the front desk had to open each remaining booking in turn, make a cancellation judgement on each, type a reason on each and send a message on each — six taps' worth of work for something the client said once.

**Setting up six appointments was one action. Undoing them was six.** That asymmetry does not just cost time; it changes behaviour. The desk cancels two, means to come back to it, and gets busy. Four two-o'clock Tuesdays stay held for somebody who is never coming — and eventually land on that client's record as four no-shows that were the salon's fault. A product whose undo costs six times its create teaches people not to use the create.

So it is one action now: **end it at this appointment, and everything after it goes.** The ones she has already had are untouched. Ones she had already cancelled herself are left exactly as they are — no second cancellation, no second text about the same thing.

**It shows you what goes before it does anything.** The list is every remaining date, and beside each one whether it falls inside the cancellation window — because that varies date by date, and it is what the desk has to be able to say out loud while the client is still on the phone. That per-date variation was the original reason for thinking this action could not exist. It turns out to be the reason it needs a preview.

**One reason, typed once**, lands on every appointment's history and in every client message. The "I have already rung her" box is there for the desk that made the call first — and it starts unticked, so silence is always a deliberate choice, never a default.

**One thing it will not do, and says so.** If one of those appointments is happening right now — she is in the chair — it stays, and the screen names it. Cancelling a visit in progress is a different act with a different conversation attached, and it would otherwise send a cancellation text to a client sitting in front of the person who sent it.

**Nothing else about a cancellation changed.** Each one goes through the same single cancellation path everything else in the product uses, so the record kept, the message sent, and the freeing of the slot back onto the board are identical to doing them one at a time. The standing-appointment link survives on every cancelled booking, because "she had a standing Tuesday and ended it in April" is exactly the sort of thing someone asks about six months later.

## Booking a visit, not a service — and not selling what needs a conversation first

Half the Saturday book in a salon is a cut *and* a colour. The online booking form could only take one of them.

So a client booked "Colour", two hours, and arrived wanting a cut as well. Those extra forty-five minutes then had to come out of a column that was already full — which means either the next client waits, or the stylist does, or somebody at the desk quietly moves three appointments. **The client did nothing wrong; the form asked her the wrong question.**

**She now picks everything she wants on the same screen**, and sees the visit as one thing: how long she will be in the chair and what it costs in total, not a line each to add up herself. It stays one appointment — one confirmation, one link to change or cancel it, one row in the book — which is what it always was in the salon's head.

The order she taps them in matters and is kept. A cut before a colour is a different appointment from a colour before a cut, because the preparation and tidy-up time sit at the ends of the visit rather than around each service.

**Nothing was added to the number of screens.** It is still service → who → day → time → details. A "would you like to add anything?" step would have bought this one feature at the cost of a screen every single-service client has to tap past.

### Some things should not be bookable at two in the morning by someone we have never met

A colour correction, a full-head bleach: three or four hours of a chair, and a result that depends entirely on what is already on the client's hair. Every salon wants that work — after a conversation, and usually after a patch test. Until now the form would sell it to anyone.

**Any service can now be marked "desk only."** The front desk books it exactly as before; the online form will not.

**It still appears on the online list**, greyed, saying *give us a call for this one — it needs a quick chat first*. Hiding it would have been the easier build and the wrong outcome: a salon that offers balayage and shows a list without it has told the client it does not do balayage, and she books it somewhere that does. The point is to start the phone call, not to end it.

Two details that decide whether this is a good feature or an annoying one:

**"Desk only" is not "retired."** A retired service disappears from everywhere; a desk-only one is on the price list and sold every week. They are kept as separate things, so marking a service desk-only never quietly removes it from anywhere the salon still needs it.

**A client who already has one of these appointments can still move it herself.** She booked it properly, through the desk, with the consultation done — the restriction is on *starting* one of these, never on keeping one. The obvious way to build this would have blocked her, and she would have had to ring the salon to move an appointment she could previously move from her phone.

## Running late now tells the desk who to ring

Marking a stylist forty minutes behind did a lot: the board turned amber, the projected times appeared down her column, and the website stopped selling the next forty minutes while a client sat in the waiting area.

**It told nobody.** The four people already on their way to that column were still arriving at the time printed on their confirmations. So somebody at the desk rang them — and kept the list of who they had got to on a Post-it beside the keyboard. That Post-it is the shadow calendar this whole product exists to remove, and it had grown back one layer down.

**Setting the delay now produces the list itself.** Who is still on her way in the next three hours, the time on her confirmation, the time she is actually likely to be seen, her number as a link that dials it, and the same allergy note and missed-appointments flag that sit on her chip in the book. Every person on it can be ticked *told her*, with a name and a time against the tick, so the second person at the desk does not re-ring the first six.

**It sends nothing, and the screen says so in as many words.** There is no text going out here — the calls are made by a person. A button that quietly queued a message would be worse than no button at all, because the tick beside a client's name would then mean "the system has this" when what it meant was "nobody has spoken to her."

Three things about the list that came from thinking about the desk rather than the data:

**Nobody in the building is on it.** A client sitting in the waiting area can see the salon is running late. Ringing her to say so is the salon announcing it does not know who is in it.

**The count is of who is left**, not of the list. The question at the desk is "how many more calls", and a heading that counted the finished ones would climb as the work got done.

**A tick can go stale, and says so.** She was told "about twenty" and the stylist is now fifty behind. The tick stays — somebody did ring her — but the row is flagged as worth a second call, because what she was told is no longer what is happening.

### "She's caught up, pull it back twenty"

Pushing a whole column later has always accepted a negative number, and nothing anywhere said so. It was a real instruction the desk gives out loud, and a feature nobody could find.

**The field now says it**, and the two sharp edges behind it are gone: pulling a column earlier can no longer start a client's appointment before the salon opens — it names her and leaves her where she is, exactly as pushing past closing time already did — and the message she receives now says her appointment has been brought forward instead of telling her the salon is running behind.

## The system knows whether a cancellation was late, so it stops asking the front desk

A salon's late-cancellation count is a number the owner staffs on. It decides who gets the Saturday column and which clients get a quiet word. Until this release the software produced that number by putting two buttons side by side — "Cancel" and "Cancel (late)" — and letting whoever was on the phone at the time pick one.

Nothing about that is a judgement call. The business has a cancellation cutoff, a service can demand more notice than the business default, and the software has a clock. The customer's own manage link had been classifying her cancellations from exactly those three things since the beginning. Only the people at the desk were being asked to guess, in front of a client, on the phone, with somebody waiting.

**There is now one Cancel button, and it says what it is going to do before it is pressed** — "Cancel", or "Cancel — counts as late". The decision is made on the server from the cutoff that actually applies to that visit, so a two-service appointment meets the stricter of its two services' rules rather than the business default. The screen posts an intention, never a status; it is no longer capable of classifying a cancellation, even by accident.

### The exception is a button, not a workaround

Real salons let people off. A system that refuses to model that gets the front desk quietly classifying by hand again within a fortnight, and the number goes back to meaning nothing.

So there is a second button beside the first, and it appears only when the machine's answer was "late": *She gave us proper notice, or this one's on us — don't count it late.* It requires a reason, it records what it overruled, and the owner has a single page listing every one of them for the week — the client, the person who made the call, and what they typed. A week with none shows nothing at all.

That page is the point. An exception nobody can see the size of stops being an exception and becomes the new default.

### And a cancellation the salon caused never lands on the client

When a stylist calls in sick and the salon takes an appointment away, the clock will happily say "inside the cutoff" — because the cutoff exists to price a *client's* late notice, and this client gave none. That cancellation is now recorded as an ordinary one, permanently and by construction, so it can never appear on the rolling count of somebody who did nothing wrong.

## The call-down list now remembers who has already been rung

The call-down list — everybody booked tomorrow who hasn't confirmed — has always been correct at any single moment: derived fresh from the appointments, never a stored flag that could drift. But "correct at any moment" and "useful over an afternoon" turned out to be different things. Eighteen unconfirmed at 2pm, the desk gets through nine, three no-answers, a walk-in arrives — and at 4pm the list looks exactly as it did at 2pm, because nothing about a phone call is derivable from the booking itself. The next person starts at the top and rings six people twice.

**Two buttons per row now record what happened: "No answer" or "Left a message."** The tick is stamped with who made the call and when, survives a reload, and never disturbs the list's own time order — a tried row stays where its appointment time puts it. It clears itself the moment the client confirms or the appointment moves to another day, because both of those already take the row off the list for reasons that have nothing to do with the call. Nothing is sent when a row is ticked; the words on screen say a person made a phone call, because a screen that could be misread as "handled, no need to call her" would be worse than no screen at all.

A mis-tap is reversible by the same hand that made it — the desk is a shared screen, and a wrong tap otherwise silently skips a client until somebody else happens to notice.
