-- A-031 / D-30 — the chair becomes a thing the database defends.
--
-- D-20 ruled this axis out of v1 on one premise: for a 4-chair salon with 4
-- stylists the pool never binds. A-030 removed that premise. Gap booking exists
-- SO THAT a client can occupy a chair while her provider works on someone else,
-- so four stylists can now put eight clients in four chairs and every booking is
-- accepted. This migration is the consequence of shipped work.
--
-- WHY A SECOND TABLE RATHER THAN A COLUMN ON "AppointmentBlock":
-- a block is a span the PROVIDER is working. A chair is held for the whole
-- appointment, GAPS INCLUDED — the developing hour is exactly when the client is
-- most certainly sitting in it. The two occupancies are different sets, and that
-- difference is the entire epic (RES-02).
--
-- WHY NAMED CHAIRS AND NOT A CAPACITY NUMBER (D-30): a Postgres exclusion
-- constraint cannot express "at most N overlapping" — that is cardinality, not
-- overlap — so a capacity number could only ever be a count-then-write, which is
-- the pattern D-2 exists to forbid and which two concurrent transactions defeat.
-- N named chairs turn one cardinality question into N ordinary overlap
-- questions, and those the database answers absolutely.

-- ── 1. What a service needs ────────────────────────────────────────────────
-- NULL means "needs no resource" — a phone consult, and every service in every
-- business that has not defined resources at all. That nullability is what makes
-- this migration additive: nothing existing changes behaviour.
ALTER TABLE "Service" ADD COLUMN "requiredResourceTypeId" TEXT;
ALTER TABLE "Service"
  ADD CONSTRAINT "Service_requiredResourceTypeId_fkey"
  FOREIGN KEY ("requiredResourceTypeId") REFERENCES "ResourceType"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. Which chair this appointment got ────────────────────────────────────
-- Chosen by the booking path (first free of the required type), never typed by
-- a human. NULL means no chair is held: a service that needs none, a business
-- with no resources defined, or a staff override — which deliberately holds no
-- chair for the same reason D-8's override writes a zero-width provider range.
-- The constraint must never be the thing that refuses staff a knowing decision.
ALTER TABLE "Appointment" ADD COLUMN "resourceId" TEXT;
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "Resource"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 3. The hold, and THE INVARIANT ─────────────────────────────────────────
CREATE TABLE "AppointmentResourceHold" (
  "id"            TEXT PRIMARY KEY,
  "businessId"    TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "resourceId"    TEXT NOT NULL,
  "status"        "AppointmentStatus" NOT NULL,
  "blockedStart"  TIMESTAMPTZ(3) NOT NULL,
  "blockedEnd"    TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "appointment_resource_hold_well_formed" CHECK ("blockedEnd" >= "blockedStart")
);

ALTER TABLE "AppointmentResourceHold"
  ADD CONSTRAINT "AppointmentResourceHold_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentResourceHold"
  ADD CONSTRAINT "AppointmentResourceHold_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "AppointmentResourceHold_appointmentId_key"
  ON "AppointmentResourceHold" ("appointmentId");
CREATE INDEX "AppointmentResourceHold_resourceId_blockedStart_blockedEnd_idx"
  ON "AppointmentResourceHold" ("resourceId", "blockedStart", "blockedEnd");

-- Same predicate as the provider axis, derived from the same ACTIVE_STATUSES
-- (D-15): completed and no_show still hold their chair, only the cancellations
-- free it. Same '[)' so back-to-back clients can share a chair at the boundary.
-- Same DEFERRABLE INITIALLY IMMEDIATE so A-018's column push can move a whole
-- column's chairs inside one transaction.
ALTER TABLE "AppointmentResourceHold"
  ADD CONSTRAINT "appointment_resource_no_overlap"
  EXCLUDE USING gist (
    "resourceId" WITH =,
    tstzrange("blockedStart", "blockedEnd", '[)') WITH &&
  )
  WHERE (status NOT IN ('cancelled', 'cancelled_late'))
  DEFERRABLE INITIALLY IMMEDIATE;

-- ── 4. Written by trigger, like every other range in this schema ───────────
-- Same reasoning as the block trigger and the blocked-range trigger before it:
-- no ORM call, script or psql session can write a hold that disagrees with its
-- appointment, and a write path that forgot to emit one would silently stop
-- holding a chair.
--
-- The envelope is "blockedStart"/"blockedEnd" — body plus buffers, gaps
-- included — which is exactly what those columns became when A-030 moved the
-- provider invariant off them (D-29). They are the appointment's outer extent
-- and this is now their load-bearing use.
CREATE OR REPLACE FUNCTION "appointment_write_resource_hold"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "AppointmentResourceHold" WHERE "appointmentId" = NEW."id";

  IF NEW."resourceId" IS NOT NULL THEN
    INSERT INTO "AppointmentResourceHold"
      ("id","businessId","appointmentId","resourceId","status","blockedStart","blockedEnd")
    VALUES (NEW."id" || '-r', NEW."businessId", NEW."id", NEW."resourceId", NEW."status",
            NEW."blockedStart", NEW."blockedEnd");
  END IF;

  RETURN NULL;
END $$;

CREATE TRIGGER "appointment_resource_hold"
  AFTER INSERT OR UPDATE ON "Appointment"
  FOR EACH ROW EXECUTE FUNCTION "appointment_write_resource_hold"();
