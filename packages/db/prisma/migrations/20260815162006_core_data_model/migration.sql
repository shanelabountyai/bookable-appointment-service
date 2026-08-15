-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('booked', 'confirmed', 'checked_in', 'in_progress', 'completed', 'no_show', 'cancelled', 'cancelled_late');

-- CreateEnum
CREATE TYPE "Actor" AS ENUM ('staff', 'customer_token', 'system');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('email', 'sms');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'sent', 'failed', 'suppressed');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('active', 'fulfilled', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "SegmentStatus" AS ENUM ('active', 'retired');

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "slotIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "minimumLeadMinutes" INTEGER NOT NULL DEFAULT 120,
    "cancellationCutoffMinutes" INTEGER NOT NULL DEFAULT 120,
    "noShowBlockThreshold" INTEGER NOT NULL DEFAULT 3,
    "bookingHorizonDays" INTEGER NOT NULL DEFAULT 90,
    "bufferMayOverlapBreak" BOOLEAN NOT NULL DEFAULT true,
    "bufferMayExtendPastClose" BOOLEAN NOT NULL DEFAULT true,
    "ambiguousLocalTime" TEXT NOT NULL DEFAULT 'offer-both',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffUser" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "bufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
    "bufferAfterMinutes" INTEGER NOT NULL DEFAULT 0,
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "cancellationCutoffMinutes" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceProvider" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "durationOverrideMinutes" INTEGER,
    "priceOverrideCents" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServiceProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceSegment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "isGap" BOOLEAN NOT NULL DEFAULT false,
    "status" "SegmentStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServiceSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceType" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ResourceType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "resourceTypeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyWindow" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT,
    "weekday" INTEGER NOT NULL,
    "open" CHAR(5) NOT NULL,
    "close" CHAR(5) NOT NULL,
    "endsNextDay" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WeeklyWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WindowBreak" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "weeklyWindowId" TEXT NOT NULL,
    "open" CHAR(5) NOT NULL,
    "close" CHAR(5) NOT NULL,

    CONSTRAINT "WindowBreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DateOverride" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT,
    "day" CHAR(10) NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DateOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DateOverrideWindow" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "dateOverrideId" TEXT NOT NULL,
    "open" CHAR(5) NOT NULL,
    "close" CHAR(5) NOT NULL,
    "endsNextDay" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DateOverrideWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeOff" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdHocBlock" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AdHocBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "smsConsentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "clientId" TEXT,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'booked',
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "bufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
    "bufferAfterMinutes" INTEGER NOT NULL DEFAULT 0,
    "blockedStart" TIMESTAMPTZ(3) NOT NULL,
    "blockedEnd" TIMESTAMPTZ(3) NOT NULL,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "overriddenFromRange" tstzrange,
    "idempotencyKey" TEXT,
    "startDay" CHAR(10) NOT NULL,
    "startWallTime" CHAR(5) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "checkedInAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentServiceLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "priceCents" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppointmentServiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor" "Actor" NOT NULL,
    "actorRef" TEXT,
    "reason" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManageToken" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManageToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "recipient" TEXT,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "providerIds" TEXT[],
    "fromDay" CHAR(10) NOT NULL,
    "toDay" CHAR(10) NOT NULL,
    "dayParts" TEXT[],
    "status" "WaitlistStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffUser_businessId_idx" ON "StaffUser"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_businessId_email_key" ON "StaffUser"("businessId", "email");

-- CreateIndex
CREATE INDEX "Provider_businessId_active_idx" ON "Provider"("businessId", "active");

-- CreateIndex
CREATE INDEX "Service_businessId_active_idx" ON "Service"("businessId", "active");

-- CreateIndex
CREATE INDEX "ServiceProvider_businessId_idx" ON "ServiceProvider"("businessId");

-- CreateIndex
CREATE INDEX "ServiceProvider_providerId_idx" ON "ServiceProvider"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceProvider_serviceId_providerId_key" ON "ServiceProvider"("serviceId", "providerId");

-- CreateIndex
CREATE INDEX "ServiceSegment_businessId_idx" ON "ServiceSegment"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceSegment_serviceId_ordinal_key" ON "ServiceSegment"("serviceId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceType_businessId_name_key" ON "ResourceType"("businessId", "name");

-- CreateIndex
CREATE INDEX "Resource_businessId_idx" ON "Resource"("businessId");

-- CreateIndex
CREATE INDEX "WeeklyWindow_businessId_providerId_weekday_idx" ON "WeeklyWindow"("businessId", "providerId", "weekday");

-- CreateIndex
CREATE INDEX "WindowBreak_weeklyWindowId_idx" ON "WindowBreak"("weeklyWindowId");

-- CreateIndex
CREATE INDEX "WindowBreak_businessId_idx" ON "WindowBreak"("businessId");

-- CreateIndex
CREATE INDEX "DateOverride_businessId_day_idx" ON "DateOverride"("businessId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DateOverride_businessId_providerId_day_key" ON "DateOverride"("businessId", "providerId", "day");

-- CreateIndex
CREATE INDEX "DateOverrideWindow_dateOverrideId_idx" ON "DateOverrideWindow"("dateOverrideId");

-- CreateIndex
CREATE INDEX "DateOverrideWindow_businessId_idx" ON "DateOverrideWindow"("businessId");

-- CreateIndex
CREATE INDEX "TimeOff_businessId_providerId_startAt_endAt_idx" ON "TimeOff"("businessId", "providerId", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "AdHocBlock_businessId_providerId_startAt_endAt_idx" ON "AdHocBlock"("businessId", "providerId", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "Client_businessId_phone_idx" ON "Client"("businessId", "phone");

-- CreateIndex
CREATE INDEX "Client_businessId_name_idx" ON "Client"("businessId", "name");

-- CreateIndex
CREATE INDEX "Appointment_providerId_blockedStart_blockedEnd_idx" ON "Appointment"("providerId", "blockedStart", "blockedEnd");

-- CreateIndex
CREATE INDEX "Appointment_businessId_startDay_idx" ON "Appointment"("businessId", "startDay");

-- CreateIndex
CREATE INDEX "Appointment_businessId_status_idx" ON "Appointment"("businessId", "status");

-- CreateIndex
CREATE INDEX "Appointment_clientId_idx" ON "Appointment"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_businessId_idempotencyKey_key" ON "Appointment"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AppointmentServiceLine_businessId_idx" ON "AppointmentServiceLine"("businessId");

-- CreateIndex
CREATE INDEX "AppointmentServiceLine_serviceId_idx" ON "AppointmentServiceLine"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentServiceLine_appointmentId_ordinal_key" ON "AppointmentServiceLine"("appointmentId", "ordinal");

-- CreateIndex
CREATE INDEX "AppointmentEvent_appointmentId_createdAt_idx" ON "AppointmentEvent"("appointmentId", "createdAt");

-- CreateIndex
CREATE INDEX "AppointmentEvent_businessId_createdAt_idx" ON "AppointmentEvent"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManageToken_tokenHash_key" ON "ManageToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ManageToken_appointmentId_idx" ON "ManageToken"("appointmentId");

-- CreateIndex
CREATE INDEX "ManageToken_businessId_idx" ON "ManageToken"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_dedupeKey_key" ON "NotificationOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_businessId_status_idx" ON "NotificationOutbox"("businessId", "status");

-- CreateIndex
CREATE INDEX "WaitlistEntry_businessId_status_idx" ON "WaitlistEntry"("businessId", "status");

-- CreateIndex
CREATE INDEX "WaitlistEntry_clientId_idx" ON "WaitlistEntry"("clientId");

-- AddForeignKey
ALTER TABLE "StaffUser" ADD CONSTRAINT "StaffUser_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceProvider" ADD CONSTRAINT "ServiceProvider_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceProvider" ADD CONSTRAINT "ServiceProvider_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceSegment" ADD CONSTRAINT "ServiceSegment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceType" ADD CONSTRAINT "ResourceType_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_resourceTypeId_fkey" FOREIGN KEY ("resourceTypeId") REFERENCES "ResourceType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyWindow" ADD CONSTRAINT "WeeklyWindow_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyWindow" ADD CONSTRAINT "WeeklyWindow_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WindowBreak" ADD CONSTRAINT "WindowBreak_weeklyWindowId_fkey" FOREIGN KEY ("weeklyWindowId") REFERENCES "WeeklyWindow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DateOverride" ADD CONSTRAINT "DateOverride_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DateOverride" ADD CONSTRAINT "DateOverride_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DateOverrideWindow" ADD CONSTRAINT "DateOverrideWindow_dateOverrideId_fkey" FOREIGN KEY ("dateOverrideId") REFERENCES "DateOverride"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdHocBlock" ADD CONSTRAINT "AdHocBlock_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdHocBlock" ADD CONSTRAINT "AdHocBlock_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentServiceLine" ADD CONSTRAINT "AppointmentServiceLine_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentServiceLine" ADD CONSTRAINT "AppointmentServiceLine_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManageToken" ADD CONSTRAINT "ManageToken_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManageToken" ADD CONSTRAINT "ManageToken_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN SECTION (A-003). Prisma cannot express any of the below.
--
-- Do NOT regenerate this migration, and NEVER edit it once applied — add a new
-- migration instead. `prisma db push` is banned on this project entirely: it
-- would silently drop everything from here down.
--
-- Sources: 07-decisions.md D-2, D-8, D-15, D-16; 00-master-prd.md §6;
-- docs/reviews/03-slot-engine-spec.md §4.2 (whose literal predicate is
-- SUPERSEDED by D-15 — see the note in that section).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. btree_gist ──────────────────────────────────────────────────────────
-- REQUIRED. Without it, `"providerId" WITH =` in a gist index fails with
-- "data type text has no default operator class for access method gist".
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── 2. Whole-minute instants ───────────────────────────────────────────────
-- Half-open [start, end) back-to-back booking depends on
-- `A."blockedEnd" = B."blockedStart"` EXACTLY. One stray millisecond anywhere
-- in the write path turns "back-to-back" into either a false conflict or a 1ms
-- bookable hole, and the symptom is "why isn't 11:00 offered?" with every test
-- green.
--
-- EXTRACT(EPOCH FROM timestamptz) is IMMUTABLE (verified), so it is legal in a
-- CHECK; date_trunc('minute', ...) is not, because it is STABLE.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_instants_whole_minutes" CHECK (
    EXTRACT(EPOCH FROM "startAt")::bigint      % 60 = 0 AND
    EXTRACT(EPOCH FROM "endAt")::bigint        % 60 = 0 AND
    EXTRACT(EPOCH FROM "blockedStart")::bigint % 60 = 0 AND
    EXTRACT(EPOCH FROM "blockedEnd")::bigint   % 60 = 0
  );

-- An appointment must not end before it starts. Zero-length is refused too:
-- a zero-length BODY is meaningless (the zero-width case that D-8 needs is the
-- BLOCKED range, which is a different pair of columns).
ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_end_after_start" CHECK ("endAt" > "startAt");

-- D-8/D-16 consistency, made structural: an override row carries its true
-- intended range, and a non-override row must not.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_override_range_iff_override" CHECK (
    ("isOverride" = true  AND "overriddenFromRange" IS NOT NULL) OR
    ("isOverride" = false AND "overriddenFromRange" IS NULL)
  );

-- ── 3. The blocked range is written by trigger, never by application code ───
-- blockedStart/blockedEnd CANNOT be generated columns: `timestamptz + interval`
-- (timestamptz_pl_interval) is STABLE, not IMMUTABLE — verified against PG17,
-- which rejects the column outright with "generation expression is not
-- immutable". A trigger is the next-best thing and is strictly better than
-- app-side computation, because no ORM call, script, or psql session can write
-- an inconsistent range.
--
-- D-8: a staff override writes a ZERO-WIDTH blocked range. An empty tstzrange
-- participates in no `&&`, so the constraint is satisfied without being
-- weakened — the database never lies, and the day view still renders the true
-- collision from "overriddenFromRange".
CREATE OR REPLACE FUNCTION "appointment_write_blocked_range"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."isOverride" THEN
    NEW."blockedStart" := NEW."startAt";
    NEW."blockedEnd"   := NEW."startAt";
    NEW."overriddenFromRange" := tstzrange(
      NEW."startAt" - make_interval(mins => NEW."bufferBeforeMinutes"),
      NEW."endAt"   + make_interval(mins => NEW."bufferAfterMinutes"),
      '[)'
    );
  ELSE
    NEW."blockedStart" := NEW."startAt" - make_interval(mins => NEW."bufferBeforeMinutes");
    NEW."blockedEnd"   := NEW."endAt"   + make_interval(mins => NEW."bufferAfterMinutes");
    NEW."overriddenFromRange" := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "appointment_blocked_range"
  BEFORE INSERT OR UPDATE ON "Appointment"
  FOR EACH ROW EXECUTE FUNCTION "appointment_write_blocked_range"();

-- ── 4. THE INVARIANT: no double-booking, enforced by the database ──────────
-- D-2. Every code path — app, script, psql, a future migration — is refused.
-- This is why the project is Postgres from commit one: SQLite cannot declare
-- this constraint at all, so the headline correctness metric would be
-- unfalsifiable (spec §4.4).
--
-- '[)' is MANDATORY. With '[]', back-to-back appointments abut at a shared
-- endpoint and are rejected as conflicts, and the salon can never book
-- consecutive clients — which is most of a working day.
--
-- The partial predicate is D-15, derived from packages/core/scheduling/status.ts
-- (ACTIVE_STATUSES). It is NOT `<> 'cancelled'` (the spec's literal SQL, which
-- predates D-7's split and would leave every late cancellation blocking its own
-- slot forever), and it is NOT "the terminal set" (which would wrongly free
-- `completed` and `no_show`, both of which still occupy their time).
--
-- A test asserts this predicate still equals ACTIVE_STATUSES, so the SQL and the
-- TypeScript cannot drift apart silently.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist (
    "providerId" WITH =,
    tstzrange("blockedStart", "blockedEnd", '[)') WITH &&
  )
  WHERE (status NOT IN ('cancelled', 'cancelled_late'));

-- ── 5. AppointmentEvent is append-only ─────────────────────────────────────
-- §6. FKs into this table are onDelete: Restrict on purpose — a SetNull cascade
-- hits this trigger and fails at runtime, which the rental build learned twice.
CREATE OR REPLACE FUNCTION "appointment_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AppointmentEvent is append-only (attempted % on id=%)', TG_OP, OLD."id"
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER "appointment_event_no_update_delete"
  BEFORE UPDATE OR DELETE ON "AppointmentEvent"
  FOR EACH ROW EXECUTE FUNCTION "appointment_event_append_only"();

-- ── 6. Exactly one ACTIVE segment per service in v1 (D-12) ──────────────────
CREATE UNIQUE INDEX "ServiceSegment_one_active_per_service"
  ON "ServiceSegment" ("serviceId")
  WHERE (status = 'active');
