All facts verified against the IANA database. Here is the specification.

---

# Slot Engine: Correctness Specification & Edge-Case Test Matrix
**Project:** Bookable (PRD P0-3, P0-4) · **Stack:** TypeScript / Node 22 / Postgres / Prisma

Everything below is derived from `/mnt/user-data/uploads/apptbasedservice/prd-bookable-appointment-app.md`. All DST arithmetic in §3 was verified by execution against the tzdata in Node 22, not recalled — the UTC instants and slot counts are literal expected values you can paste into tests.

---

## 0. Three facts that drive the whole design

**Fact 1 — a working-hours rule and a booking are different kinds of thing.** "I work Tuesdays 9–5" is a *wall-clock* rule: it means 9–5 whatever the offset is that week. "Alice's cut is at 09:00 on Mar 15" is an *instant*: it happened / will happen at one point on the physical timeline. Rules must be stored as wall-clock; occurrences must be stored as instants. Conflating them is the root cause of roughly every bug in §3.

**Fact 2 — the local↔instant map is neither injective nor total.** On 2026-03-08 in America/Chicago, `02:30` names *no* instant. On 2026-11-01, `01:30` names *two*. Any function typed `(wallTime, zone) => Instant` is lying. The real type is `(wallTime, zone) => Instant[]` with length 0, 1, or 2, and every call site must decide what to do with 0 and 2.

**Fact 3 — the `@db.Date` incident from the sibling project is a type error, not a timezone error.** Verified:

```
Prisma reads a DATE column '2026-03-08' as JS Date 2026-03-08T00:00:00Z
→ formatted in America/Chicago → "2026-03-07"
```

A calendar day was given the type of an instant, so it acquired an offset it never had. The fix is not "be careful with timezones," it's *making the two types non-interchangeable at compile time*, which is §1.

---

## 1. The function signature

### 1.1 The two types and the law that separates them

```ts
// ── The calendar axis. No offset. No instant. Not orderable against Instant. ──
/** ISO-8601 calendar date, "2026-03-08". A label on a wall calendar. */
export type CalendarDay = string & { readonly __brand: unique symbol };
/** ISO-8601 local time of day, "09:00" | "09:00:00". No date, no zone. */
export type WallTime    = string & { readonly __brand: unique symbol };
/** IANA zone id, "America/Chicago". Never a fixed offset, never an abbreviation. */
export type ZoneId      = string & { readonly __brand: unique symbol };

// ── The physical axis. One number line. No calendar meaning. ──
/** Epoch milliseconds UTC. The only representation of a moment in this system. */
export type Instant     = number & { readonly __brand: unique symbol };
```

**The No-Mixing Law (make this a lint rule and a CLAUDE.md entry):**

> 1. `CalendarDay`, `WallTime` and `Instant` are branded and structurally incompatible. Neither `Date` nor a bare `string`/`number` crosses the engine boundary in either direction.
> 2. There is exactly **one** module (`src/time/zone.ts`) permitted to convert between the axes. It exports exactly two functions, and both take an explicit `ZoneId` — there is no zoneless overload, ever.
> 3. `resolve(day, time, zone)` returns `{ kind: 'unique', at } | { kind: 'gap', ... } | { kind: 'ambiguous', earlier, later }`. It **does not** return a bare `Instant`. Callers must handle all three arms; `noUncheckedIndexedAccess` and an exhaustive switch make that mechanical.
> 4. `new Date(string)`, `Date.parse`, `getHours`, `setHours`, `toISOString().slice(0,10)`, and `date.getTimezoneOffset()` are banned repo-wide by ESLint `no-restricted-syntax`. Every one of them is a silent axis-crossing using the *process* timezone.
> 5. Persistence: `CalendarDay` is stored `String @db.Char(10)`, **never** `DateTime @db.Date`. This is a deliberate downgrade — you give up Postgres date arithmetic to make the axis error unrepresentable. Postgres `date` → node-postgres → JS `Date` is the exact path that produced the sibling project's day-west shift. If you need date arithmetic in SQL, cast in the query.

Prefer `Temporal.PlainDate` / `Temporal.PlainTime` / `Temporal.Instant` over the branded strings above if you adopt Temporal (§5) — they carry the same law with better ergonomics. Keep the branded strings as the *serialization* form at the API and DB boundary, because a `Temporal.PlainDate` must not be JSON-round-tripped through a `Date`.

### 1.2 The signature

```ts
export interface SlotQuery {
  /** The calendar day the customer is browsing, IN THE BUSINESS'S CALENDAR.
   *  Not derived from the customer's browser. Not derived from an Instant
   *  without a zone. This is a label, not a moment. */
  readonly day: CalendarDay;

  /** The ONLY timezone that participates in computation. */
  readonly businessZone: ZoneId;

  readonly service: {
    readonly durationMinutes: number;      // > 0, integer
    readonly bufferBeforeMinutes: number;  // >= 0 — see §3.H, add it now
    readonly bufferAfterMinutes: number;   // >= 0
  };

  /** Wall-clock RULES. Resolved against `day` (and day+1 when endsNextDay). */
  readonly windows: readonly WorkingWindow[];

  /** INSTANTS. Everything already fixed on the physical timeline. */
  readonly busy: readonly BusyInterval[];

  readonly grid: {
    readonly intervalMinutes: number;      // > 0, integer. default 15
    readonly anchor: 'window-open' | 'local-midnight';   // default 'window-open'
  };

  /** Injected. NEVER Date.now() — that alone would destroy purity. */
  readonly now: Instant;
  readonly minimumLeadMinutes: number;     // >= 0 — PRD omits this, see §3.K

  readonly policy: SlotPolicy;
  readonly explain?: boolean;              // default false
}

export interface WorkingWindow {
  readonly open: WallTime;                 // e.g. "20:00"
  readonly close: WallTime;                // e.g. "02:00"
  readonly endsNextDay: boolean;           // §3.E — required, not inferred
  /** Breaks belong to the WINDOW, not to the day. An override that replaces
   *  windows therefore replaces their breaks too — no orphan lunch break. */
  readonly breaks: readonly { open: WallTime; close: WallTime }[];
}

export interface BusyInterval {
  readonly start: Instant;                 // half-open [start, end)
  readonly end: Instant;
  readonly kind: 'booking' | 'time_off' | 'ad_hoc_block';
  readonly id: string;                     // for explanations
}

export interface SlotPolicy {
  /** Recommended defaults — see §3.H for the argument. */
  readonly bufferMayOverlapBreak: boolean;   // default true
  readonly bufferMayExtendPastClose: boolean;// default true
  /** Fall-back day: 01:30 exists twice. Offer both, or only the first? */
  readonly ambiguousLocalTime: 'offer-both' | 'offer-earlier-only'; // default 'offer-both'
}

// ── Output ──
export interface Slot {
  readonly start: Instant;                 // the identity of the slot
  readonly end: Instant;                   // start + duration, exclusive
  readonly blockedStart: Instant;          // start - bufferBefore
  readonly blockedEnd: Instant;            // end   + bufferAfter
  /** Precomputed presentation in the BUSINESS zone. Never recompute downstream. */
  readonly label: {
    readonly day: CalendarDay;             // may differ from query.day (§3.E)
    readonly time: WallTime;               // "01:30"
    readonly offset: string;               // "-05:00" — the fall-back tiebreaker
    readonly abbreviation: string;         // "CDT" — for the UI, never for logic
  };
  /** true when this wall label appears twice on this calendar day (§3.B). */
  readonly labelIsAmbiguous: boolean;
}

export type ExclusionReason =
  | 'outside-working-window' | 'inside-break'      | 'crosses-window-close'
  | 'overlaps-booking'       | 'overlaps-buffer'   | 'overlaps-time-off'
  | 'in-the-past'            | 'inside-lead-time'  | 'nonexistent-local-time';

export interface Exclusion {
  readonly candidateStart: Instant;
  readonly label: Slot['label'];
  readonly reasons: readonly ExclusionReason[];   // ALL of them, not the first
  readonly conflictIds: readonly string[];
}

export interface SlotResult {
  readonly slots: readonly Slot[];
  /** Populated only when explain === true. */
  readonly excluded: readonly Exclusion[];
  /** Diagnostics for the day as a whole. */
  readonly meta: {
    readonly windowInstants: readonly { start: Instant; end: Instant }[];
    readonly localDayLengthMinutes: number;  // 1380 | 1440 | 1500 — see §2.20
    readonly candidatesConsidered: number;
  };
}

export function computeSlots(q: SlotQuery): SlotResult;   // pure, total, no I/O
```

### 1.3 Defending the shape

**Why `day: CalendarDay` and not an instant range.** The customer clicks "March 8". That is a calendar label. Converting it to an instant range requires the business zone — and on 2026-03-08 that range is 23 hours long, on 2026-11-01 it is 25. If the caller hands you an instant range, the caller has already done the conversion, and the caller is an HTTP handler with the wrong context. Push the conversion inside, where the zone is known and the DST arithmetic is tested. Corollary: the API route is `GET /availability?day=2026-03-08&providerId=…` — a date string, never `?from=…&to=…` epoch millis.

**Why bookings arrive as instants, not wall-clock intervals.** Four reasons, in order of severity:

