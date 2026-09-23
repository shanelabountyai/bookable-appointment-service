# Deployment — Bookable

Target: **`appt.labintelligence.co`**, Vercel + Neon, matching the sibling
projects. The decision, and what was rejected, is **D-65** in
`docs/prds/07-decisions.md`.

> [!IMPORTANT]
> **This is a demo deployment, not production.** No backups, no monitoring, no
> on-call, and every row in it is generated. Texts and emails go to the server
> log (the console adapter); nothing leaves the host.

## What is in the repo

| Piece | Where | What it does |
|---|---|---|
| Build config | `vercel.json` | Monorepo build (`apps/web/.next`), the `ignoreCommand`, and the reminder job every 5 minutes. |
| Demo password gate | `apps/web/lib/demo-gate.ts`, `apps/web/middleware.ts` | One shared HTTP Basic password over the whole site when `DEMO_ACCESS_PASSWORD` is set. Unset = no gate, which is how local and CI run. `/api/jobs/reminders` is exempt by exact path — it checks `CRON_SECRET` itself. 15 tests in `demo-gate.test.ts`. |
| Refresh | `scripts/refresh-hosted-demo.sh` | Seeds a local scratch book, empties the hosted one and bulk-copies it across, then proves the trigger-derived tables match row for row. ~2 minutes. |

## Where things live

| What | Where |
|---|---|
| Vercel project | `bookable` in `shanelabountyai-8212s-projects`, connected to this GitHub repo. Root Directory stays `.` — set it to `apps/web` and the repo-root `vercel.json` (and its `ignoreCommand` and cron) is never read. |
| Database | Neon project `bookable-demo` (`bold-base-98485145`), org "Shane", `aws-us-east-2`. Its own project — never `bookable_dev` or `bookable_test`. |
| Local copies of every hosted secret | `.env.production.local` (gitignored): `DATABASE_URL` (pooled), `DIRECT_URL`, `SESSION_SECRET`, `CRON_SECRET`, `DEMO_ACCESS_PASSWORD`. |
| DNS | Cloudflare (`labintelligence.co`'s nameservers). |

## Environment variables (Production and Preview)

| Variable | If missing |
|---|---|
| `DATABASE_URL` | Neon **pooled** string. Nothing runs. |
| `DIRECT_URL` | Neon **direct** string. Migrations fail. |
| `SESSION_SECRET` | Staff sign-in refuses to work — by design, there is no default. |
| `CRON_SECRET` | The reminder route refuses every call, including Vercel Cron's. |
| `DEMO_ACCESS_PASSWORD` | **The site is fully public**, and so is the staff password DEMO.md publishes. |

These are *not* the values in `.env.local` — those are local demo values.
Adding one: `grep '^NAME=' .env.production.local | cut -d= -f2- | tr -d '"' | tr -d '\n' | vercel env add NAME production`
(stdin keeps it out of `ps` and shell history). Env changes need a redeploy: `vercel --prod`.

## Before each demo: refresh the book

The seeded week is anchored to the day it was seeded, so after about ten days
the grid goes empty. Before a demo:

```bash
./scripts/refresh-hosted-demo.sh
```

It refuses any target that is not a Neon host. Seeding straight into Neon
works too but takes ~45 minutes (one network round trip per row), which is why
the script exists. Two things it works around, each of which failed a run:

- **Neon refuses `session_replication_role`**, so triggers cannot be switched
  off during a data load. The two tables a trigger derives from each
  appointment (`AppointmentBlock`, `AppointmentResourceHold`) are left out of
  the copy and regenerate; the script then diffs them against the source.
- **pg_dump empties `search_path`**, and the Client trigger calls
  `bookable_phone()` unqualified, so that one line is stripped from the stream.
- The diff runs with `PGTZ=UTC`: Neon prints timestamps in GMT and this laptop
  in America/Chicago, so an unpinned diff fails on every row that is equal.

## Schema changes

Migrations run deliberately, never in the build (a build that migrates can
half-migrate):

```bash
set -a; . ./.env.production.local; set +a
npm run migrate:deploy -w packages/db
```

## The DNS record

In Cloudflare, `labintelligence.co` → DNS → Add record:

| Type | Name | Content | Proxy status |
|---|---|---|---|
| `A` | `appt` | `76.76.21.21` | **DNS only** (grey cloud) |

It must be DNS only. A proxied (orange) record puts Cloudflare's certificate in
front of Vercel's, and Vercel cannot issue or renew its own.

## Verify

```bash
PASS=$(grep '^DEMO_ACCESS_PASSWORD=' .env.production.local | cut -d= -f2- | tr -d '"')
curl -sI https://appt.labintelligence.co/book | head -1                     # 401
curl -sI -u "demo:$PASS" https://appt.labintelligence.co/book | head -1     # 200
curl -s -o /dev/null -w '%{http_code}\n' https://appt.labintelligence.co/api/jobs/reminders   # 401 (its own auth, not the gate)
```

The browser asks for a username and password: any username, and the demo
password. Then sign in to the staff side with the account in DEMO.md.
