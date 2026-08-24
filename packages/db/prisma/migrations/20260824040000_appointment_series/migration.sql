-- A-049 — standing appointments ("every four weeks, same time").
--
-- The rule is stored on the CALENDAR axis and nowhere else: `anchorDay` is
-- CHAR(10) and `wallTime` is CHAR(5), never `date`/`time`/`timestamptz`. This
-- is the one table in the schema whose entire purpose is to survive a timezone
-- conversion it never performs — four weeks is 168 hours only when no clock
-- changes in between, and a series crossing spring-forward that stored an
-- instant plus a duration would move the client's appointment by an hour.
--
-- The OCCURRENCES are ordinary `Appointment` rows, materialised at creation.
-- They have to be: `appointment_block_no_overlap` (D-29) and the resource
-- constraint (D-30) can only defend rows that exist, and a computed-on-read
-- occurrence is a booking the database has never heard of.

CREATE TABLE "AppointmentSeries" (
  "id"             TEXT NOT NULL,
  "businessId"     TEXT NOT NULL,
  "providerId"     TEXT NOT NULL,
  "clientId"       TEXT,
  "anchorDay"      CHAR(10) NOT NULL,
  "wallTime"       CHAR(5)  NOT NULL,
  "intervalWeeks"  INTEGER  NOT NULL,
  "requested"      INTEGER  NOT NULL,
  "createdByActor" "Actor" DEFAULT 'staff',
  "actorRef"       TEXT,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "AppointmentSeries_pkey" PRIMARY KEY ("id"),
  -- The same shape guard the rule module enforces, at the level that cannot be
  -- bypassed by a script: a zero or negative interval is an infinite loop, and
  -- the cap stops a mistyped "600" writing six hundred rows into the book.
  CONSTRAINT "appointment_series_interval_positive" CHECK ("intervalWeeks" >= 1),
  CONSTRAINT "appointment_series_requested_sane"    CHECK ("requested" >= 1 AND "requested" <= 104)
);

ALTER TABLE "AppointmentSeries"
  ADD CONSTRAINT "AppointmentSeries_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentSeries"
  ADD CONSTRAINT "AppointmentSeries_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppointmentSeries"
  ADD CONSTRAINT "AppointmentSeries_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "AppointmentSeries_businessId_providerId_idx"
  ON "AppointmentSeries" ("businessId", "providerId");

-- The occurrence's link back to the rule it came from.
ALTER TABLE "Appointment"
  ADD COLUMN "seriesId"      TEXT,
  ADD COLUMN "seriesOrdinal" INTEGER;

-- SET NULL, not RESTRICT: deleting the RULE must never be capable of taking a
-- booked appointment with it. An occurrence that outlives its series is just an
-- ordinary appointment, which is what D-34 says one becomes the moment anybody
-- reschedules or cancels it anyway.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_seriesId_fkey"
  FOREIGN KEY ("seriesId") REFERENCES "AppointmentSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Appointment_seriesId_idx" ON "Appointment" ("seriesId");