1. **Wall-clock intervals are not well-defined on fall-back day.** A booking recorded as "01:00–02:00 local on 2026-11-01" is genuinely ambiguous — it is either `06:00–07:00Z` or `07:00–08:00Z`. There is no rule that recovers the answer. Instants are the only representation that survives.
2. **Overlap arithmetic must happen on the physical axis.** Two intervals collide iff they collide in real time. On a DST day, wall-clock overlap and physical overlap disagree.
3. They are already stored as `timestamptz`. Converting them to wall-clock to compute and back to instants to compare is two extra lossy conversions for no benefit.
4. A booking can cross midnight or a DST boundary; as an instant pair it's one interval, as a wall-clock pair it's a special case.

The asymmetry — *rules in wall-clock, occurrences in instants* — is the single most important line in this document.

**One consequence the developer must not miss:** because `busy` is instant-based, the query that populates it **must not** be `WHERE date(startAt) = '2026-03-08'`. It must be an instant-overlap predicate against the resolved window range: `WHERE blockedEnd > :windowStart AND blockedStart < :windowEnd`. Filtering by calendar date misses a booking that started at 23:30 the previous night — the engine then offers 00:00 and you double-book. See DEG-8.

**Why start+end pairs, not bare starts.** Three of the required invariants (§2.4, §2.5, §2.6) are statements about the *interval*, and a test that can only see starts has to re-derive the end by adding the duration — reimplementing, inside the test, the exact arithmetic under test. On a DST day that reimplementation is where the test gets it wrong and agrees with a wrong engine. Return the end. Also return `blockedEnd`, because the UI needs to show the provider's real occupancy and the booking write needs the same number (§4).

Return `label` precomputed, too. If the response contains only instants, the browser formats them — in the *browser's* zone. That is exactly the leak §3.D is about. Ship the business-zone label from the server, formatted once.

**Should it return WHY a slot was excluded? Yes — behind a flag, and the justification is about tests, not UX.**

The cost is real and worth stating plainly: explanations force the engine into a *candidate-then-filter* shape (generate the grid, test each candidate against every constraint, accumulate reasons) rather than the more elegant *interval-subtraction* shape (union the busy set, subtract from windows, grid the remainder). You give up short-circuiting: complexity goes to O(candidates × constraints). At this scale that's about 100 candidates × ~20 constraints ≈ 2,000 predicate evaluations per provider-day — microseconds. Pay it.

The reason it's worth paying: **almost every assertion in §3 is an assertion of absence**, and absence assertions are the most fragile thing in a test suite. `expect(slots).not.toContain('11:00')` passes if you typo the date, if the provider fixture has no hours, if the zone string is wrong, if the engine throws and you swallowed it — it passes for a dozen reasons that are all bugs. With explanations, that test becomes `expect(reasonFor('11:00')).toEqual(['overlaps-buffer'])`, which fails when the mechanism is wrong even though the outcome looks right. That converts the whole matrix from smoke tests into real tests.

Two constraints on the feature:
- `reasons` is an **array**, not a single value. A candidate at 11:00 on a closed holiday during a booking has three reasons; picking one is arbitrary and makes the test order-dependent on your filter chain.
- **Never expose explanations to the public booking UI.** `'overlaps-booking'` tells an anonymous visitor precisely when the provider is with a client. That is a calendar-privacy leak. `explain` is for the test suite and the authenticated staff day view (P0-7) only. Enforce it at the route, not by convention.

---

## 2. Correctness specification

Each numbered item is phrased to become a test name verbatim.

**Purity and determinism**
1. `computeSlots` returns an equal result for equal input, called any number of times, with no observable side effects.
2. `computeSlots` produces identical output when the process runs under `TZ=UTC`, `TZ=America/Chicago`, and `TZ=Pacific/Kiritimati`.
3. `computeSlots` produces identical output when `busy`, `windows`, and `breaks` arrays are shuffled.
4. `computeSlots` performs no I/O: no `Date.now`, no `process.env`, no `Intl` call that reads the system zone, no database, no clock.

**Shape of the output**
5. `slots` is strictly increasing by `start`; no two slots share a `start`.
6. Every slot satisfies `end === start + durationMinutes × 60000` exactly, measured on the physical axis, on every day of the year including transition days.
7. Every slot's `start` is on the grid: `(start − anchorInstant)` is a whole multiple of `intervalMinutes`, where `anchorInstant` is the resolved instant of the containing window's open.
8. Every returned `start` corresponds to exactly one instant; no slot is ever returned for a nonexistent local time.
9. `slots` and `excluded` are disjoint, and their union is exactly the candidate set recorded in `meta.candidatesConsidered`.

**Containment**
10. For every slot, `[start, end)` lies wholly within a single resolved working window — not spread across two.
11. No slot's `[start, end)` intersects any break interval.
12. No slot's `end` exceeds its window's close. (`blockedEnd` may, per `policy.bufferMayExtendPastClose`.)
13. No slot's `[blockedStart, blockedEnd)` intersects any busy interval of kind `booking`, after that interval has been expanded by *its own* buffers.
14. No slot's `[start, end)` intersects any busy interval of kind `time_off` or `ad_hoc_block`, buffers included or not — time off is absolute.

**Time**
15. No slot has `start < now + minimumLeadMinutes × 60000`. The boundary is inclusive: `start === now + lead` is offered.
16. Slot set is monotone in `now`: for `now₂ > now₁` with all else equal, `slots(now₂) ⊆ slots(now₁)`.

**Monotonicity under constraint (property tests, use fast-check)**
17. Adding a busy interval never adds a slot: `slots(busy ∪ {b}) ⊆ slots(busy)`.
18. Adding a break never adds a slot.
19. Increasing `durationMinutes` never adds a slot.
20. Widening a working window never removes a slot.
21. Slots on a coarser grid are a subset of slots on a finer grid when the coarse interval is a multiple of the fine one and both use the same anchor.

**Idempotence and stability**
22. Booking a returned slot and recomputing yields the previous set minus every candidate that overlaps the new booking's blocked interval — and never more, never fewer.
23. Recomputing with the same `now` after booking and cancelling the same slot returns the original set exactly.

**DST totality**
24. `meta.localDayLengthMinutes` is 1380 on spring-forward, 1500 on fall-back, 1440 otherwise, in `America/Chicago`.
25. On fall-back day, `labelIsAmbiguous` is true for exactly those slots whose wall label occurs twice, and those slots have distinct `start` values and distinct `label.offset`.
26. Two working windows that are non-adjacent on the wall clock but contiguous on the instant axis are unioned before gridding. (Spring-forward: `01:00–02:00` and `03:00–04:00` are `07:00–08:00Z` and `08:00–09:00Z` — one contiguous window.)

**Degenerate and contradictory input — the throw/empty distinction**

The rule: **malformed input throws; semantically-empty input returns `{ slots: [], … }`.** "Nothing is available" is a legitimate answer a customer sees daily; "your interval is zero" is a programming error that must not be silently absorbed into an empty list where it looks identical to a busy day.

27. Throws `InvalidSlotQuery` when `durationMinutes <= 0`.
28. Throws when `intervalMinutes <= 0`. *(Non-negotiable: the naive `while (t < end) t += interval` loop does not terminate at 0. A guard here is the difference between a test failure and a hung CI job.)*
29. Throws when any buffer is negative, when `minimumLeadMinutes < 0`, or when any duration is non-integral.
30. Throws when a window has `close <= open` and `endsNextDay === false`.
31. Throws when `day` is not a real calendar date (`2027-02-29`, `2026-13-01`) — never normalizes it.
32. Throws when `businessZone` is not a known IANA identifier, and specifically rejects `"CST"`, `"EST"`, `"UTC-6"` and other fixed-offset or abbreviation forms.
33. Returns `[]` when `windows` is empty.
34. Returns `[]` when every window is shorter than `duration`, with reason `crosses-window-close` on every candidate.
35. Returns `[]` when a full-day time-off covers the entire day.
36. Returns `[]` — not a negative or wrapped result — when `now` is after every window's close.
37. Overlapping busy intervals are unioned, never summed: available minutes never go negative and a break nested inside a booking subtracts its time once.
38. A busy interval entirely outside every window is accepted and ignored without error.
39. A busy interval with `end <= start` throws; a zero-length one throws.
40. Only `cancelled` appointments are absent from `busy`; `no_show` and `completed` still occupy their time. *(This is a caller contract, but assert it in the repository test — it is the highest-frequency real-world regression.)*

---

## 3. The edge-case matrix

Business is **America/Chicago** unless stated. All UTC instants below were verified by execution.

### A. DST spring-forward — 2026-03-08 (Sunday), 02:00 → 03:00, day is 23h

