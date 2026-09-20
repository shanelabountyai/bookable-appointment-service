-- A-127 / D-44, D-29 — RELEASING A SEGMENTED NO-SHOW CRASHED.
--
-- A-069's block cut ran its UPDATE before its DELETE, so every block starting
-- after the release instant was truncated to a BACKWARDS range and the CHECK
-- `appointment_block_well_formed` threw 23514 before the DELETE ran. A Cut has
-- one block and cannot reach it; a colour or balayage released before its last
-- worked block began always did — the most valuable dead time of the day,
-- unreleasable. Same function, the two statements in the right order.
--
-- No backfill: a release that hit this rolled back whole, so no row on any
-- book carries a half-applied cut. The chair hold (A-074) is one row spanning
-- the whole visit and has no per-part ranges, so it never had this defect.

CREATE OR REPLACE FUNCTION "appointment_write_blocks"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  part_minutes INTEGER;
  idx          INTEGER := 0;
  emitted      INTEGER := 0;
  cursor_at    TIMESTAMPTZ := NEW."startAt";
  block_start  TIMESTAMPTZ;
BEGIN
  DELETE FROM "AppointmentBlock" WHERE "appointmentId" = NEW."id";

  IF NEW."isOverride" OR cardinality(NEW."segmentPattern") = 0 THEN
    INSERT INTO "AppointmentBlock"
      ("id","businessId","appointmentId","providerId","status","ordinal","blockedStart","blockedEnd")
    VALUES (NEW."id" || '-b0', NEW."businessId", NEW."id", NEW."providerId", NEW."status", 0,
            NEW."blockedStart", NEW."blockedEnd");
    RETURN NULL;
  END IF;

  FOREACH part_minutes IN ARRAY NEW."segmentPattern" LOOP
    IF idx % 2 = 0 THEN
      block_start := cursor_at;
      -- The visit's leading buffer belongs to the first worked part only.
      IF emitted = 0 THEN
        block_start := block_start - make_interval(mins => NEW."bufferBeforeMinutes");
      END IF;
      INSERT INTO "AppointmentBlock"
        ("id","businessId","appointmentId","providerId","status","ordinal","blockedStart","blockedEnd")
      VALUES (NEW."id" || '-b' || emitted, NEW."businessId", NEW."id", NEW."providerId", NEW."status",
              emitted, block_start, cursor_at + make_interval(mins => part_minutes));
      emitted := emitted + 1;
    END IF;
    cursor_at := cursor_at + make_interval(mins => part_minutes);
    idx := idx + 1;
  END LOOP;

  -- The trailing buffer belongs to the last worked part only. The CHECK
  -- guarantees the pattern ends on an active part, so this row exists.
  UPDATE "AppointmentBlock"
     SET "blockedEnd" = "blockedEnd" + make_interval(mins => NEW."bufferAfterMinutes")
   WHERE "appointmentId" = NEW."id" AND "ordinal" = emitted - 1;

  -- A-069, reordered by A-127. The cut, applied to the blocks the same way it
  -- was applied to the parent: everything starting at or after it goes, then
  -- everything straddling it is truncated to it. DELETE FIRST — truncating a
  -- block that starts after the cut writes `blockedEnd < blockedStart`, and
  -- `appointment_block_well_formed` refuses that row before a later DELETE
  -- could remove it. `NEW."blockedEnd"` is the released instant itself.
  IF NEW."status" = 'no_show' AND NEW."releasedAt" IS NOT NULL THEN
    DELETE FROM "AppointmentBlock"
     WHERE "appointmentId" = NEW."id" AND "blockedStart" >= NEW."blockedEnd";
    UPDATE "AppointmentBlock"
       SET "blockedEnd" = NEW."blockedEnd"
     WHERE "appointmentId" = NEW."id" AND "blockedEnd" > NEW."blockedEnd";
  END IF;

  RETURN NULL;
END $$;
