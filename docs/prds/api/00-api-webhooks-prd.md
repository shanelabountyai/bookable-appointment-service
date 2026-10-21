# 00 — PRD: Bookable Public API + Outbound Webhooks (build log gap: public API + webhooks)

**What:** a versioned, key-authenticated HTTP API over the shipped Bookable salon app, plus signed outbound webhooks so another system (a CRM, a payroll sheet, an n8n flow) learns about bookings as they happen without polling.
**Builder:** Solo, in Claude Code · item prefix **`W-`** (Bookable's own items stay `A-`, the MCP track's `M-`).
**Status:** v0.1 draft — 2026-10-20; **building on branch `w-track` (✅ items in §10; decisions in `DECISIONS.md` W-D1..).** Owner answers to §11 amend this file; `DECISIONS.md` (`W-D…` rows) outranks it once decisions are taken.
**Lives in:** this monorepo. Routes under `apps/web/app/api/v1/**` and `apps/web/app/api/jobs/webhooks`; a new `packages/api` only if the route handlers grow past one module per resource (default: no new package). Domain calls go to `packages/db` functions directly, exactly as `apps/mcp` does — never the web app's server actions.
**Card:** "NEW: a public API with idempotent writes, and outbound webhooks delivered at-least-once with signatures, retries and replay — which no other project on the log covers."
**Learning objectives:** API contract design (versioning, pagination, errors, idempotency), credential design for a *system* rather than a person, and the outbox-to-webhook pipeline: at-least-once delivery, HMAC signatures, backoff, dead-lettering, replay, and what "ordered" can honestly mean.

---

## 1. Problem statement

Bookable has three ways in: the desk, the customer's manage link, and the MCP server for an assistant acting for a staff member. All three are a *person*. A salon also has systems that need to know what happened — a CRM that wants every new client, a bookkeeping sheet that wants completed visits, an automation that texts the owner when a no-show lands. Today those systems have no door at all: screens are not a contract, the MCP server authenticates a person, and nothing tells an outside system that anything changed.

What changes when the caller is a system, not a person:

- A system **retries on timeouts**, so a `POST` that is not idempotent books twice.
- A system **runs unattended**, so an error has to be machine-readable, and a credential has to be revocable without deactivating a human.
- A system **polls** unless it is told, and polling a Neon database that is meant to scale to zero (D-78) is the one cost the demo cannot afford.
- A system that is told must assume it will be told **more than once** and sometimes **out of order**, and the sender has to say that out loud rather than pretend.

## 2. Goals

1. An integration with an API key can list services, providers and open times, read a day, read and search clients, and **book, reschedule and cancel** — and every resulting row is indistinguishable from a desk action except its recorded channel (`api`) and actor.
2. **Nothing the API writes skips the rules the desk follows.** Every write goes through the same `packages/db` functions (`bookAppointment`, `rescheduleAppointment`, `reassignAppointment`, `transitionAppointment`), so the exclusion constraint, D-8, D-31 and D-32 apply unchanged.
3. **Every write is idempotent by contract.** A `POST` without an `Idempotency-Key` is refused; a replay returns the first response; the same key with a different body is refused. Proven by a barrier-forced race, not a timing test.
4. **An integration only sees its own business**, and only the scopes its key carries. The business comes from the key, never from a parameter.
5. **Every appointment change reaches every subscribed endpoint at least once**, signed, within the dispatch window (§8), with retries, a dead-letter state, and replay from the staff UI. Delivery is derived from the append-only `AppointmentEvent` log, so a new event writer cannot forget to emit.
6. **Every error names what to do next**, in the same code vocabulary the MCP server already uses (§6), as `application/problem+json`.
7. (Builder goal) An OpenAPI document is generated from the same zod schemas the routes validate with, and a tiny reference receiver verifies a real delivery's signature end to end in the demo.

## 3. Non-goals