Ground truth: `01:00 CST = 07:00Z`; `02:00:00–02:59:59.999 local does not exist`; `03:00 CDT = 08:00Z`; `05:00 CDT = 10:00Z`. Provider works **01:00–05:00 local = 07:00Z–10:00Z = 180 physical minutes**.

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **DST-1** Gridding the gap | 15-min grid, duration 15, no bookings | Exactly **12** candidates. Labels: `01:00, 01:15, 01:30, 01:45, 03:00, 03:15, 03:30, 03:45, 04:00, 04:15, 04:30, 04:45`. No `02:xx` label exists. Starts are `07:00Z…09:45Z` at a uniform 15-min physical spacing | Generating on the *wall-clock* axis (`t = t.plus({minutes:15})` on a `PlainTime`) emits four phantom slots `02:00–02:45` and, because it stops at wall-clock 05:00 after 16 steps, drops `04:00–04:45`. Off by four in **both** directions, and the four phantoms resolve — via `luxon`'s default forward-shift or `date-fns-tz`'s offset guess — to instants that duplicate `03:00–03:45`. You get four duplicate bookable instants and a guaranteed double-book |
| **DST-2** Window length | Same | `meta` reports 180 minutes of window, not 240 | `close.hour − open.hour` = 4h. Any capacity or utilization math (P1-2) built on wall-clock subtraction over-reports this day by 25% and the "utilization within 1% of hand-calculated" success metric fails on two days a year |
| **DST-3** 90-min service at 01:30 | duration 90, start `01:30 CST = 07:30Z` | Valid. Ends `09:00Z` = **04:00 CDT**. UI must render "1:30 AM – 4:00 AM". Elapsed is 90 physical minutes; the wall clock advances 2h30m | Two failures. (a) Computing the end as `PlainTime 01:30 + 90min = 03:00` and resolving → `08:00Z`, a 30-minute appointment. (b) A UI that computes duration from the labels and displays "150 min". The service must be added on the **instant** axis, always |
| **DST-4** Last valid start, 90-min | duration 90, buffer 0 | Last start = `08:30Z` = **03:30 CDT**. Total 7 starts | Wall-clock "last start = close − duration = 05:00 − 1:30 = 03:30" gets the right *label* by luck. Change the service to 100 minutes and it gives `03:20`, which is off-grid, while the truth is `08:20Z`. Do not let the coincidence validate the method |
| **DST-5** Last valid start, 60-min | duration 60 | Last start = `09:00Z` = **04:00 CDT**. Total 9 starts | — |
| **DST-6** DST-day conservation | Compare with 2026-03-01, same window, 60-min | Non-DST day yields **13** starts; DST day yields **9**. Difference is exactly 4 = 60 min ÷ 15 | A single-day test can't catch a systematically wrong grid. The *delta* between an ordinary day and the transition day is the assertion with teeth |
| **DST-7** Window straddling the gap, split rows | Two window rows `01:00–02:00` and `03:00–04:00` | Must be unioned into ONE window `07:00Z–09:00Z`. A 90-min service starting `07:15Z` (01:15) is **valid**, ending `08:45Z` (03:45) | Union performed on the wall-clock axis sees a 1-hour hole between 02:00 and 03:00 and keeps two windows. Invariant §2.10 then rejects any slot crossing `08:00Z`. You silently lose every long booking on the transition morning. **Union after resolution, never before** |
| **DST-8** Explicit slot inside the gap | Client POSTs a booking for local `02:30` on 2026-03-08 | Reject with `nonexistent-local-time`. Never coerce | `luxon` shifts it forward to `03:30`, `date-fns-tz` back to `01:30`, and native `Date` does something driven by `TZ`. All three "succeed" and book a time the customer did not choose, in a spot the engine never offered — bypassing availability entirely |
| **DST-9** Half-hour transition | `Australia/Lord_Howe`, 2026-10-04: `02:00 → 02:30` (**30-minute** shift) | 15-min grid handles it; labels skip `02:00, 02:15` only | Any code assuming DST shifts are whole hours, that offsets are whole hours (`Asia/Kathmandu` is +05:45), or that stores offsets as integer hours. Include one Lord Howe test to keep that assumption from ever being written |

### B. DST fall-back — 2026-11-01 (Sunday), 02:00 CDT → 01:00 CST, day is 25h

Ground truth: `01:00 CDT = 06:00Z` (first), `01:59:59 CDT = 06:59:59Z`, `01:00 CST = 07:00Z` (second), `02:00 CST = 08:00Z`.

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **FB-1** The doubled hour | Provider 00:00–06:00 local = `05:00Z–12:00Z` = 420 min, 15-min grid | **28** candidates (an ordinary day gives 24). Labels `01:00, 01:15, 01:30, 01:45` each appear **twice**, with `offset` `-05:00` then `-06:00` | Wall-clock iteration produces 24 and silently deletes one real, bookable, revenue-generating hour. Interval-subtraction code that dedupes by wall label deletes 4 slots |
| **FB-2** "01:30" in a booking link | Customer opens `…/book?day=2026-11-01&time=01:30` | The link is **undecidable** and must not exist. Slot identity is the instant: `…/book?slot=2026-11-01T06:30:00-05:00`. Reject any request keyed by wall time on an ambiguous day | Any URL, form field, or job payload carrying `{date, time}` is a 50/50 coin flip twice a year. This includes the P0-6 reschedule token payload and the P1-1 reminder queue. Audit every place a time is serialized without an offset |
| **FB-3** 60-min service, first 01:30 | start `06:30Z` | Ends `07:30Z`, which renders as **01:30 CST** — the appointment's end label equals its start label | A UI computing "is it over yet?" from labels concludes it ended before it began. Duration display, progress bars, and the day-view sort all need instants |
| **FB-4** 60-min service, second 01:30 | start `07:30Z` | Ends `08:30Z` = 02:30 CST. Distinct slot, distinct row, distinct id | Deduplicating candidates by label collapses these two into one and destroys an hour of capacity |
| **FB-5** Rendering a stored booking | Row with `startAt = 2026-11-01T06:30:00Z` | Must render "1:30 AM **CDT**", and the adjacent 07:30Z booking as "1:30 AM **CST**". Ship the abbreviation or offset in the label whenever `labelIsAmbiguous` | Without the disambiguator the staff day view (P0-7) shows two "1:30 AM" rows an hour apart with no visible difference. Staff conclude the app is broken — correctly |
| **FB-6** Day-view sort | Day view for 2026-11-01 | Sort by `start` (instant), never by label | Sorting by wall-clock string interleaves the two 01:xx blocks arbitrarily |
| **FB-7** Ambiguity policy | `policy.ambiguousLocalTime` | Test both arms. `'offer-both'` yields 28 candidates; `'offer-earlier-only'` yields 24 with the four CST repeats excluded as `nonexistent-local-time`… — *note this reason name is wrong for this case; add `'ambiguous-suppressed'`* | A library default silently choosing "earlier" (luxon) or "later" is a policy decision made by a dependency. Make it yours and test it |
| **FB-8** Booking crossing the transition | Booking `2026-11-01T05:30Z–08:30Z` (00:30 CDT → 02:30 CST) | 3 physical hours, wall clock advances 2. Blocks all candidates whose blocked range intersects `[05:30Z, 08:30Z)` — **12** on a 15-min grid, not 8 | Computing occupancy in wall-clock minutes under-blocks by an hour and leaves bookable slots inside an existing appointment |

### C. Bookings made before a transition, for a date after it

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **X-1** Offset-of-now | On 2026-03-01 (CST, −06:00) book 09:00 local on 2026-03-15 (CDT, −05:00) | Store `2026-03-15T14:00:00Z` | Computing the offset *once* from "today" and applying it to a future date stores `15:00Z`, and the appointment renders at 10:00 on the day. The offset must be looked up **for the target instant**, which is circular — resolve it via the tzdata rule engine (`resolve(day, time, zone)`), not by arithmetic. Caching a per-business offset in Redis, a config file, or a React context is the same bug with a longer fuse |
| **X-2** Weekly generation across the boundary | Generate "every Tuesday 09:00" from 2026-03-03 for 8 weeks | Every occurrence is 09:00 local. Offsets differ before and after 2026-03-08 | `nextWeek = new Date(prev.getTime() + 7*86400e3)` is right on the physical axis and wrong on the calendar. After the transition, every occurrence lands at 08:00 local and drifts permanently. Iterate on `PlainDate.add({weeks:1})`, then resolve each day independently |
| **X-3** 24h reminder across a transition | P1-1 reminder for 2026-03-08 09:00 (`14:00Z`) | Fires at `2026-03-07T14:00Z` = **08:00 local** on Mar 7 — a physical 24 hours. Document this as intended | Both interpretations are defensible; the failure is having *no* documented interpretation, so the query and the test each pick one. Use physical 24h (simple, instant-based) and assert the local label in the test so the artifact is visible |
| **X-4** Cron drift | Reminder worker scheduled "daily 09:00 server time" | Job scheduling must be instant/interval based (`every 5 minutes`, query `startAt BETWEEN now+24h AND now+24h+5m`) | A daily wall-clock cron runs twice or zero times on transition days in a DST server zone. Run workers with `TZ=UTC` and an interval trigger |
| **X-5** tzdata itself changes | A booking 8 months out in a zone whose government abolishes DST (Mexico 2022, Brazil 2019, Iran 2022) | Storing only the instant means the appointment silently moves an hour on the wall clock. Mitigation: persist `(startAt, originCalendarDay, originWallTime, originZone, tzdataVersion)` and run a reconciliation job after every tzdata bump that reports drifted rows for human decision | This is the one failure mode "store UTC" cannot survive, and it is invisible until a customer shows up an hour early. Worth 20 lines of schema. Also: `Morocco` shifts twice a year on lunar-calendar dates — its rules change *every year* |

