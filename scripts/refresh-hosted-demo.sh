#!/usr/bin/env bash
# Replace the hosted demo's book with a freshly seeded one (D-65).
#
# The live week is anchored to the day it was seeded, so run this before a
# demo. Seeding straight into Neon is one network round trip per row and took
# ~45 minutes; this seeds a local scratch database (~20 s) and bulk-copies it.
#
# Two tables are NOT copied: AppointmentBlock and AppointmentResourceHold.
# Triggers on Appointment derive both from the appointment row alone, so the
# copy regenerates them — and copying them too would duplicate every row.
# Neon refuses `session_replication_role`, so the triggers cannot be switched
# off. pg_dump also empties search_path, which the Client trigger's
# unqualified call to bookable_phone() cannot survive, so that one line is
# dropped from the stream. pg_dump's circular-FK warning is about Client's
# self-reference, which one COPY statement satisfies. The final step diffs
# both tables against the source to prove the
# regenerated rows are identical.
#
# Reads DIRECT_URL from .env.production.local (gitignored) and refuses any
# target that is not a Neon host.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# Both sides print timestamps in UTC, or the diff below compares Neon's GMT
# rendering with this laptop's America/Chicago one and fails on every row.
export PGTZ=UTC

TARGET=$(grep '^DIRECT_URL=' .env.production.local | cut -d= -f2- | tr -d '"')
case "$TARGET" in
  *.neon.tech/*) ;;
  *) echo "refusing: DIRECT_URL in .env.production.local is not a Neon host" >&2; exit 1 ;;
esac

BASE=$(grep -o 'postgresql://[^@]*@localhost:5432/' .env.test | head -1)
SRC_DB=bookable_hosted_src
SRC="${BASE}${SRC_DB}"
DEMO_EMAIL=owner@shear-genius.test
DEMO_PASSWORD=demo-owner-password

echo "1/5 seeding a local scratch book ($SRC_DB)"
dropdb --if-exists "$SRC_DB"
createdb "$SRC_DB"
DATABASE_URL="$SRC" DIRECT_URL="$SRC" npm run -s migrate:deploy -w packages/db > /dev/null
DATABASE_URL="$SRC" DIRECT_URL="$SRC" npx tsx packages/db/seed.ts
DATABASE_URL="$SRC" DIRECT_URL="$SRC" npx tsx -e "
import { PrismaClient } from './packages/db/generated/client/index.js';
import { seedStaffUser } from './packages/db/auth/seed-staff';
(async () => { const p = new PrismaClient();
  await seedStaffUser(p, { email: '$DEMO_EMAIL', password: '$DEMO_PASSWORD' });
  await p.\$disconnect(); })()"

echo "2/5 emptying the hosted book"
DATABASE_URL="$TARGET" DIRECT_URL="$TARGET" npx tsx -e "
import { PrismaClient } from './packages/db/generated/client/index.js';
import { resetDatabase } from './packages/db/testing/reset';
(async () => { const p = new PrismaClient(); await resetDatabase(p); await p.\$disconnect(); })()"

echo "3/5 copying the book (derived tables regenerate by trigger)"
pg_dump --data-only --no-owner --no-privileges \
  --exclude-table='"_prisma_migrations"' \
  --exclude-table='"AppointmentBlock"' \
  --exclude-table='"AppointmentResourceHold"' \
  "$SRC" 2> /dev/null \
  | sed "/set_config('search_path', '', false)/d" \
  | psql -q -v ON_ERROR_STOP=1 "$TARGET" > /dev/null

echo "4/5 proving the regenerated tables match the source"
for t in AppointmentBlock AppointmentResourceHold; do
  q="select * from \"$t\" order by 1"
  if ! diff <(psql -At "$SRC" -c "$q") <(psql -At "$TARGET" -c "$q") > /dev/null; then
    echo "MISMATCH in $t: the hosted copy differs from the source" >&2; exit 1
  fi
  echo "   $t: $(psql -At "$TARGET" -c "select count(*) from \"$t\"") rows, identical"
done
for t in Appointment Client AppointmentEvent StaffUser; do
  s=$(psql -At "$SRC" -c "select count(*) from \"$t\"")
  d=$(psql -At "$TARGET" -c "select count(*) from \"$t\"")
  [ "$s" = "$d" ] || { echo "COUNT MISMATCH in $t: $s vs $d" >&2; exit 1; }
  echo "   $t: $d rows"
done

echo "5/5 dropping the scratch book"
dropdb "$SRC_DB"
echo "done: the hosted book is fresh as of today"