- **OAuth / third-party developer accounts.** v1 keys are issued by the owner for integrations the owner runs. No developer portal, no app marketplace.
- **Customer-facing API.** Customers keep the manage link. No `customer_token` actor over the API.
- **Overrides, column pushes, releases, merges, undo, staff and settings management, notes.** Same list as the MCP PRD §3, same reason: each needs a human looking at the grid, and notes are the likeliest carrier of injected text. Absent by decision.
- **Inbound webhooks** (receiving from other systems). Out of scope; the MCP server and this API are the inbound doors.
- **Ordered delivery guarantees.** Each event carries a per-business sequence number; the receiver orders. The sender never claims in-order arrival (§8).
- **Exactly-once delivery.** At-least-once, with an event id for the receiver to dedupe on. The writeup says so.
- **Multi-business.** Tenancy is enforced (§5) but no second business is built. Known ceiling carried over from M-track: the *public* side resolves its business with `findFirst()`; the API must never call those paths.
- **Real-time push to browsers.** That is Showcall Live's lesson, not this one.

## 4. Personas

- **Owner** — issues and revokes keys, registers endpoints, reads the delivery log, replays a failed delivery. The only human in this build.
- **The integration** — a script, an n8n flow, a CRM sync. Treated as a well-meaning but careless caller: it will retry, it will time out mid-request, it will replay old events.
- **The receiver** — whoever stands at the other end of a webhook. Treated as unreliable: it will 500, hang, return 200 then crash, and go dark for an hour.

## 5. Auth and scoping

- **Key per integration, not per person.** `ApiKey`: `businessId`, `label` ("HubSpot sync"), `keyHash` (SHA-256; prefix `bk_api_`, shown once), `scopes` (`read`, `write`), `issuedById` (owner), `lastUsedAt`, `revokedAt`. Issued and revoked on a new owner page `/staff/integrations`. Revoking a key does not touch any person.
- **Resolution on every request:** `Authorization: Bearer bk_api_…` → key (not revoked) → `businessId` + scopes. **No endpoint takes a `businessId`.** Unknown or cross-business ids return `NOT_FOUND`, never a hint they exist elsewhere.
- **Actor and channel.** Writes are recorded with the core actor `system`, `actorRef = apiKey.id`, and a new `EventChannel.api` (migration adds the enum value; `channelOf` and the source-scan test in `packages/db/event-channel.test.ts` are extended, per D-79). The detail panel renders "Booked via API (HubSpot sync)". *OQ-W1 asks whether `system` is the honest actor or whether `Actor` grows an `integration` value.*
- **Scopes.** `read` is required for every `GET`; `write` for every `POST`/`PATCH`/`DELETE`. A `read`-only key gets `FORBIDDEN_SCOPE` on a write, with the scope named.
- **Rate limit** per key through `consumeRateLimit` (`RateLimitCounter`, key `api:<keyId>`). Default 120 reads/min, 20 writes/min; `429` carries `Retry-After`.
- **Exempt from the demo Basic gate**, like `/api/mcp` (M-D15): the bearer travels in the same header.

## 6. API design rules (normative)

