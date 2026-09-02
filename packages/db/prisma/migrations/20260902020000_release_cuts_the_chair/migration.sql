-- A-074 / RES-02, D-44 — THE RELEASE HAS TO CUT THE CHAIR'S BODY TOO.
--
-- A-069 added a fourth way for an appointment's occupancy to change — a CUT —
-- and told the two triggers that write `blockedStart`/`blockedEnd`. Its own
-- header comment then claimed that "the exclusion constraint, the busy set, THE
-- CHAIR HOLDS and the engine all read the ranges the trigger writes, so every
-- one of them follows without knowing this file exists."
--
-- Half of that is true. The chair hold's ENVELOPE follows, because the trigger
-- below copies `NEW."blockedStart"`/`NEW."blockedEnd"` straight out of the row.
-- Its BODY does not: `bodyStart`/`bodyEnd` are written from `NEW."startAt"` and
-- `NEW."endAt"`, which the release deliberately does not move — and A-063's
-- `appointment_resource_body_no_overlap` is UNCONDITIONAL on the holder.
--
-- The consequence, verified by running it rather than reading it: the desk
-- marks a 10:00 colour a no-show at 10:20 and releases it, the day grid paints
-- a bookable "45 min free" chip over the tail (gaps derive from the busy set,
-- which reads the cut envelope), the walk-in at 10:30 taps it, and the room
-- answers `NoResourceFree: Every Chair is taken for that time` — on a chair
-- with nobody in it. That is A-063's stated harm word for word, and it is the
-- offered-then-refused class this repo has now caught three times. The desk's
-- only way through is a BOOK-05 override on empty time, which is precisely the
-- training A-069 was built to prevent.
--
-- THE LESSON, now a CLAUDE.md rule: when a new column changes what a range
-- MEANS, the readers to grep for are not the ones that read that column. They
-- are the ones that keep the SAME FACT under a different name. `blockedEnd` and
-- `bodyEnd` are the same fact — where she stops being in the chair — and only
-- one of them was told.
--
-- This does NOT re-open D-7 or D-44. It is the body range following a cut the
-- parent row has already made: no status moves, `startAt` and `endAt` are
-- untouched, and utilization and the twelve-month count cannot see it.

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
            NEW."blockedStart", NEW."blockedEnd",
            NEW."startAt",
            -- A-074. She was not in the chair after the desk gave up on her.
            -- Guarded on the STATUS as well as the column, exactly as the
            -- blocked-range trigger is, so an APPT-06 correction off `no_show`
            -- restores the whole body with no transition path having to
            -- remember — and is then refused by the constraint if the freed
            -- time has been sold, which is the honest answer.
            --
            -- `releasedAt = startAt` yields an EMPTY body range, which
            -- participates in no `&&` and is exactly right: released before she
            -- ever sat down means she occupied no chair at all. The CHECK
            -- `appointment_released_within_visit` keeps it inside the visit, so
            -- this can never invert.
            CASE
              WHEN NEW."status" = 'no_show' AND NEW."releasedAt" IS NOT NULL
                THEN NEW."releasedAt"
              ELSE NEW."endAt"
            END);
  END IF;

  RETURN NULL;
END $$;

-- Re-derive every existing hold through the corrected trigger. A no-op on a
-- fresh install and on any book with nothing released; on one where A-069 has
-- already been used it is the difference between a chair the room refuses and
-- a chair the room sells. Touching only the rows that can differ.
UPDATE "Appointment" SET "id" = "id" WHERE "releasedAt" IS NOT NULL;
