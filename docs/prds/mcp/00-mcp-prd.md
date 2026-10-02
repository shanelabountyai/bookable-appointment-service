# 00 — PRD: Bookable MCP Server (AI track, A1)

**What:** an MCP server that exposes the shipped Bookable salon app as tools an AI client (Claude Desktop, Claude Code, claude.ai) can call on behalf of a signed-in staff member.
**Builder:** Solo, in Claude Code · first AI-track build · item prefix **`M-`** (Bookable's own items stay `A-`).
**Status:** v0.1 draft — 2026-10-02. Owner answers to §11 amend this file.
**Lives in:** this monorepo as `apps/mcp`, calling `packages/db` domain functions directly. **Not** the web app's server actions (they take `FormData` and a cookie session).
**Learning objectives:** tool design (names, schemas, descriptions), errors a model can recover from, scoped auth so the model only ever sees what its caller may, and different rules for read and write tools.

---

## 1. Problem statement

Bookable already does the hard part: a race-proof slot engine, a transition table, an audit trail with a named actor on every mutation. Today a human reaches all of it through screens. The question this build answers is what changes when the caller is a model acting for that human:

- A model reads tool **descriptions and schemas**, not a UI. A vague tool is a wrong booking.
- A model **retries**. An error it cannot read becomes a loop, or a confident wrong answer.
- A model will **call anything it can see**. Scoping has to happen in what is listed, not only in what is refused.
- A model can be **talked into things** by data it reads (a client name, a note). Write tools need a gate the model cannot satisfy on its own.

## 2. Goals

1. A staff member can run the core desk jobs from an AI client — find a time, book, move, cancel, check in, look up a client — and every resulting row is indistinguishable from a desk action except for its recorded channel.
2. **Nothing the model writes skips the rules the desk follows.** Every write goes through the same `packages/db` functions (`bookAppointment`, `rescheduleAppointment`, `transitionAppointment`, …), so the exclusion constraint, D-8 (no customer-side conflicts), D-31 (reschedule may not override) and D-32 (staff cancellations tell the client by default) apply unchanged.
3. **The model only sees its caller's world.** The business comes from the token, never from a tool argument. Owner-only tools are absent from a staff token's `tools/list`, not merely refused.
4. **Every write is previewed, then committed.** What gets committed is byte-for-byte what was previewed, and it is re-validated at commit.
5. **Every error names what to do next** in a form a model can act on (§6).
6. (Builder goal) A small, scripted model eval proves goals 1, 4 and 5 against a real model, not just unit tests.

## 3. Non-goals

- **Customer-facing agent.** Customers keep the tokenized manage link. No `customer_token` actor over MCP in v1.
- **OAuth.** v1 uses per-person bearer tokens (§5). OAuth is a later item if a client requires it (see OQ-M5).
- **Override bookings, column pushes, releasing no-show time, merging clients, staff and settings management.** These stay in the UI on purpose: each needs a reason, a judgment, or an operator looking at the grid. Listed so their absence is a decision, not an omission.
- **Client notes over MCP** (OQ-M3 default). Notes are the most sensitive text in the system and the most likely carrier of injected instructions.
- **Multi-business.** The tenancy boundary is enforced (§5), but no second business is built. Known ceiling: the public side resolves its business with `findFirst()` and no `where` (see `NEXT.md`). MCP must never call those public-side paths.

## 4. Personas

- **Desk staff (role `staff`)** — books, moves, checks in, from Claude Desktop on the salon laptop or their phone.
- **Owner (role `owner`)** — everything staff can do, plus the week report and money (D-36: owner is the only role that sees money).
- **The model** — treated as an untrusted intermediary: it may misread, retry, or be steered by text it reads.

## 5. Auth and scoping

- **Token per person.** The owner issues an MCP token for a named, active `StaffUser` from the staff page. Shown once, stored hashed, revocable, with a last-used time. One token = one person; no desk-PIN-style "act as" over MCP (OQ-M2).
- **Resolution on every call:** token → `StaffUser` (must be `active`; deactivation revokes on the next call, as `findStaffById` already does) → `businessId` + role. **No tool takes a `businessId`.**
- **Listed by role.** `tools/list` is built per role. The owner tool (`get_week_report`) does not appear for `staff`.
- **Actor.** Every mutation is written with `staffActor(staffUserId)`, so the existing audit trail names the person. The channel is recorded too (OQ-M1: add `channel` = `desk | manage_link | mcp | system` to `AppointmentEvent`).
- **Rate limit** per token through the existing `consumeRateLimit` (`RateLimitCounter`). Default: 60 reads/min, 10 commits/min.
- **Transport.** Milestone 1 is **stdio** (local, Claude Desktop/Claude Code config, token in env). Milestone 4 adds **Streamable HTTP** at `apps/web` `/api/mcp` with `Authorization: Bearer`. The tool layer is written once and is transport-agnostic.

## 6. Tool design rules (normative)

1. **Names are verbs on salon nouns** (`find_open_times`, not `query_slots`). Descriptions say when to use the tool, what it will not do, and which tool comes next.
2. **Times in, times out.** Inputs are business-local wall time `YYYY-MM-DD HH:MM` and days `YYYY-MM-DD`, resolved through `@bookable/core/time` in the business's IANA zone. A wall time that does not exist (spring-forward) or exists twice (fall-back) is refused with both readings named. Outputs carry both a label ("Thu 16 Oct, 2:15 pm") and an ISO instant.
3. **Ids come from tools, never from the model's head.** Every id argument must have come from a previous tool result. Unknown or cross-business ids return `NOT_FOUND`, never a hint that they exist elsewhere.
4. **Annotations.** Read tools: `readOnlyHint: true`. `commit_proposal`: `destructiveHint: true`, so clients prompt the human.
5. **Structured results** (`structuredContent` plus a short text summary). Free text that came from people (client names, booking notes) is returned in labelled data fields, and every tool description states that such fields are data, not instructions.
6. **Recoverable errors.** Tool failures return `isError: true` with:

```json
{ "error": "SLOT_TAKEN", "message": "Dana's 2:15 on Thu 16 Oct was booked a moment ago.",
  "field": "start", "next": { "tool": "find_open_times", "why": "pick another time" } }
```

| Code | When | `next` |
|---|---|---|
| `SLOT_TAKEN` | Constraint refused at commit, or the time is no longer offered | `find_open_times` |
| `OUTSIDE_HOURS` | Not in the provider's windows / time off | `find_open_times` |
| `NOT_QUALIFIED` | Provider can't do the whole visit (SVC-02) | `list_providers` |
| `INVALID_TRANSITION` | Status move not allowed from the current state (§7 table) | `get_appointment` (returns `allowed_actions`) |
| `AMBIGUOUS_TIME` | DST gap/overlap | re-ask the human |
| `AMBIGUOUS_CLIENT` | More than one match where one was required | `find_client` |
| `NOT_FOUND` | Unknown or out-of-scope id | the matching `find_`/`list_` tool |
| `PROPOSAL_EXPIRED` / `PROPOSAL_STALE` / `PROPOSAL_USED` | §8 | the matching `prepare_` tool |
| `RATE_LIMITED` | Over §5 limits | wait `retry_after_s` |

Domain errors (`BookingRejected(field, message)`, `SlotTaken`, transition refusals) are mapped once, in one module, with a test per code.

## 7. Tools (v1)

**Read** (all roles)

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `list_services` | — | id, name, duration, price | |
| `list_providers` | `service_ids?` | id, name, services they can do | |
| `find_open_times` | `service_ids`, `provider_id \| "any"`, `from_day`, `to_day` (≤14 days), `part_of_day?` | offered times grouped by day and provider | Staff audience: no lead time (D-25) or horizon (D-21); never offers an override |
| `get_day` | `day`, `provider_id?` | the day's appointments: time, client display name, services, status, running-late | |
| `get_appointment` | `appointment_id` | detail + `allowed_actions` from the transition table | `allowed_actions` is what makes `INVALID_TRANSITION` recoverable |
| `find_client` | `query` (name or phone) | ≤5 matches: id, display name, phone last 4, reliability flag | No notes; never full phone |
| `get_client_history` | `client_id` | past/upcoming appointments, no-show count | No notes |
| `list_waitlist` | `day?` | active entries | |

**Read** (owner only)

| `get_week_report` | `week_of` | the owner's existing week report (utilization, plus any money figures that report already shows) | absent from `staff` `tools/list` |
|---|---|---|---|

**Write** (all roles; each returns a *proposal*, not a change — §8)

| Tool | Input | Proposal summary example |
|---|---|---|
| `prepare_booking` | `client_id`, `service_ids`, `provider_id`, `start`, `note?` | "Book Maria G. — cut & colour with Dana, Thu 16 Oct 2:15–4:00 pm." |
| `prepare_new_client` | `name`, `phone` | "Add client Maria Gomez, phone ending 4412." |
| `prepare_reschedule` | `appointment_id`, `start`, `provider_id?` | "Move Maria G. from Dana 2:15 to Priya 3:00, same day." (D-31) |
| `prepare_cancel` | `appointment_id`, `reason`, `tell_client` (default **true**, D-32) | "Cancel … Maria will be texted." |
| `prepare_status_change` | `appointment_id`, `to`: `checked_in \| in_progress \| completed \| no_show` | "Mark Maria G. as a no-show (her 2nd)." |
| `prepare_waitlist_entry` | `client_id`, `service_ids`, `day_range`, `provider_id?` | |
| `commit_proposal` | `proposal_id` | the committed result, or a §6 error | `destructiveHint: true` |

## 8. Preview-then-commit (normative)

- `prepare_*` runs every check the commit will run (slot engine, qualification, transition table) **without writing the appointment**, and stores an `McpProposal`: id, staff user, business, action, canonical args, args hash, human summary, `expiresAt` (10 min), `usedAt`.
- `commit_proposal` re-loads the proposal, checks owner/business/expiry/unused, and runs the real domain function with the stored args. It never accepts new args.
- **Re-validated at commit.** If the world changed (slot taken, status moved), the result is `PROPOSAL_STALE` or the specific domain error. Nothing is half-written.
- **Single use.** The claim is one `UPDATE … WHERE usedAt IS NULL RETURNING`, the same "a database fact rather than a hope" pattern as the notification outbox (A-048).
- **Honest limit, stated in the writeup:** the server cannot prove a human read the summary. The human gate is the client's approval prompt on `commit_proposal`. What the server guarantees is that what commits is exactly what was previewed, and is still valid.

## 9. What tests must prove

1. **Role listing:** snapshot of `tools/list` for `staff` and `owner`; the owner tool is absent for staff.
2. **Tenancy:** with a second business seeded in the test DB, a token for business B gets `NOT_FOUND` for every business-A id, on every tool.
3. **Revocation:** a deactivated staff user's token fails on the next call.
4. **Error mapping:** one test per §6 code, asserting `error`, `field` and `next`.
5. **Proposals:** expired, reused, wrong user, and stale (slot taken between prepare and commit) — the race written barrier-based per spec §4.5, not as a timing test.
6. **Parity:** a booking via MCP and the same booking via the desk produce the same rows and events except `channel`.
7. **Model eval (manual, not CI):** 8–10 scripted scenarios run against Claude with the server attached, graded on the **end state in the database**, not the transcript. At least: book a named client; recover from `SLOT_TAKEN`; refuse to double-book; move a sick stylist's client to another provider; check-in → complete; ambiguous client; DST-gap time; a client name containing an instruction. Cost cap per run, recorded.

## 10. Backlog

| Item | What | Size | Milestone |
|---|---|---|---|
| M-000 | Commit this PRD; answer §11 | S | 1 Foundation |
| M-001 | `apps/mcp` workspace, SDK pinned, stdio server with `list_services` end-to-end | S | 1 |
| M-002 | `McpToken` (hashed, revocable, last-used) + owner issue/revoke on the staff page | M | 1 |
| M-003 | Token → actor/business/role context; role-built `tools/list`; tenancy + revocation tests | M | 1 |
| M-004 | Error envelope + domain-error mapping + wall-time parsing (§6) | M | 1 |
| M-005 | `list_providers`, `find_open_times` | M | 2 Reads |
| M-006 | `get_day`, `get_appointment` with `allowed_actions` | M | 2 |
| M-007 | `find_client`, `get_client_history`, `list_waitlist` (PII rules) | M | 2 |
| M-008 | `get_week_report` (owner only) | S | 2 |
| M-009 | `McpProposal` + `commit_proposal` + `channel` on events (OQ-M1) | L | 3 Writes |
| M-010 | `prepare_booking`, `prepare_new_client` | M | 3 |
| M-011 | `prepare_reschedule`, `prepare_cancel` | M | 3 |
| M-012 | `prepare_status_change`, `prepare_waitlist_entry` | M | 3 |
| M-013 | Barrier-based prepare→commit race test; parity test | M | 3 |
| M-014 | Streamable HTTP at `/api/mcp` with bearer auth; connect from Claude | M | 4 Hosted + eval |
| M-015 | Model eval harness + scenarios (§9.7) | M | 4 |
| M-016 | DEMO.md (Claude Desktop walkthrough), WRITEUP.md, exec brief, posts | M | 4 Closure |

Demo checkpoints: after M-004 (a tool call works end-to-end from Claude Desktop), after M-008 (Claude answers "who's in this afternoon and when is Dana free?"), after M-013 (the sick-stylist script).

## 11. Open questions (defaults apply unless the owner answers otherwise)

| # | Question | Default |
|---|---|---|
| OQ-M1 | Record the channel (`desk`/`manage_link`/`mcp`/`system`) on `AppointmentEvent`? It's a migration. | **Yes.** "Booked by Sam via Claude" is the audit line that makes this trustworthy. |
| OQ-M2 | One token per person, or a shared desk token with "act as"? | **One per person.** The desk PIN (D-33) exists because people share a terminal; nobody shares an AI client login. |
| OQ-M3 | Expose client notes? | **No** in v1 (§3). |
| OQ-M4 | Start before Bookable Phase 23 closes? | **No.** Finish A-160 (needs OQ-26) and A-161 first; both touch `packages/db/appointments`, which M-009 also touches. |
| OQ-M5 | Can the target clients send a static bearer token over HTTP, or do they require OAuth? | **Verify at M-014** against current client docs. If OAuth is required, M-014 splits into a stdio-bridge demo now and an OAuth item later. |