1. **Versioned path:** `/api/v1/…`. Breaking changes are a `/v2`, never a header. Additive changes (new optional fields) are not breaking and are listed in a `CHANGELOG` section of the OpenAPI description.
2. **Times.** Inputs are business-local wall time `YYYY-MM-DD HH:MM` resolved through `@bookable/core/time` (a DST gap or overlap is refused as `AMBIGUOUS_TIME` naming both readings), **or** an ISO-8601 instant with offset. Outputs always carry both: `startAt` (instant) and `startLocal` (wall time + the business's IANA zone). No `{date, time}` pair ever identifies a slot (D-4).
3. **Ids are opaque strings** that came from a previous response. Money is integer cents with a `currency` field (owner-only; `read` keys see prices only if the key has the `prices` scope — *OQ-W2*).
4. **Pagination** is cursor-based on every list: `?limit=` (≤100, default 25) and `?cursor=`; responses carry `nextCursor` or `null`. No offset pagination anywhere.
5. **Errors** are `application/problem+json` (RFC 9457): `type`, `title`, `status`, `detail`, plus `code` (the §6 MCP vocabulary) and `next` (`{ "endpoint": "GET /v1/availability", "why": "pick another time" }`). Domain errors are mapped once, in one module shared with `apps/mcp` (`packages/db/errors.ts` already owns the SQLSTATE mapping; the envelope shape is new). One test per code.

| Code | HTTP | When |
|---|---|---|
| `VALIDATION` | 400 | zod refused the body; `errors[]` names fields |
| `UNAUTHENTICATED` | 401 | missing, unknown or revoked key |
| `FORBIDDEN_SCOPE` | 403 | key lacks the scope |
| `NOT_FOUND` | 404 | unknown or out-of-scope id |
| `IDEMPOTENCY_REQUIRED` | 400 | `POST` without the header |
| `IDEMPOTENCY_MISMATCH` | 422 | same key, different body |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | the first request is still running |
| `SLOT_TAKEN`, `OUTSIDE_HOURS`, `NOT_QUALIFIED`, `INVALID_TRANSITION`, `AMBIGUOUS_TIME`, `AMBIGUOUS_CLIENT` | 409 / 422 | as in the MCP PRD §6 |
| `RATE_LIMITED` | 429 | `Retry-After` set |

6. **Idempotency (normative).** Every `POST` requires `Idempotency-Key` (≤255 chars, caller-chosen, scoped to the key). Table `IdempotencyRecord`: `apiKeyId`, `idemKey`, `requestHash` (method + path + canonical body), `status` (`in_progress | done`), `responseStatus`, `responseBody`, `expiresAt` (24 h). The claim is one `INSERT … ON CONFLICT DO NOTHING RETURNING` (the outbox pattern, A-048): the winner runs the domain function and stores the response; a concurrent loser sees `in_progress` → 409; a later replay with the same hash gets the stored response and a `Idempotent-Replayed: true` header; a different hash gets 422. The write and the `done` update commit in one transaction with the domain write, so a crash leaves either nothing or everything.
7. **Reads are safe to retry and say so:** `Cache-Control: no-store`; no read has side effects beyond `lastUsedAt` and the rate counter.
8. **PII rules** match the MCP PRD: client search returns display name, phone last 4 and reliability flag; full phone and email only on `GET /clients/{id}` **with the `contacts` scope**; notes never.
9. **OpenAPI** is generated from the zod schemas (one source), served at `GET /api/v1/openapi.json`, and checked in CI against the committed copy so a schema change without a doc change fails the gate.

## 7. Endpoints (v1)

**Read** (`read` scope)

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /v1/services` | id, name, duration, segments, (price with `prices` scope) | |
| `GET /v1/providers?serviceIds=` | id, name, services they can do | |
| `GET /v1/availability?serviceIds=&providerId=any\|id&from=&to=` | offered starts grouped by day and provider; ≤14 days | Same audience rules as MCP `find_open_times`: no lead time (D-25), no horizon (D-21), never an override. Uses `computeSlotsIn` so no offering surface bypasses `canSeat`. Never returns exclusion reasons. |
| `GET /v1/days/{day}?providerId=` | the day's appointments | |
| `GET /v1/appointments/{id}` | detail + `allowedActions` from the transition table + `version` | `version` = the appointment's `updatedAt` as an opaque ETag; see `PATCH` |
| `GET /v1/appointments?from=&to=&status=&cursor=` | list | instant-overlap predicate on `blockedStart/blockedEnd`, never `date(startAt)` |
| `GET /v1/clients?q=` | ≤5 matches, PII rules §6.8 | |
| `GET /v1/clients/{id}` | detail (+ contacts with scope), history, no-show count | no notes |
| `GET /v1/waitlist?day=` | active entries | |
| `GET /v1/events?since=&cursor=` | the business's appointment events in sequence order | **The catch-up door**: a receiver that was dark replays from the last `seq` it saw. Same shape as a webhook body. |

**Write** (`write` scope; all `POST`s require `Idempotency-Key`)

| Endpoint | Body | Domain call |
|---|---|---|
| `POST /v1/clients` | `name`, `phone`, `email?` | The same insert `prepare_new_client` commits (it mirrors the desk's `createClientForBooking`; there is no shared domain function today — **W-006 extracts one** so desk, MCP and API share it). `findClientsByPhone` first: a match → `AMBIGUOUS_CLIENT` unless `allowDuplicate: true` |
| `POST /v1/appointments` | `clientId`, `serviceIds`, `providerId`, `start`, `note?` | `bookAppointment` |
| `POST /v1/appointments/{id}/reschedule` | `start`, `providerId?`, `If-Match: <version>` | `rescheduleAppointment`, or `reassignAppointment` when the instant is unchanged and the provider differs (M-D16) |
| `POST /v1/appointments/{id}/cancel` | `reason`, `tellClient` (default **true**, D-32) | `transitionAppointment` → `cancelled`/`cancelled_late` as the domain decides |
| `POST /v1/appointments/{id}/status` | `to`: `checked_in \| in_progress \| completed \| no_show` | `transitionAppointment` |
| `POST /v1/waitlist` | `clientId`, `serviceIds`, `dayRange`, `providerId?` | existing waitlist function |

`If-Match` on reschedule and status is **optional in v1** and refused with `412 PRECONDITION_FAILED` when stale; *OQ-W3 asks whether to make it required.*

**Owner UI** (`/staff/integrations`, owner role only): issue/revoke keys with scopes; register/edit/disable endpoints; the delivery log with filters (endpoint, status, event type), each row expandable to request headers (signature redacted), response status, body excerpt, attempt history; a **Replay** button per delivery and a **Replay from seq** per endpoint.

## 8. Outbound webhooks (normative)

**Source of truth.** Deliveries are derived from `AppointmentEvent`, which every writer already stamps (D-79's source-scan test guarantees coverage). Migration adds `AppointmentEvent.seq` — a per-business sequence assigned under the existing business-row lock the booking path already takes (the Showcall `changeSeq` pattern; **confirm the lock exists on every writer before relying on it — if not, a `BusinessSeq` row with `SELECT … FOR UPDATE` is the fallback, recorded as `W-D`**). A new writer cannot forget to emit because nothing emits: the dispatcher reads the log.

**Event types (v1)** — one-to-one with `AppointmentEvent.type`, namespaced: `appointment.booked`, `appointment.rescheduled`, `appointment.reassigned`, `appointment.cancelled`, `appointment.status_changed` (with `from`/`to`), `appointment.status_corrected` (D-77 undo). Everything else in the log (`notification_skipped_*`, `override_*`, pushes) is **not** published in v1 and is listed in the OpenAPI doc as not-published, so absence is a decision.

**Models.**
- `WebhookEndpoint`: `businessId`, `url` (https only, no private ranges — validated at registration and at send), `secret` (random 32 bytes, shown once, stored encrypted-at-rest or hashed only if we never need to re-sign — *default: stored, since rotation needs the old one for the overlap window*), `eventTypes[]` (empty = all), `includeClientContact` (default **false**), `status` (`active | paused | disabled`), `consecutiveFailures`, `disabledAt`, `disabledReason`.
- `WebhookDelivery`: `endpointId`, `eventId`, `seq`, `status` (`pending | sending | succeeded | failed | dead`), `attempts`, `nextAttemptAt`, `lastResponseStatus`, `lastResponseExcerpt` (≤1 KB), `lastError`, `firstAttemptAt`, `succeededAt`. Unique on `(endpointId, eventId)` so one event is one delivery row per endpoint, however many times the sweep runs.

**Body.** `{ id, type, seq, occurredAt, apiVersion: "v1", data: { appointment: {…snapshot at event time…}, previous?: {…} }, replayed: bool }`. The snapshot is what `GET /v1/appointments/{id}` returned **at that moment**, stored in `WebhookDelivery` so a replay sends what was true then, not what is true now. Client fields follow §6.8 and `includeClientContact`.

**Signature.** Headers `Bookable-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, `Bookable-Event-Id`, `Bookable-Event-Type`, `Bookable-Delivery-Id`, `Bookable-Attempt`. Receivers verify with constant-time compare and reject `|now − t| > 300 s`. Secret rotation: a new secret is added, both sign for 24 h (two `v1=` values), then the old one drops. The reference receiver (`scripts/webhook-receiver.ts`) implements exactly this and is what the demo and the e2e use.

**Dispatch.** Two paths, both through one claim: `UPDATE … WHERE status='pending' AND (nextAttemptAt IS NULL OR nextAttemptAt <= now()) … RETURNING` (A-048's pattern; `sending` rows older than the stale window are reclaimed, and the writeup names that as the one double-send door, same as the outbox).
1. **Inline, best-effort:** after a write commits (API, desk, manage link, MCP — the hook is in the dispatcher, not the writers), `waitUntil()` from `@vercel/functions` runs one sweep for that business. Latency target ≤ 5 s when the receiver is up. *Verify `waitUntil` on the project's Vercel plan and fluid-compute setting before W-009 (W-D spike, mirroring Showcall's L1.0).*
2. **Sweep cron** `/api/jobs/webhooks` for retries and anything inline missed. **Cost tension with D-78:** a frequent cron wakes Neon. Default: **hourly**, and the backoff table is therefore "not before", not "at": `1 m, 5 m, 30 m, 2 h, 6 h, 24 h` then `dead` (6 attempts). `nextAttemptAt` is the column, never a sleep (A-051). *OQ-W4.*

**Receiver semantics the sender guarantees, in the docs and the writeup:** at-least-once; `id` is the dedupe key; `seq` is strictly increasing per business and gapless for *published* types only if the receiver subscribes to all of them (otherwise gaps are expected — say so); 2xx within 10 s is success, anything else is a failure; a 410 **disables** the endpoint immediately; 10 consecutive failures **pause** it with `disabledReason`, and the owner page shows it; replay sets `replayed: true` and a fresh `Bookable-Attempt`.

**Catch-up:** a receiver that was disabled or dark uses `GET /v1/events?since=<seq>` rather than asking for every delivery to be replayed. The owner page's "Replay from seq" exists for the case where the receiver cannot pull.

## 9. What tests must prove

1. **Tenancy:** with a second business seeded, a key for business B gets `NOT_FOUND` for every business-A id on every endpoint, and its endpoints never receive a business-A event.
2. **Scopes and revocation:** a `read` key is refused on every write with the scope named; a revoked key fails on the next request; revoking a key disables nothing else.
3. **Error mapping:** one test per §6 code asserting `status`, `code` and `next`; both error *shapes* of the exclusion constraint (statement-time `23P01` and deferred commit-time name-only, per A-078) reach the API as `SLOT_TAKEN`.
4. **Idempotency:** replay returns the stored response byte-for-byte with `Idempotent-Replayed: true`; a different body → 422; a barrier-forced concurrent pair produces exactly one appointment and one `409 IDEMPOTENCY_IN_PROGRESS`; a crash between domain write and record (simulated by throwing after the write inside the transaction) leaves no appointment.
5. **Parity:** a booking via the API and the same booking via the desk produce identical rows and events except `channel`/`actorRef` (extend the existing M-013 parity test).
6. **Availability equality:** `GET /v1/availability` and the desk's offer path return the same set for a room where exactly one chair can seat the visit (the A-082 rule: one operational question, two readers, assert equal).
7. **Sequence:** `seq` is +1 per committed event in commit order under concurrent writers (two transactions on one business; the second blocks on the lock; a reader between commits sees the first only).
8. **Delivery:** a receiver that 500s twice then 200s yields one `succeeded` row with `attempts = 3` and the recorded backoff; a receiver that always fails reaches `dead` after 6 with the endpoint paused at 10 consecutive; a 410 disables at once; two sweeps racing for one row deliver once (claim test); a reclaimed stale `sending` row is the documented double-send door and the test shows it.
9. **Signature:** the reference receiver verifies a real delivery; a tampered body, a wrong secret and a 6-minute-old timestamp each fail; during rotation both secrets verify.
10. **PII:** without `includeClientContact` no delivery body contains a phone or email (string sweep over every body the e2e produced, the Showcall L1.9d pattern); without the `contacts` scope no API response does either.
11. **Snapshot honesty:** replaying a `booked` delivery after the appointment was rescheduled sends the booked-time snapshot with `replayed: true`, not the current row.
12. **OpenAPI drift:** CI regenerates the spec and diffs against the committed file.
13. **Coverage by derivation:** a test adds a fake event writer with a published type and asserts a delivery row appears with no code change outside the writer — the proof that the log, not the writers, feeds the pipeline.

## 10. Backlog

| Item | What | Size | Milestone |
|---|---|---|---|
| ✅ W-000 | Commit this PRD; answer §11 (or take defaults into `DECISIONS.md` as `W-D1..`); `waitUntil` spike on a preview | S | 1 Foundation |
| ✅ W-001 | `ApiKey` model + migration; owner issue/revoke on `/staff/integrations`; bearer resolution; `EventChannel.api` + `channelOf` + source-scan test | M | 1 |
| ✅ W-002 | Problem+json envelope, shared domain-error mapping, zod request validation, per-key rate limit, Basic-gate exemption | M | 1 |
| ✅ W-003 | `GET /v1/services`, `/providers`, `/availability` (via `computeSlotsIn`), with the equality test | M | 2 Reads |
| ✅ W-004 | `GET /v1/days/{day}`, `/appointments`, `/appointments/{id}` (+ `allowedActions`, `version`), cursor pagination helper | M | 2 |
| ✅ W-005 | `GET /v1/clients`, `/clients/{id}` (scope-gated contacts), `/waitlist` | S | 2 |
| ✅ W-006 | `IdempotencyRecord` + claim; `POST /v1/appointments`, `/clients`; barrier race test; crash test | L | 3 Writes |
| ✅ W-007 | `POST …/reschedule` (reassign routing, `If-Match`), `/cancel`, `/status`, `/waitlist`; parity test extended | M | 3 |
| ✅ W-008 | `AppointmentEvent.seq` migration + lock audit; `GET /v1/events` | M | 4 Webhooks |
| W-009 | `WebhookEndpoint`, `WebhookDelivery`, snapshot capture, claim-based dispatcher, inline `waitUntil` + hourly sweep, backoff, dead-letter, pause/disable rules | L | 4 |
| W-010 | Signing + rotation; `scripts/webhook-receiver.ts`; signature tests | M | 4 |
| W-011 | `/staff/integrations`: endpoints CRUD, delivery log, replay (row and from-seq) | M | 5 Owner UI |
| W-012 | OpenAPI generation + CI drift check; `docs/api/README.md` for a hiring manager (how to get a key, curl the golden path, verify a webhook) | M | 6 Closure |
| W-013 | e2e: golden path (key → availability → book → webhook received and verified → reschedule → second webhook → replay), PII sweep, at phone width for the owner page | M | 6 |
| W-014 | `docs/DEMO.md` §14, `STATUS.md`, `RELEASE_NOTES.md`, cost re-read against D-78 after a week; exec brief + posts are the owner's hand steps | S | 6 |

Demo checkpoints: after W-003 (a `curl` with a key returns tomorrow's open times), after W-007 (an n8n flow books through the API and the desk shows "via API"), after W-010 (the reference receiver prints a verified `appointment.booked` seconds after a desk booking).

Deploy and demo preconditions carry over unchanged: `migrate:deploy` against Neon, then the `main-manual` hook (D-71), then `refresh-hosted-demo.sh`. Salon closed Sun/Mon.

## 11. Open questions (defaults apply unless the owner answers otherwise)

| # | Question | Default |
|---|---|---|
| OQ-W1 | Is `Actor.system` + `actorRef = key id` honest enough for an integration's writes, or does `Actor` grow `integration`? Adding an enum value is a status-enum-style change with readers to grep. | **`system` + `actorRef` + `channel = api`.** The channel column is what the panel reads (D-79); the actor enum stays untouched. Revisit if any reader treats `system` as "the cron". |
| OQ-W2 | Who sees prices over the API? D-36 says only the owner sees money. | **A `prices` scope, owner-issued like any other.** A key is the owner's choice, so the owner is still the one who decided. |
| OQ-W3 | Is `If-Match` required on reschedule/status, or optional? | **Optional in v1**, honoured when sent. The domain functions already refuse stale moves; `If-Match` is a courtesy for integrations that read-then-write. |
| OQ-W4 | Sweep cron cadence vs the D-78 cost rule. | **Hourly.** Inline `waitUntil` carries the happy path; the sweep is for retries. Re-read Neon `compute_time_seconds` after a week (D-78's method) and record the delta before changing it. |
| OQ-W5 | Does an `includeClientContact` endpoint send full phone/email, or only with a `contacts` scope on a key the endpoint is tied to? | **Endpoint flag only**, off by default, set by the owner. Endpoints are not keys; tying them would add a model for no gain in v1. |
| OQ-W6 | Publish `client.created` and `waitlist.*` events in v1? They are not in `AppointmentEvent`. | **No.** v1 publishes only what the append-only log already guarantees coverage for. Listed as not-published in the OpenAPI doc. |
| OQ-W7 | Start before the Ledger images for 49–53 / 109–113 are done? | **Yes** — they are outside the repo and block nothing here. |