### D. Three-way timezone: business ≠ server ≠ browser

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **TZ-1** Server zone leakage | Full suite under `TZ=Pacific/Kiritimati` (UTC+14) and `TZ=Pacific/Niue` (UTC−11) | Byte-identical results | **Run CI at a hostile offset, not UTC.** Under `TZ=UTC` a stray `new Date('2026-03-08')` or `getHours()` produces the correct answer and the bug ships. A UTC+14 job catches every axis-crossing on the first run. Two extra CI matrix entries; highest defect-per-line ratio in this document |
| **TZ-2** Where each zone legitimately appears | — | **Business zone**: all computation, all storage conversion, the primary label, the ICS `TZID`, staff views, reports. **Server zone**: nowhere — pin `TZ=UTC` in Docker/Fly/Vercel config and assert `process.env.TZ === 'UTC'` at boot. **Browser zone**: exactly three places — (1) a secondary line "11:00 AM CST · 5:00 PM your time (Europe/London)", (2) the calendar-download hint, (3) nothing else | — |
| **TZ-3** The forbidden use | Customer in `Asia/Tokyo` browses "March 8" | They must receive the business's March 8. The `day` parameter is never derived from the browser | Client code doing `new Date().toISOString().slice(0,10)` to seed the date picker shows a Tokyo customer March 9's slots labelled March 8. They book, arrive a day late, and the bug is indistinguishable from user error |
| **TZ-4** The past check | Customer in `Pacific/Auckland` at their local 2026-03-09 09:00 | "Is this in the past" is instant vs instant. No zone participates | Comparing formatted local strings makes slots vanish or persist depending on which side of UTC the customer is |
| **TZ-5** Provider zone ≠ business zone | A provider who lives in a different zone from the salon | v1: not supported; provider hours are always business-zone. Assert this in a test with a comment | Silently interpreting provider hours in some other zone is worse than not supporting it. If a later version adds it, the `windows` type grows a `zone` field and every window resolves independently — the signature already permits that |
| **TZ-6** DB session timezone | Postgres session with `TimeZone = America/New_York` | Every read/write of `timestamptz` is unaffected (Postgres stores instants); but `AT TIME ZONE`, `date_trunc('day', …)` and `::date` casts in any raw SQL **are** affected | Set `TimeZone=UTC` in the connection string, and grep for `::date` and `date_trunc` in raw queries. A reporting query grouping by `startAt::date` silently buckets by server-session-zone days |

### E. Working hours crossing midnight

**Does the model support it? Not without the `endsNextDay` flag in §1.2 — and the PRD does not mention it at all.** This is a gap you must close before implementation.

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **MN-1** The basic overnight shift | Provider works Fri **20:00–02:00** | One window, `endsNextDay: true`, resolving `open` against Friday and `close` against Saturday | With `{open, close}` and no flag, `close < open` is either a validation error (feature unsupported) or, worse, interpreted as a 22-hour window `02:00–20:00` if someone "helpfully" swaps them |
| **MN-2** The two-row workaround and why it fails | Model as `Fri 20:00–24:00` + `Sat 00:00–02:00` | Fails four ways: (a) `24:00` is not a valid `PlainTime` (max `23:59:59.999999999`) so you need a sentinel; (b) a 60-min service starting 23:30 is rejected — it exceeds Friday's close — unless you union the two rows into one instant range **first**; (c) a date-specific override for "Friday night" must now touch two calendar dates and stay consistent; (d) the Saturday day view shows a 00:30 appointment staff think of as Friday night | The union in (b) is the same requirement as DST-7, which is a good sign the union step is fundamental rather than a special case. Do it once, correctly, on the instant axis |
| **MN-3** Which day does the slot belong to? | Query `day = 2026-06-05` (Friday), window `20:00–02:00` | Slots at `00:30` on Jun 6 are returned by the Jun 5 query with `label.day = '2026-06-06'`. The Jun 6 query must **not** return them again | Without an explicit ownership rule, an overnight slot appears in both days' results and gets double-counted in utilization — or in neither and is unbookable. Rule: **a slot belongs to the calendar day of the window that produced it.** Assert the non-duplication, it is the part everyone forgets |
| **MN-4** Overnight + DST | Fri 2026-03-07 20:00 → Sat 2026-03-08 02:00 | Window is `2026-03-08T02:00Z` to `2026-03-08T08:00Z`. Note `02:00 local on Mar 8` is **valid** (the gap begins at 02:00 and the window is end-exclusive, so it closes exactly at the instant the gap opens) — 6 physical hours, 24 candidates | The interaction of `endsNextDay` with a transition on the *second* day is where hand-rolled offset math dies. This case is worth writing even though the answer is unremarkable, because it pins the boundary |
| **MN-5** Overnight + fall-back | Fri 2026-10-31 20:00 → Sat 2026-11-01 02:00 | `2026-11-01T01:00Z` to `2026-11-01T08:00Z` = **7** physical hours, 28 candidates, four doubled labels | Combines MN and FB. If MN-1 and FB-1 both pass but this fails, your union step is resolving `close` with the wrong day's offset |
| **MN-6** If you decide not to support it | Explicitly reject `close <= open` at write time with a clear admin error | Acceptable for v1 for a salon | The unacceptable outcome is *accidentally* not supporting it — accepting the row and producing zero slots with no error, so the provider sees an empty calendar and no explanation |

### F. Month, year, and recurrence boundaries

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **CB-1** Month range query | "Show October 2026" | Instant range `[2026-10-01T05:00Z, 2026-11-01T05:00Z)` — **and note the endpoints have different offsets is *not* true here, but for a November query it is**: `[2026-11-01T05:00Z, 2026-12-01T06:00Z)` spans the fall-back and is 30×24+1 = 721 hours | Computing the range as `start + 30 days` in milliseconds, or applying one offset to both endpoints, drops or duplicates an hour at the boundary. Resolve **each endpoint independently** through the zone |
| **CB-2** Weekly weekday pattern across a month boundary | "Every Tuesday" from 2026-09-29 through 2026-11-03 | Occurrences on Sep 29, Oct 6, 13, 20, 27, **Nov 3**. Nov 3 is after the Nov 1 fall-back and must still be 09:00 local | Adding `7*86400e3` ms drifts to 08:00 from Nov 3 onward. Adding "1 month" and adjusting is worse. Iterate calendar days; resolve each |
| **CB-3** Year boundary | 2026-12-31 (Thu) → 2027-01-01 (Fri) | Continuous slot generation across the boundary | — |
| **CB-4** The `YYYY` week-year trap | Any date formatting near Jan 1 | Never key a recurrence on ISO week number; key on weekday | In `date-fns` and `moment`, `YYYY` is **week-year** and `yyyy` is calendar year. `format(2026-12-31, 'YYYY-MM-dd')` yields `2027-12-31`. This has caused real production outages. If you use `date-fns` anywhere, add a lint rule banning the `YYYY` and `DD` tokens outright |
| **CB-5** Recurring-appointment anchor (P2) | "Every 4 weeks, Tuesday 09:00" starting 2026-09-29 | 28-day calendar steps, each independently resolved. This is precisely why the PRD says slot computation must be a pure function — generate the candidate days, then run the engine per day | Materializing 12 future occurrences as instants at creation time bakes in today's offset (see X-1) for all of them |

### G. Leap day

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **LD-1** Weekly pattern on a leap day | **2028-02-29 is a Tuesday** (verified). Provider works Tuesdays 09:00–17:00 | Full normal slot set on 2028-02-29 | Day iterators built on `setDate(d.getDate()+1)` are usually fine; iterators built on month arithmetic or on a hardcoded 28-day February are not. Also catches any `Feb has 28 days` table |
| **LD-2** Override on a non-existent Feb 29 | Admin submits a date-specific override for `2027-02-29` | **Throw at write time.** `2027-02-29` is not a date | `new Date(2027, 1, 29)` → **Mon Mar 01 2027** (verified). JS overflow-normalizes silently, so the salon closes on the wrong day and nobody can explain why. Applies equally to `2026-04-31` and `2026-06-31` — validate with `PlainDate.from(s)` in `overflow: 'reject'` mode, which throws |
| **LD-3** Annual recurrence on Feb 29 | "Closed every Feb 29" | Undecidable in non-leap years. Forbid annual recurrences on Feb 29, or require an explicit `nonLeapBehavior: 'feb-28' \| 'mar-1' \| 'skip'` | Silently defaulting means the business is closed on the wrong day 3 years in 4 |
| **LD-4** Reschedule "one year out" from Feb 29 | 2028-02-29 + 1 year | Must resolve explicitly (2029-02-28 or 2029-03-01), never crash, never normalize silently | Temporal's `add({years:1})` uses `overflow: 'constrain'` by default → 2029-02-28. That is a reasonable answer, but it must be a *chosen* answer with a test, not a library default nobody read |
| **LD-5** Leap day + DST | Confirm 2028-02-29 is before the 2028 US transition (2nd Sunday of March) | No interaction; assert it so the case is closed | — |

### H. Buffers

**The PRD gives services a `buffer_after` only. Two decisions the PRD does not make, which you must make now:**

