# Bookable API and webhooks

Bookable is the appointment book of a small salon. This API lets another
system (a CRM, a spreadsheet, an n8n flow) read the book and book, move and
cancel appointments under the same rules as the front desk. Webhooks tell that
system the moment an appointment changes.

The full contract is generated from the validation schemas the server uses, at
[`openapi.json`](openapi.json) (also served at `GET /api/v1/openapi.json`).
CI fails if the two drift apart.

## What is worth looking at

- **Every write goes through the desk's own functions.** The database refuses
  a double-booking whichever door the write came through. A test proves that a
  booking made through the API leaves the same rows as one made at the desk,
  apart from the "via API" channel and the key that made it.
- **Retries cannot book twice.** Every `POST` needs an `Idempotency-Key`. A
  replay returns the first response byte for byte. A race between two
  requests with the same key is forced in the test suite, not left to timing.
- **Webhooks are derived, not emitted.** They are read from the append-only
  appointment history, so code written next year is announced without anyone
  remembering to. Each event carries a per-salon sequence number assigned by
  the database at commit time, so "what did I miss since #412?" has an exact
  answer.
- **Delivery is honest about its limits.** Delivery is at-least-once, never
  exactly-once. Messages are signed and retried with backoff, dead-lettered
  after six tries, and replayable from the owner page.

## Get a key

Sign in as the owner, open **Setup → Integrations**, and issue a key with the
`read` and `write` scopes. The key (`bk_api_…`) is shown once.

```bash
export BK=https://<host>/api/v1
export KEY=bk_api_...
```

## The golden path

```bash
# What can be booked, and with whom
curl -s -H "Authorization: Bearer $KEY" "$BK/services"
curl -s -H "Authorization: Bearer $KEY" "$BK/providers"

# Open times for a cut, any stylist, over a week (days inclusive, ≤ 14).
curl -s -H "Authorization: Bearer $KEY" \
  "$BK/availability?serviceIds=<serviceId>&providerId=any&from=2026-11-03&to=2026-11-09"

# Find or add the client
curl -s -H "Authorization: Bearer $KEY" "$BK/clients?q=Maria"

# Book. `start` may be wall time in the salon's zone ("2026-11-04 10:00") or
# ISO-8601 with an offset. The Idempotency-Key makes a retry safe.
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: crm-booking-8812" \
  -d '{"clientId":"<clientId>","serviceIds":["<serviceId>"],"providerId":"<providerId>","start":"2026-11-04T10:00:00-06:00"}' \
  "$BK/appointments"

# Move it, sending back the version you read, so a change made at the desk
# in the meantime is refused (412) rather than overwritten
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: crm-move-8812" -H 'If-Match: "<version>"' \
  -d '{"start":"2026-11-04 14:00"}' "$BK/appointments/<id>/reschedule"

# Catch up on everything since the last event you saw
curl -s -H "Authorization: Bearer $KEY" "$BK/events?since=412"
```

Every error is `application/problem+json`. It carries a `code` (for example
`SLOT_TAKEN`, `OUTSIDE_HOURS` or `IDEMPOTENCY_MISMATCH`) and a `next`, which
names the endpoint to call instead.

## Verify a webhook

Register an endpoint on the same page. Its signing secret (`whsec_…`) is shown
once. Each delivery carries:

```
Bookable-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
Bookable-Event-Id / -Event-Type / -Delivery-Id / -Attempt
```

To verify one, compute the HMAC over the raw bytes, compare it in constant
time, and reject anything more than 300 s old. During a secret rotation two
`v1=` values arrive for 24 h, and either one matching is enough. Dedupe on the
event id. The reference receiver does all of this using only the Node standard
library:

```bash
WEBHOOK_SECRET=whsec_... npx tsx scripts/webhook-receiver.ts
# webhook receiver listening on http://localhost:3310/
# VERIFIED #57 appointment.booked appointment=cm… start=2026-11-04T10:00:00-06:00
```

The server only accepts a `localhost` endpoint when it runs with
`WEBHOOK_ALLOW_PRIVATE=1` (local and test only). Anywhere else an endpoint
must be `https` and must not resolve to a private address.

## Honest limits

- Delivery is at-least-once, and a receiver must dedupe on `id`. `seq` is
  gapless only if you subscribe to every published type.
- Retries run when the next write happens or on the salon's daily job,
  whichever comes first. On a quiet day a receiver that was down can wait up
  to a day for its retry. This was the owner's call, to keep the hosted demo
  database asleep between visits (D-81). `GET /v1/events?since=` is the
  immediate catch-up.
- The webhook body's appointment snapshot is captured when the sender first
  sees the event: seconds after a desk or API write, later if that inline send
  failed.
- Keys are issued by the owner for the owner's own tools. There is no OAuth,
  no developer portal, and no second salon.
