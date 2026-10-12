# Bookable MCP server

An AI assistant (Claude Code, Claude Desktop) can run a salon's front desk through this server: find a time, book, move, cancel, check a client in, look someone up. It exposes the existing Bookable booking system as **MCP tools**, so every action the assistant takes goes through the same rules a human at the desk is held to — and leaves the same audit trail, with one extra fact: *how* the change arrived.

This README is written for someone deciding whether the engineering is sound. The code is in `src/`; the spec it was built against is `docs/prds/mcp/00-mcp-prd.md`; every decision taken along the way is in `DECISIONS.md` at the repo root.

## What it does

| The desk asks… | Tools involved | What is guaranteed |
|---|---|---|
| "When is Dana free for a cut this week?" | `list_services`, `list_providers`, `find_open_times` | The offer is computed by the same engine call the staff booking screen makes — same rules, same client-in-chair check — so a time offered is a time the write will accept. |
| "Book Maria in at 10." | `find_client`, `prepare_booking`, `commit_proposal` | Nothing is written until the human has seen a one-line summary and the assistant commits **that** proposal — byte-for-byte, once, within ten minutes, re-validated at the moment of writing. |
| "Dana's sick, move her clients." | `get_day`, `prepare_reschedule`, `commit_proposal` | The stylist may change; nothing may double-book. A same-time move is a reassignment, a different time is a reschedule — one question, the right domain function behind each. |
| "Cancel Maria, she's unwell, let her know." | `prepare_cancel` | A reason is required; whether it counts as late is decided by the cutoff and the clock, and the summary says which before anyone agrees. The client is texted unless the human says not to. |
| "Who's waiting? What did she have last time?" | `list_waitlist`, `get_client_history` | Names yes; phone numbers (beyond the last four), emails and client notes **never** leave the server, on any tool. |
| "How did the week go?" | `get_week_report` | Owner only — not refused for a stylist's token, *absent* from the list, because a model calls anything it can see. |

Deliberately **not** exposed: overrides (knowingly double-booking), column pushes, releasing a no-show's time, merging clients, staff and settings management. Each needs a judgment the desk makes while looking at the grid.

## How it is built

**Three layers, one rule per layer.**

1. **Credential.** One bearer token per named staff member, issued by the owner on `/staff/people`, shown once, stored hashed, revocable. The token is resolved **on every call**, not once per connection — a Claude Desktop session stays open for hours, and "taking someone off the roster revokes their access" has to be true for the next call, not the next morning.
2. **Tools.** Each tool declares which roles may see it, a Zod input schema and output schema (the SDK validates both ways), and a description that says when to use it, what it will not do, and which tool comes next. Every id argument is checked against the caller's business before anything else happens; an unknown or foreign id is `NOT_FOUND`, never a hint that it exists elsewhere.
3. **Writes.** Every change is two tools: `prepare_*` runs *every* check the real write runs (engine, qualification, transition table) and stores a proposal — canonical arguments, a hash of them, a sentence for the human, a ten-minute expiry. `commit_proposal` claims the row with one conditional `UPDATE … WHERE usedAt IS NULL` and runs the real domain function with the stored arguments. It never takes new ones. If the world moved in between, the result is the specific refusal and nothing is written.

**Errors are for the model to recover from, not for a log.** Every refusal is one shape — `{ error, message, field, next: { tool, why } }` — mapped from the booking system's own exceptions in one module with one test per code. `SLOT_TAKEN` points at `find_open_times`; `INVALID_TRANSITION` points at `get_appointment`, whose `allowed_actions` lists exactly the moves the transition table permits right now; `AMBIGUOUS_TIME` names both readings of a wall-clock time that does not exist (spring forward) or exists twice (fall back) as ISO instants and asks the model to send one back. It never guesses, because guessing books a time nobody chose.

**The audit trail knows the door.** Every appointment event now carries `channel` ∈ `desk | manage_link | mcp | system`. "Booked by Sam via the assistant" is a stored fact. Thirteen places write events; a test reads the source to make sure none forgot.

## How it is tested

~120 tests in `src/**/*.test.ts` and `eval/`, all through a **real MCP client over an in-memory transport** — what is asserted is what a client sees. The ones worth reading:

- **`tenancy.test.ts`** — a registry: every tool must have a probe or the suite fails before it runs. Each probe is driven with salon B's token against salon A's ids.
- **`tools/availability.test.ts` › EQUALITY** — the "any stylist" path and each named-stylist path must offer the same set of instants, and the count of free stylists must match. It failed first and corrected my model of the code.
- **`tools/day.test.ts` › EQUALITY** — `allowed_actions` recomputed from the transition table at every status a visit passes through.
- **`tools/race-parity.test.ts`** — one proposal committed twice behind the proposal's own row lock (the interleaving is forced, not sampled): exactly one booking. A booking and a cancellation made through MCP and at the desk produce identical rows and identical events except `channel`.
- **`eval/harness.test.ts`** — nine desk scenarios graded on the **database**, run against a scripted stand-in model so CI costs nothing; three deliberately wrong paths prove a pass means something. `npm run eval` runs the same scenarios against Claude with a per-scenario cost cap.

**What the tests found before any user did** (each is in `docs/PROGRESS.md` under its item): Postgres reorders JSON keys, so the first proposal-hash design refused every row it stored; a time outside working hours was reported as "taken" because the engine never enumerates it; `rescheduleAppointment` refuses an unchanged instant, so a same-time stylist swap needs the reassignment function; and a client that validates output schemas — as Claude's do — rejects an error payload placed in `structuredContent`, so every error would have reached the model as an exception. The last two were found by the eval harness's dry run, not by any unit test.

## Running it

```bash
# Tests (local Postgres; the root scripts load .env.test)
npm test -- apps/mcp

# Over stdio, for Claude Desktop / Claude Code on this machine.
# Issue a token as the owner on /staff/people first.
claude mcp add --env BOOKABLE_MCP_TOKEN=bk_mcp_… --env DATABASE_URL=postgresql://… --transport stdio bookable \
  -- npx tsx apps/mcp/src/stdio.ts

# Over HTTP, against a running web app (local :3300 or the deployment)
claude mcp add --transport http bookable http://localhost:3300/api/mcp \
  --header "Authorization: Bearer bk_mcp_…"

# The eval: scripted (free) and real (spends API credit; EVAL_COST_CAP_USD per scenario, default $1)
npm run eval:dry
npm run eval
```

## Honest limits

- The server cannot prove a human read the summary. The human gate is the client's approval prompt on `commit_proposal` (`destructiveHint: true`). What the server guarantees is narrower and real: what commits is what was previewed, by the person who previewed it, once, re-validated.
- Authentication is a static bearer token. Claude Code sends one; the hosted Claude apps accept one only as an organisation-level credential, otherwise they want OAuth. OAuth is a later item, not a half-built one.
- The Claude eval has been run once (2026-10-12, `claude-opus-5-5`): 9/9 for $0.47 total. One run on one model is a baseline, not a guarantee; re-run it when the tools or scenarios change.
- Rate limits are per token (60 reads, 10 commits a minute) and `retry_after_s` is the whole window, not the remainder — conservative on purpose.