> **Recommendation, and the reason:** the PRD states buffers exist "so that back-to-back bookings don't collide in practice." That purpose implies buffers are about *booking vs booking*, not about the provider's own rest. Therefore:
> - **Buffer blocks against other bookings — yes**, always. This is the whole point.
> - **Buffer may overlap a break — yes** (default `true`). Turnaround can happen during lunch; forbidding it costs real bookings for no operational reason.
> - **Buffer may extend past closing — yes** (default `true`). Refusing the last appointment of the day because cleanup runs 15 minutes past close is pure lost revenue.
> - **The service body itself may never** overlap a break or pass closing. That's §2.11 / §2.12.
>
> Both permissive rules are `SlotPolicy` flags with a test each way, because this is the rule most likely to be reversed by the business owner in week two.
>
> **Add `bufferBefore` now, defaulted to 0, even though the PRD omits it.** Setup time is real (station prep, room turnover, HVAC tech drive time). Retrofitting it later changes the meaning of every stored interval and of the P0-4 database constraint — a migration you do not want.

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **BF-1** PRD's own example | Booking 10:00–11:00, service 60 min, buffer-after 15 | Blocked `[10:00, 11:15)`. `11:00` unavailable; **`11:15` is the first offered slot** | Matches PRD acceptance criterion exactly. Make it test #1 |
| **BF-2** Whose buffer is whose | Preceding booking B (60 min, buffer-after 15) at 10:00; candidate service S (60 min, buffer-after 10) | B blocks `[10:00, 11:15)`. S at 11:15 occupies `[11:15, 12:25)` — its own body plus **its own** buffer. Not 15, not 25 | Applying the *service being booked*'s buffer to the *existing* booking, or vice versa, gives 11:10 or 11:15 depending on which you got wrong, and only differs when the two buffers differ. Deliberately make them differ in every buffer fixture — equal buffers hide the bug |
| **BF-3** Half-open boundary equality | B1 10:00–11:00 buf 15 (blocks to 11:15); B2 11:30–12:00 buf 0. Book a 15-min service, buf 0 | Fits **exactly** at 11:15, occupying `[11:15, 11:30)` and abutting B2 | The single most common off-by-one in scheduling. With closed intervals, `end === start` reads as a collision and the slot vanishes; the salon loses every perfectly-fitting gap. **All intervals half-open `[start, end)`, everywhere — engine, database range type, and tests** |
| **BF-4** Buffer collides with the next booking | Same as BF-3 but the 15-min service has buffer-after 5 | Occupies `[11:15, 11:35)`, intersects B2 → **excluded**, reason `overlaps-buffer` | Checking only the service body against following bookings lets the buffer be eaten and produces exactly the "back-to-back collision" the PRD's buffer feature exists to prevent |
| **BF-5** Two adjacent bookings, different buffers | B1 10:00–11:00 buf 15; B2 11:15–12:00 buf 30 | Zero gap. No slot between them at any duration | Summing buffers, or applying a single global buffer, produces a phantom gap or an over-wide block |
| **BF-6** Buffer past closing | Window closes 17:00; service 60 min, buffer-after 15; candidate 16:00 | Body `[16:00, 17:00)` fits. Buffer to 17:15. **Offered** under the default policy; excluded under `bufferMayExtendPastClose: false`. Test both | Whichever way you go, the untested arm is the one the owner will ask for |
| **BF-7** Buffer overlapping a break | Break 12:00–13:00; service 45 min buf 15; candidate 11:00 | Body `[11:00, 11:45)` clears the break. Buffer to 12:00 — abuts, fine. Candidate 11:15: body to 12:00 (abuts break, fine), buffer to 12:15 (inside break) → offered under the default, excluded when `bufferMayOverlapBreak: false` | The abutting sub-case (11:00) is a half-open test in disguise; if it fails, BF-3 is broken too |
| **BF-8** Buffer at the start of the day | `bufferBefore` 15, window opens 09:00, candidate 09:00 | `blockedStart` = 08:45, before open. Under the symmetric policy: **offered** | If you implement `bufferBefore` and forget the symmetry, the first slot of every day disappears |
| **BF-9** Buffer vs time off | Ad-hoc block 14:00–15:00; service ending 14:00 with buffer-after 15 | Time off is absolute: the *body* must clear it (§2.14). Whether the buffer may overlap follows the break rule. Document explicitly | Time off and breaks are semantically different (one is the provider's schedule, one is an exception) and get treated identically by accident |

### I. Grid vs duration — non-dividing cases

**The concept that must be stated in code comments or it will be re-broken:** *the grid is the set of candidate **start** times, not a partition of the day.* Slots overlap each other. Booking one candidate removes several.

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **GR-1** 50-min service on a 15-min grid | Window 09:00–17:00, buffer 0 | Starts at 09:00, 09:15, … last valid start **16:00** (`16:00+50=16:50 ≤ 17:00`; `16:15+50=17:05` overruns). **29 slots**, mutually overlapping | The tiling implementation (`t += duration`) yields 09:00, 09:50, 10:40, … — misses 09:15, drifts off the 15-min grid, and produces exactly 9 offers instead of 29. Customers see a sparse, arbitrary-looking calendar and the salon loses bookable starts |
| **GR-2** Booking removes multiple candidates | Same, plus a booking 09:15–10:05 | Removes candidates **09:00, 09:15, 09:30, 09:45, 10:00** (every start `s` with `s ∈ (08:25, 10:05)`). Next offer is **10:15** | The #1 real defect in DIY slot engines: removing only the candidate whose start *equals* the booking's start leaves 09:30 bookable **inside an existing appointment**. It survives review because the demo data uses 60-min services on a 60-min grid where the bug is invisible. Never write a fixture where duration equals interval |
| **GR-3** 20-min service on a 15-min grid | Window 09:00–17:00; booking 09:00–09:20 | Blocks candidates 09:00 and 09:15. Next is **09:30**. A permanent 10-minute dead zone at 09:20–09:30 | Expected and acceptable — but the P1-2 utilization metric must classify those 10 minutes as **unbookable**, not idle, or utilization reads artificially low and the owner "fixes" a non-problem |
| **GR-4** Interval > duration | 60-min grid, 15-min service | Sparse offers on the hour. Legal | Guards against a hidden `assert(interval <= duration)` |
| **GR-5** Duration equal to the whole window | Window 09:00–10:00, service 60 min | Exactly one slot at 09:00 | Off-by-one at `start + duration === close`: with a `<` test instead of `<=`, the only slot of the day vanishes |
| **GR-6** Duration one minute over | Window 09:00–10:00, service 61 min | Zero slots, reason `crosses-window-close` on the single candidate | Pairs with GR-5 to pin the boundary |
| **GR-7** Grid anchor choice | Window 09:07–17:00, 15-min grid | With `anchor: 'window-open'`: 09:07, 09:22, 09:37… With `'local-midnight'`: 09:15, 09:30… **Recommend `'window-open'`** | `'local-midnight'` is fragile on DST days: the wall-clock distance from midnight to open changes by an hour, so the whole grid shifts on two days a year and the day's slot times differ from every other day. `'window-open'` is stable because the anchor is an instant derived from the window itself |
| **GR-8** Compaction mode | Booking ends 10:05; should 10:05 be offered as an extra candidate? | v1: **no**, fixed grid only. If added later as `'grid+compact'`, the extra anchors must be sorted and deduped or §2.3 (order-insensitivity) breaks | Ad-hoc "also offer the end of each booking" logic makes output depend on the input array's order — a heisenbug that only appears when the ORM changes its default sort |

### J. Breaks, time off, and date-specific overrides

**Precedence, stated once and tested as a chain:**

```
windows(day) = overrides(day).exists ? overrides(day).windows : weekly(weekday(day))
   → subtract breaks (children of each window)
   → subtract time off        (absolute)
   → subtract buffered bookings
   → subtract [−∞, now + leadTime)
```

**A schema trap this exposes:** you cannot represent "closed on July 4" as *an override day with zero window rows*, because that is indistinguishable from *no override at all* — and then the weekly pattern applies and the salon is open on a holiday. You need a parent `DateOverride { day, isClosed }` record with child windows. Get this into the Prisma schema before writing the engine.

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **OV-1** PRD's own case | Tue 09:00–17:00 with a 12:00–13:00 break | No slots render 12:00–13:00. A 60-min service's last morning start is 11:00 | PRD acceptance criterion. Test #2 |
| **OV-2** Break exactly abutting a booking | Booking 10:00–11:00 (buf 0); break 11:00–11:30 | No overlap (half-open). A 30-min service is **excluded** at 11:00 (inside break) and **offered** at 11:30 | Closed-interval logic reports a phantom booking/break conflict and may throw a "data inconsistency" error on legitimate data |
| **OV-3** Break entirely inside a booking | Booking 11:30–13:00; break 12:00–12:30 | No crash, no double subtraction. Available minutes for the window decrease by 90, not 120. Staff view may flag it as odd data | `available = window − Σbreaks − Σbookings` double-subtracts and can go **negative**, breaking the P1-2 utilization percentage (which then exceeds 100% or divides by a negative). **Union the busy set first, then measure** |
| **OV-4** Overlapping time-off records | Time off Jan 10–15 and Jan 12–20 | Union → Jan 10–20. Nine days are not subtracted twice | Same as OV-3; time-off records overlap constantly in practice because staff enter them from two devices |
| **OV-5** Adjacent time-off and the inclusive-end trap | Time off "Jan 10 to Jan 15" | Store as half-open `[2026-01-10, 2026-01-16)`. The staff UI displays "through Jan 15" by subtracting a day | Half the industry stores an inclusive end date and half exclusive; whichever you pick, the *other* convention appears in the UI. Store half-open (consistent with every other interval in this system) and convert at the presentation layer, with the conversion in one function and a comment explaining why |
| **OV-6** Override that **removes** granted hours | Weekly: Sat 09:00–15:00. Override for 2026-07-04: `isClosed = true` | Zero slots. Weekly pattern does not leak through | With windows-only overrides, "closed" is unrepresentable (see the schema trap above) and the holiday silently doesn't happen |
| **OV-7** Override that **adds** hours | Weekly: Sunday closed (no rows). Override for 2026-12-20: 10:00–14:00 | Full slot set. The absence of a weekly pattern must not short-circuit the whole computation | A guard like `if (!weeklyPattern) return []` placed before override resolution kills every added-hours day. Very common, because the guard looks like defensive programming |
| **OV-8** Override narrows hours | Weekly: 09:00–17:00. Override: 09:00–12:00 | Replacement, **not intersection or union**. Slots end at 12:00 | "Merge" semantics quietly gives the union (09:00–17:00) and the provider gets booked in the afternoon they took off |
| **OV-9** Override day and breaks | Weekly window 09:00–17:00 with a 12:00–13:00 break; override 09:00–14:00 with no break | No break on the override day. Breaks are children of windows; replacing windows drops their breaks | If breaks are modelled per-*day* rather than per-*window*, the weekly lunch break haunts the override day and nobody can delete it |
| **OV-10** Override + time off, contradictory | Override says open 09:00–17:00; a time-off record covers the whole day | Zero slots. Time off wins — it is downstream in the chain | Without an explicit ordering, whichever query runs last wins, and the answer changes when someone reorders the code |
| **OV-11** Ad-hoc block over an existing booking (User Story 9) | Provider blocks 14:00–16:00; a booking already exists 14:30–15:30 | Engine: no new slots in that range. Separately, the API must **return the conflicting bookings** so staff can act. The engine does not resolve the conflict — it is a pure function and has no opinion | Silently letting the block "win" makes the booking invisible while it still exists in the database and still sends a reminder. The customer arrives to a closed shop |
| **OV-12** Time off given as instants vs calendar days | Full-day time off entered as "Mar 8", partial as "Mar 8 14:00–16:00" | Two distinct input shapes. Full-day must resolve to the **full 23-hour** local day on 2026-03-08, not a hardcoded 24 hours | `startOfDay + 24h` overshoots into the next day on spring-forward and undershoots on fall-back, so a full day off leaks an hour of bookable time — or eats an hour of the next day |

### K. The "now" boundary and lead time

> **Finding — a genuine product bug derivable from the PRD as written.** P0-5 sets a cancellation cutoff of 2 hours before start. P0-3 has **no minimum booking lead time**. Therefore a customer can book a slot starting 5 minutes from now and be **instantly unable to cancel it**, because it is already inside the cutoff window. They are trapped in a booking they made 5 seconds ago, and their only recourse is to phone the salon — which is the exact problem the product exists to eliminate. Add `minimumLeadMinutes` and enforce **`minimumLeadMinutes >= cancellationCutoffMinutes`** as a configuration invariant validated at startup. Recommended default: 120 minutes, matching the cutoff.

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **NW-1** Slot starting in 30 seconds | `now = 09:59:30`, candidate 10:00, `lead = 0` | Offered. With `lead = 120`, excluded, reason `inside-lead-time` | With `Date.now()` inside the engine the test is unwritable, so it never gets written |
| **NW-2** Exact boundary | `start === now + lead`, to the millisecond | **Offered** (`>=`) | `>` silently drops one slot; nobody notices for a year |
| **NW-3** Exact boundary minus 1 ms | `start === now + lead − 1` | Excluded | Pins NW-2 |
| **NW-4** `now` mid-slot | `now = 10:07`, candidate 10:00 already in progress | Excluded — `start < now`, no partial slots | Filtering on `end > now` offers a slot the customer is already 7 minutes late for |
| **NW-5** `now` after close | `now` = 18:00, window closed at 17:00 | `[]`, not an error, not negative | Unsigned/underflow arithmetic in a "remaining minutes" calculation |
| **NW-6** `now` far in the future | `now` = next year | `[]` | Guards against `Math.abs` used somewhere in the past check |
| **NW-7** Single clock source | One `now` stamped per HTTP request, threaded to the engine and to the booking validation | Two different `now` values inside one request widen the TOCTOU window and make the race test non-reproducible | Each layer calling `Date.now()` independently. Stamp once at the route boundary |
| **NW-8** TOCTOU between list and book | Customer lists at T, submits at T+90s, `lead = 120` | The booking write **re-validates** against the engine with a fresh `now`, inside the transaction, and rejects. The list response is advisory | Trusting the client's asserted slot. Also the reason §4's re-validation must be inside the transaction, not before it |

### L. Degenerate, zero, negative, and contradictory input

| Case | Setup | Expected | Why it breaks naive implementations |
|---|---|---|---|
| **DEG-1** `intervalMinutes = 0` | — | **Throw** `InvalidSlotQuery` | `while (t < end) t += 0` never terminates. This is a hung CI job and, in production, a pegged CPU and a dead worker. Highest-severity item in this section |
| **DEG-2** `durationMinutes = 0` | — | **Throw** | A zero-length half-open interval overlaps nothing, so it is bookable everywhere including inside other bookings — infinite phantom availability |
| **DEG-3** Negative duration / buffer / interval / lead | — | **Throw** each | A negative buffer *shrinks* the blocked range and permits overlapping bookings. Constrain at the type boundary (Zod `.int().positive()`), not in the engine |
| **DEG-4** Non-integer minutes | `duration = 30.5` | **Throw** | Float minutes → float millis → grid alignment (§2.7) fails by rounding and slot starts drift |
| **DEG-5** Service longer than any window | 8-hour service, windows are 4 hours | `[]` with `crosses-window-close` on every candidate — **not** a throw | Legitimate business state (an admin misconfigured a service). Throwing turns a config error into a 500 on the public booking page |
| **DEG-6** Provider with no hours at all | `windows: []` | `[]` | An unguarded `windows[0]` throws; with `noUncheckedIndexedAccess` it is a compile error instead |
| **DEG-7** Zero-length window | `open === close`, `endsNextDay: false` | `[]`, no crash. (Distinct from DEG-9's `close < open`) | `while` loops that assume at least one iteration |
| **DEG-8** Busy interval outside the day | A booking from three weeks ago in `busy` | Accepted, ignored, no error | The inverse failure is the dangerous one: a booking from **23:30 the previous night** running to 00:30 that the repository excluded because it filtered `WHERE date(startAt) = :day`. The engine then offers 00:00 and you double-book. Test the repository query with an overnight booking fixture, not just the engine |
| **DEG-9** `close < open`, `endsNextDay: false` | Window `17:00–09:00` | **Throw** | Silently swapping gives a 16-hour window; silently returning `[]` gives an unexplained empty calendar |
| **DEG-10** Busy interval with `end <= start` | — | **Throw** | Inverted intervals make overlap tests return `false` for everything, disabling conflict detection entirely and silently |
| **DEG-11** Duplicate identical bookings | Same interval twice in `busy` | Idempotent — same result as once | Count-based occupancy logic |
| **DEG-12** Invalid zone | `'CST'`, `'UTC-6'`, `'America/Chicagoo'` | **Throw**. Reject abbreviations and fixed offsets specifically | `Intl.DateTimeFormat` throws on garbage but **accepts** `'UTC'` and some `Etc/GMT±N` forms, which are fixed-offset and therefore DST-blind — a business configured as `Etc/GMT+6` looks fine all year and breaks twice |
| **DEG-13** Enormous range | Caller loops 365 days | Engine stays pure and per-day; the **caller** fetches all constraints once and slices. Document the O(days × candidates × constraints) shape | Per-day queries inside the loop is 365 round trips per calendar page load |
| **DEG-14** Cancelled bookings in `busy` | A `cancelled` appointment passed in | Its time is **free** | Caller contract, but assert it in the repository test. Corollary: `no_show` and `completed` still **occupy** — the appointment happened, or the time was held. Getting `no_show` wrong retroactively opens a slot in the past, which is harmless, and forward-dated it is not |

---

## 4. Concurrency specification (P0-4)

### 4.1 Mechanism comparison

| Mechanism | Catches | Fails to catch | Verdict |
|---|---|---|---|
| **`SELECT … FOR UPDATE` on the provider row** | Everything, *if every write path takes the lock* — the availability check runs under the lock, so the check-then-act is atomic | Nothing logically. Fails **operationally**: it is enforcement by convention. One new code path, one admin script, one `psql` session, one background job that forgets the lock, and the invariant is gone with no error. Also serializes all bookings per provider (fine at 4 providers, a hot row at 400), and risks deadlock if a reschedule touches two providers without a canonical lock order | Acceptable fallback if you cannot run raw migrations. Not the primary |
| **Unique index `(providerId, startAt)`** | Two bookings with the *identical* start | **Partial overlap** — the dominant case. A 50-min service at 09:15 and another at 09:30 have different starts and overlap by 35 minutes; the index is silent. Also blind to buffers. Also, without `WHERE status <> 'cancelled'` (a Postgres *partial* unique index), a cancelled booking blocks its own slot forever | Necessary-but-insufficient for conflict. **But genuinely valuable for a different job**: a unique index on a client-supplied `idempotencyKey` makes double-clicks and HTTP retries safe. Add it for that |
| **`EXCLUDE USING gist` + `btree_gist`** | Exact and partial overlap, per provider, enforced by the database against **every** code path — application, migration, psql, future services | Does **not** know about working hours, breaks, time off, lead time, or the past. It is a *double-booking* guard, not an *availability* guard — you still need the engine re-run inside the transaction. And it only sees the range you store, so buffers must be *in* that range | **Recommended.** This is the invariant of record |

### 4.2 The recommended design

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Appointment"
  ADD CONSTRAINT appointment_no_overlap
  EXCLUDE USING gist (
    "providerId" WITH =,
    tstzrange("blockedStart", "blockedEnd", '[)') WITH &&
  )
  WHERE (status <> 'cancelled');
```

Notes that will cost you a day each if you skip them:

- **`'[)'` is mandatory.** Half-open, matching §2 and BF-3. With `'[]'`, back-to-back appointments abut at a shared endpoint and are rejected as conflicts, and the salon can never book consecutive clients.
- **`blockedStart` / `blockedEnd` are stored columns** — `startAt − bufferBefore` and `endAt + bufferAfter` — written by the application (or a `BEFORE INSERT OR UPDATE` trigger), alongside `startAt`/`endAt` for display. *They cannot be Postgres generated columns:* I am fairly confident `timestamptz + interval` is marked `STABLE` rather than `IMMUTABLE` (its behaviour depends on the session `TimeZone` for interval components with month/day parts), which disqualifies it from `GENERATED ALWAYS AS … STORED` and from expression indexes. **Verify with `\df+ timestamptz_pl_interval` before committing to the schema.** `tstzrange(timestamptz, timestamptz, text)` *is* immutable, so the constraint expression above is fine. If the generated column does turn out to be permitted, prefer it — it removes a class of bug where the app writes an inconsistent blocked range.
- **The `WHERE status <> 'cancelled'` partial predicate is required**, or cancelled appointments block their slots permanently.
- **Prisma cannot express `EXCLUDE`.** Create the migration with `prisma migrate dev --create-only` and hand-edit the SQL. Add a schema comment so nobody regenerates it away. Expect `prisma db push` and drift detection to be unhappy; use `migrate` exclusively on this project.
- **Error mapping is a required task, not a nicety.** The violation is SQLSTATE **`23P01` (`exclusion_violation`)**, *not* `23505` — so it will **not** surface as Prisma's `P2002`. My expectation is a `PrismaClientUnknownRequestError` carrying the driver error; I have not verified the exact class in the current Prisma version, so **write a test that provokes a real 23P01 and asserts your handler maps it to the domain error `SlotTaken` → HTTP 409**. Unmapped, the PRD's "clear *slot taken* error with refreshed alternatives" acceptance criterion becomes a 500 and the race test passes while the user experience fails.
- **A fourth option worth knowing:** `pg_advisory_xact_lock(hashtext(providerId || ':' || day))` — cheap, no schema change, auto-released at transaction end. Same convention-not-enforcement flaw as `FOR UPDATE`. Useful as a *throughput* optimization to avoid constraint-violation churn under load, never as the correctness mechanism.

### 4.3 Isolation level

**`READ COMMITTED`, and this is a consequence of choosing the constraint.**

With the exclusion constraint present, correctness does not depend on the snapshot. Two concurrent inserts for overlapping ranges: the second blocks on the first's uncommitted tuple (gist exclusion checks take an ordinary lock and wait), then either fails with `23P01` when the first commits, or proceeds when the first rolls back. That is precisely the desired behaviour and **it needs no retry loop.**

If instead you rely on SELECT-then-INSERT with no constraint, `READ COMMITTED` is **not** sufficient — this is textbook write skew, both transactions read a snapshot showing the slot free and both insert. You would need `SERIALIZABLE`, which brings SQLSTATE `40001` (`serialization_failure`) and a mandatory retry wrapper. **Prefer the constraint specifically so you never have to write that retry loop**, because a retry loop that nobody tests is a liability of its own.

If you do end up at `SERIALIZABLE`, the code must:
- retry the **entire** transaction including all reads (retrying only the write re-applies stale data);
- bound retries (3–5) with jittered backoff;
- retry `40001` and `40P01` (deadlock) **only** — `23P01` is a genuine conflict and terminal, retrying it just fails slower;
- be idempotent under retry, which is what the `idempotencyKey` unique index buys you.

Prisma specifics: set `isolationLevel` on `$transaction`; note the default interactive-transaction **timeout is 5 seconds**, and a lock wait under contention can exceed it and surface as `P2028`, which looks nothing like a conflict. Raise it deliberately and set `lock_timeout` so you get a fast, identifiable failure instead of a mystery timeout.

### 4.4 Why SQLite makes the race test pass for the wrong reason

Two independent reasons, both fatal to the test's meaning:

1. **SQLite permits at most one writer for the entire database file.** In rollback-journal mode a writer takes an EXCLUSIVE lock on the whole file; in WAL mode readers no longer block the writer, but there is still exactly **one** write lock database-wide. Two booking transactions therefore cannot interleave their read-check and write phases — the second either waits on `busy_timeout` or fails with `SQLITE_BUSY`. The window in which a check-then-act race exists is *physically closed by the storage engine*, not by your code.
2. **A single Node process with `better-sqlite3` is synchronous**, so the event loop serializes the "concurrent" requests before they ever reach the database. Your race test is running two operations strictly sequentially.

Consequently a naive `if (await isSlotFree()) await createBooking()` — with no lock and no constraint — **passes on SQLite and fails on Postgres**. SQLite converts a logical concurrency bug into a physical impossibility, so the test validates the harness rather than the code. Compounding it, SQLite has no `EXCLUDE` constraint at all, so the invariant cannot even be *declared*; the best available approximation is a trigger with a subquery, which is race-proof only because of the global write lock — i.e. for a reason that does not transfer.

> **This resolves the PRD's open question.** The PRD says "SQLite is enough… *non-blocking — start SQLite*." It is not non-blocking. P0-4's acceptance criterion and the "double-booking rate: 0 across the race-condition test suite" success metric are **unfalsifiable on SQLite** — the test cannot fail, so it measures nothing. Use Postgres from commit one. The cost is a `docker compose` file; the benefit is that the project's headline correctness metric means something.

### 4.5 A deterministic race test

The principle: **a race test must specify an interleaving, not sample one.** N concurrent requests with a `Promise.all` and a hopeful assertion is a flake generator — it passes on a fast machine, hangs on CI, and never tells you *which* interleaving it exercised.

Use two real connections and explicit happens-before edges enforced by deferred promises.

```ts
// Two connections. Prisma interactive transactions each hold one —
// set connection_limit >= 4 or the test deadlocks on the pool, not on the DB.
const deferred = () => { let r: () => void; const p = new Promise<void>(res => r = res); return { p, r: r! }; };

test('two transactions targeting the same slot: exactly one commits', async () => {
  const aHasRead = deferred();
  const bCommitted = deferred();

  const A = db.$transaction(async tx => {
    await assertSlotAvailable(tx, slot);   // reads; sees the slot free
    aHasRead.r();                          // ── edge 1: A has read
    await bCommitted.p;                    // ── edge 2: wait for B to commit
    return tx.appointment.create({ data: booking(slot) });   // must fail 23P01
  });

  const B = db.$transaction(async tx => {
    await aHasRead.p;                      // ── edge 1
    await assertSlotAvailable(tx, slot);   // reads the same free state
    const r = await tx.appointment.create({ data: booking(slot) });
    return r;                              // commits on return
  }).then(r => { bCommitted.r(); return r; });

  const [a, b] = await Promise.allSettled([A, B]);

  expect(b.status).toBe('fulfilled');
  expect(a.status).toBe('rejected');
  expect(toDomainError(a.reason)).toBeInstanceOf(SlotTaken);   // NOT a 500
  expect(await countAppointmentsAt(slot)).toBe(1);
});
```

Properties that make it deterministic: no `setTimeout`, no polling, no sampling. Every ordering constraint is an explicit `await` on a promise resolved by the other party. Wrap the whole test in a hard timeout so a hang **fails** rather than hanging CI.

Interleavings to script as separate tests:

1. **A reads, B reads, B commits, A writes** (above) — the canonical write skew. This is the test that fails without the constraint.
2. **A writes, B writes, A rolls back** → B must **succeed**. Proves the exclusion lock is released and that a failed attempt leaves no phantom block. Skipping this one is how you ship a system where every abandoned checkout permanently kills a slot.
3. **Partial overlap, not identical start** — A books 09:15–10:05, B books 09:30–10:20. Proves the unique-index approach is insufficient and the range constraint is doing the work.
4. **Buffer-only overlap** — bodies do not overlap, blocked ranges do. Proves the constraint is on `blockedStart/blockedEnd`, not `startAt/endAt`.
5. **Cancelled row does not block** — cancel, then book the same range. Proves the partial predicate.
6. **Reschedule vs new booking** targeting the same destination slot (§4.6).
7. **Same slot, different providers** → both must succeed. Proves `providerId WITH =` is present; without it you have accidentally serialized the entire salon.
8. **Idempotency**: the same `idempotencyKey` submitted twice returns the same appointment, not a conflict.

Keep a **separate, nightly** fuzz test firing 50 genuinely concurrent requests — but its assertion must be the SQL invariant, not a success count:

```sql
SELECT count(*) FROM "Appointment" a JOIN "Appointment" b
  ON a."providerId" = b."providerId" AND a.id < b.id
  AND a.status <> 'cancelled' AND b.status <> 'cancelled'
  AND tstzrange(a."blockedStart", a."blockedEnd", '[)')
   && tstzrange(b."blockedStart", b."blockedEnd", '[)');
-- must be 0
```

The deterministic tests prove the mechanism works; the fuzz test guards against a future code path bypassing it. They are not substitutes.

### 4.6 Reschedule atomicity

**Do it as a single `UPDATE` to a single row inside one transaction.** Not delete-and-insert, not cancel-then-book.

```ts
await db.$transaction(async tx => {
  const appt = await tx.appointment.findUniqueOrThrow({ where: { id } });
  assertTransitionAllowed(appt.status, 'booked');      // P0-5 state machine
  const slots = computeSlots({ ...ctx, now, busy: await busyFor(tx, appt.providerId, target) });
  assertOffered(slots, target);                        // re-run the engine, server-side
  await tx.appointment.update({
    where: { id },
    data: { startAt, endAt, blockedStart, blockedEnd, rescheduledAt: now },
  });
  await tx.appointmentChange.create({ data: { appointmentId: id, from: appt.startAt, to: startAt } });
});
```

Why `UPDATE` on the same row is the right primitive: the exclusion constraint checks the updated row against **other** rows, not against its own previous version. So moving a 60-minute appointment from 09:00 to 09:30 — where old and new ranges overlap each other by 30 minutes — does **not** false-conflict. Delete-and-insert loses that property in the general case and forces you to reason about statement ordering inside the transaction.

**Failure modes if written as cancel-then-book across two transactions** — all four are real and one is unrecoverable:

1. **The customer loses their slot for nothing.** Cancel commits, the new slot is taken in the interim by another customer, the rebook fails. The customer now has *no* appointment, and the original slot has been given away. This is strictly worse than doing nothing, and it is the most common complaint about home-grown reschedule flows.
2. **The cancellation notification fires.** Anything watching the status transition (P1-1's outbox, the confirmation mailer) sees a genuine cancellation and emails the customer "your appointment is cancelled" — possibly followed by nothing.
3. **The state machine makes it unrecoverable.** P0-5 declares `cancelled` terminal. You cannot roll the appointment back to `booked` without violating your own invariant, so recovery means creating a **new row with a new id**.
4. **Which kills the P0-6 reschedule link.** The tokenized URL in the customer's confirmation email points at the old appointment id. After a new row is created, that link is dead — the customer's only self-serve recovery path is gone at exactly the moment they need it. The two P0 requirements interact, and cancel-then-book is where they collide.

Two refinements:

- **Cancel-then-insert is fine *inside a single transaction*.** If you want an immutable event log (old row → `cancelled`, new row inserted), do both statements in one transaction with the cancel **first**: the partial predicate `WHERE status <> 'cancelled'` means the old row stops participating in the constraint as soon as its `UPDATE` executes, so the insert does not self-conflict. The distinction is not cancel-then-book vs update — it is *one transaction vs two*. Say that precisely in the code comment, or someone will "simplify" it back into two service calls.
- **For a genuine swap** (two appointments exchanging times), the intermediate state necessarily violates the constraint. Declare it `DEFERRABLE INITIALLY IMMEDIATE` and use `SET CONSTRAINTS appointment_no_overlap DEFERRED` inside just that transaction, so the check runs at commit. Do not make it `INITIALLY DEFERRED` globally — you want immediate failure everywhere else.
- **Lock ordering:** if a reschedule can move an appointment between providers, acquire row locks in a canonical order (sort by provider id) or you will deadlock under concurrency, intermittently, in production only.

---

## 5. Recommended library

**Use `Temporal`, via the `temporal-polyfill` package, restricted to the axis boundary.**

**Is `Intl.DateTimeFormat` sufficient on its own?** In principle yes — the tzdata is right there, and you can build a correct offset lookup with `formatToParts` plus the classic two-pass guess-and-correct. That is essentially what `date-fns-tz` is. In practice no, and for one specific reason: what you must not hand-roll is **gap and ambiguity semantics**. The two-pass algorithm has to make a choice on 2026-03-08 02:30 and on 2026-11-01 01:30, and hand-rolled versions make that choice implicitly, undocumented, and differently in each call site. That is the entire content of §3.A and §3.B.

**Why Temporal specifically:**
- `PlainDate` / `PlainTime` / `Instant` / `ZonedDateTime` are **separate types**, so §1.1's No-Mixing Law is enforced by the compiler rather than by code review. That alone would justify it — the sibling project's `@db.Date` incident is exactly the error this type system makes unrepresentable.
- `disambiguation: 'reject'` **throws** on both nonexistent and ambiguous local times. That is the correct default for a booking engine: fail loudly at the parse boundary rather than book someone at a time they did not pick. `'earlier'` / `'later'` / `'compatible'` are available when you deliberately want them (FB-7), and you write down which one and why.
- Calendar arithmetic (`PlainDate.add({weeks: 1})`) is on the calendar axis by construction, so CB-2 and X-2 cannot happen.
- `overflow: 'reject'` on `PlainDate.from` throws on `2027-02-29` instead of normalizing to March 1 (LD-2, verified: native JS gives `Mon Mar 01 2027`).

**Honest tradeoffs and costs:**
- **Node 22 does not expose Temporal natively** (verified: `typeof globalThis.Temporal === 'undefined'`). You are taking a polyfill dependency today. It is removable later without touching call sites, which is unusual and valuable for a dependency.
- **Bundle/runtime cost.** `temporal-polyfill` (the FullCalendar implementation) is substantially smaller and faster than `@js-temporal/polyfill` (the reference implementation); I would not quote you a byte count from memory — check the current numbers before committing if the client bundle matters. Server-side it is irrelevant.
- **Performance is a genuine concern in the hot loop.** Polyfilled `ZonedDateTime` operations are not cheap, and a 60-day calendar page across 4 providers is tens of thousands of operations. **Mitigation, which you should adopt regardless of library:** use Temporal *only* at the boundary — resolve the day's window opens/closes/breaks to `Instant`s once (a handful of calls per provider-day), then do **all** grid iteration, overlap testing, and buffer arithmetic on plain epoch-millisecond integers. Integer comparison is fast, trivially testable, and DST-proof by construction because the physical axis has no DST. This also keeps the engine's core free of any library at all, which is the right shape for a pure function.
- **Stage 3, not yet shipped everywhere.** The API surface has been stable for some time and is shipping in browsers, but it is not yet universally native. If your team's risk appetite forbids that: `luxon` is the mature alternative, well-tested and pleasant — but it has **no separate calendar-day type** (everything is a `DateTime`), so §1.1 becomes convention rather than compilation, and its default disambiguation is silent. If you choose luxon, you must wrap every zone conversion in your own `resolve()` returning the three-armed result, and ban direct luxon use outside that module. That is more discipline for less safety. **Do not use `date-fns-tz` for this project** — it is a thin `Intl` wrapper whose behaviour in gaps and ambiguous hours is the least explicit of the three, which is precisely the property that matters here.

---

## Appendix — items the PRD does not specify and must be decided before coding

1. **Minimum booking lead time** — absent entirely, and its absence creates the non-cancellable-booking bug (§3.K). Add `minimumLeadMinutes >= cancellationCutoffMinutes`, validated at startup.
2. **`bufferBefore`** — absent. Add it now, defaulted to 0; retrofitting changes the meaning of every stored interval and of the §4 constraint.
3. **Overnight working hours** — the model has no `endsNextDay`. Either add it or reject `close <= open` explicitly at write time (§3.E).
4. **"Closed" as a date override** — unrepresentable without a parent `DateOverride { day, isClosed }` record (§3.J).
5. **Buffer policy** — may a buffer overlap a break? extend past close? Recommendations and defaults in §3.H; both need to be config flags with tests on both arms.
6. **Ambiguous-local-time policy** for fall-back day — offer both occurrences or only the first (§3.B, FB-7).
7. **Grid anchor** — recommend `'window-open'`; `'local-midnight'` is DST-fragile (§3.I, GR-7).
8. **SQLite vs Postgres** — the PRD calls this non-blocking. It is blocking for P0-4, and the answer is Postgres (§4.4).
9. **tzdata drift reconciliation** — store the originating `(day, wallTime, zone, tzdataVersion)` alongside the instant, and reconcile after tzdata updates (§3.C, X-5). This is the one failure that storing UTC alone cannot survive.
10. **CI must run the suite at a hostile offset** (`TZ=Pacific/Kiritimati`), not at UTC (§3.D, TZ-1). Two lines of CI config; catches an entire bug class on the first run.
