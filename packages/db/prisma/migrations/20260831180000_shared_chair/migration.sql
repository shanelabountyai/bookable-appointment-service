-- A-063 / RES-02, D-17, D-30 — THE CHAIR FOLLOWS THE CLIENT, NOT THE PROVIDER.
--
-- The supported way to do "cut with Dana, then colour with Priya" is two
-- appointments: two providers never collide on the provider axis, so both are
-- accepted and the desk gets what it asked for. But the hold spans the whole
-- ENVELOPE — body plus buffers (RES-02) — so the cut's after-buffer and the
-- colour's before-buffer overlap, and for those minutes one client held TWO of
-- four chairs. The room then reported full and refused a real client on the
-- authority of a chair with nobody in it. Proved reachable against the seeded
-- catalogue before a line of this was written: Cut (after 10) into Colour
-- (before 10) is a twenty-minute double hold.
--
-- No client-axis check could have noticed, deliberately — D-17 rules one out to
-- protect the mother-and-daughter case, and that decision is right. This is an
-- unnoticed consequence of it, and the fix is on the RESOURCE axis only.
--
-- WHY TWO CONSTRAINTS NOW, AND NOT ONE RELAXED ONE. Sharing a chair is only
-- ever right when the two visits are SEQUENTIAL and it is the buffers that
-- overlap — the same person walking from one stylist to the next has one body
-- and needs one chair. Mother and daughter under one phone number (D-17's own
-- case) are two bodies at the same time and need two, and a single relaxed
-- constraint keyed on the client would have let them share. So:
--
--   * envelopes may overlap only for the SAME holder  (buffers, the fix)
--   * bodies may never overlap, whoever the holder is (two bodies, two chairs)
--
-- The second is the stronger statement and the one that keeps the database the
-- enforcer rather than the chooser (D-2): `findFreeResource` decides WHICH
-- chair, these decide what is admissible, and a chooser bug still lands as a
-- refusal instead of as a client sitting in somebody's lap.

-- ── 1. Who is holding, and the body inside the envelope ────────────────────
-- `holderKey` is the client, or the appointment's own id when there is no
-- client (a staff booking for a walk-in nobody has named yet). COALESCE, not a
-- nullable column: `NULL <> NULL` is NULL, never TRUE, so a nullable key would
-- silently let every anonymous appointment in the salon share one chair — the
-- exact bug being fixed, mirrored.
ALTER TABLE "AppointmentResourceHold" ADD COLUMN "holderKey" TEXT;
ALTER TABLE "AppointmentResourceHold" ADD COLUMN "bodyStart" TIMESTAMPTZ(3);
ALTER TABLE "AppointmentResourceHold" ADD COLUMN "bodyEnd"   TIMESTAMPTZ(3);

UPDATE "AppointmentResourceHold" h
   SET "holderKey" = COALESCE(a."clientId", 'appt:' || a."id"),
       "bodyStart" = a."startAt",
       "bodyEnd"   = a."endAt"
  FROM "Appointment" a
 WHERE a."id" = h."appointmentId";

ALTER TABLE "AppointmentResourceHold" ALTER COLUMN "holderKey" SET NOT NULL;
ALTER TABLE "AppointmentResourceHold" ALTER COLUMN "bodyStart" SET NOT NULL;
ALTER TABLE "AppointmentResourceHold" ALTER COLUMN "bodyEnd"   SET NOT NULL;

-- ── 2. The envelope invariant, now keyed on the holder ─────────────────────
-- Same predicate, same '[)', same DEFERRABLE INITIALLY IMMEDIATE as before —
-- A-018's column push still moves a whole column's chairs inside one
-- transaction. The only change is `"holderKey" WITH <>`: a conflict is raised
-- only when ALL THREE operators are true, so two overlapping envelopes are
-- refused for different holders and permitted for the same one.
ALTER TABLE "AppointmentResourceHold" DROP CONSTRAINT "appointment_resource_no_overlap";
ALTER TABLE "AppointmentResourceHold"
  ADD CONSTRAINT "appointment_resource_no_overlap"
  EXCLUDE USING gist (
    "resourceId" WITH =,
    "holderKey"  WITH <>,
    tstzrange("blockedStart", "blockedEnd", '[)') WITH &&
  )
  WHERE (status NOT IN ('cancelled', 'cancelled_late'))
  DEFERRABLE INITIALLY IMMEDIATE;

-- ── 3. TWO BODIES NEVER SHARE A CHAIR ──────────────────────────────────────
-- Unconditional on the holder: this is the physical fact the whole resource
-- axis exists to model. It is what stops the relaxation above from becoming a
-- licence for D-17's mother and daughter to be seated in one chair, and it is
-- checked for every appointment, not only for the ones that share a client.
ALTER TABLE "AppointmentResourceHold"
  ADD CONSTRAINT "appointment_resource_body_no_overlap"
  EXCLUDE USING gist (
    "resourceId" WITH =,
    tstzrange("bodyStart", "bodyEnd", '[)') WITH &&
  )
  WHERE (status NOT IN ('cancelled', 'cancelled_late'))
  DEFERRABLE INITIALLY IMMEDIATE;

-- ── 4. The trigger keeps writing the whole row ─────────────────────────────
-- Still the only writer of a hold, for the reason A-031 gave: no ORM call,
-- script or psql session can write one that disagrees with its appointment.
-- It now derives the holder and the body from the same NEW row as the
-- envelope, so the three can never drift apart.
CREATE OR REPLACE FUNCTION "appointment_write_resource_hold"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "AppointmentResourceHold" WHERE "appointmentId" = NEW."id";

  IF NEW."resourceId" IS NOT NULL THEN
    INSERT INTO "AppointmentResourceHold"
      ("id","businessId","appointmentId","resourceId","status","holderKey",
       "blockedStart","blockedEnd","bodyStart","bodyEnd")
    VALUES (NEW."id" || '-r', NEW."businessId", NEW."id", NEW."resourceId", NEW."status",
            COALESCE(NEW."clientId", 'appt:' || NEW."id"),
            NEW."blockedStart", NEW."blockedEnd", NEW."startAt", NEW."endAt");
  END IF;

  RETURN NULL;
END $$;
