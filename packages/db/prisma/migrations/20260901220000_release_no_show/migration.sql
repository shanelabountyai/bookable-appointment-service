-- A-069 / D-44, APPT-03 + BOOK-05 — A NO-SHOW'S DEAD TIME, OFFERED BACK.
--
-- A 10:00 colour, ninety minutes. At 10:20 the desk gives up and marks her a
-- no-show, and that time stays blocked for another seventy minutes. A walk-in
-- at 10:25 can then only be booked into it through a BOOK-05 override with a
-- typed reason — a FALSE OVERRIDE MARKER on a slot that is genuinely empty,
-- which is the fastest way to train the desk to dismiss the marker D-8 rests
-- on. It is not on `/staff/opened` either, because nothing freed it.
--
-- THIS DOES NOT RE-OPEN D-7, and the shape of the change is what guarantees
-- that rather than a promise in a comment. `no_show` stays in
-- `ACTIVE_STATUSES`, stays in the constraint predicate, and stays in the busy
-- set: it occupies its time, which is right for the record, for utilization
-- and for the client's twelve-month count, and half the product reads that.
-- What was missing was never an enum change but a separate ACTION.
--
-- WHY A CUT RATHER THAN D-8'S ZERO-WIDTH MARKER (OQ-17 → D-44). Three reasons,
-- and the first settles it:
--
--   1. `dashboard.ts` sums `endAt - startAt` and `reliability.ts` counts by
--      `status`. A change confined to `blockedEnd` cannot reach either, so
--      utilization and the no-show count come out untouched BY CONSTRUCTION
--      rather than by a filter somebody has to remember. The zero-width shape
--      would instead leave occupancy readable as nothing at all.
--   2. The cut is TRUE. She had that chair from 10:00 until the desk gave up.
--      Nobody wants to sell 10:00 at 10:25, and freeing it would be a lie.
--   3. It composes with A-067 for nothing: the released span is
--      [releasedAt, the old blocked end) and reaches the freed-slot list
--      derived, like every other span on it.
--
-- WHAT THE AFTER-BUFFER DOES: nothing. The buffer is clean-down time for a
-- client who sat in the chair, and she never came. `blockedEnd := releasedAt`
-- exactly. The next booking still brings its own before-buffer.

-- ── 1. The cut ─────────────────────────────────────────────────────────────
-- NULL means "not released", which is every appointment that has ever existed
-- and almost every one that ever will. Never automatic (D-44): the instant is
-- chosen by a person, because releasing at N minutes past resells a slot to a
-- client stuck in traffic eight minutes away.
ALTER TABLE "Appointment" ADD COLUMN "releasedAt" TIMESTAMPTZ(3);

-- Releasing before she was due, or at/after her time was over, is not a cut —
-- it is a bug or a no-op, and the database says so rather than silently
-- producing a backwards range the exclusion constraint would then reject with
-- a message about overlaps.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_released_within_visit"
  CHECK ("releasedAt" IS NULL OR ("releasedAt" >= "startAt" AND "releasedAt" < "endAt"));

-- ── 2. The blocked range honours it, and ONLY for a no-show ────────────────
-- Guarded on the STATUS, not merely written by a mutator that checks it. The
-- desk has seven days to CORRECT a no-show back (APPT-06), and a release that
-- outlived the status it belongs to would leave a `booked` appointment
-- occupying twenty minutes of its own ninety. Structural, so no transition
-- path has to remember — the same reflex as deriving the predicate below from
-- one status module. Correcting her back therefore restores the full range,
-- and if the freed time has since been sold the UPDATE is refused by the
-- exclusion constraint, which is the honest answer to "put her back".
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
    IF NEW."status" = 'no_show' AND NEW."releasedAt" IS NOT NULL THEN
      -- A-069. No after-buffer: it is clean-down for somebody who sat down.
      NEW."blockedEnd" := NEW."releasedAt";
    ELSE
      NEW."blockedEnd" := NEW."endAt" + make_interval(mins => NEW."bufferAfterMinutes");
    END IF;
    NEW."overriddenFromRange" := NULL;
  END IF;
  RETURN NEW;
END $$;

-- ── 3. The per-block ranges follow (D-29) ──────────────────────────────────
-- The busy set and `appointment_block_no_overlap` both read `AppointmentBlock`,
-- so the cut has to reach the blocks or the parent row and the invariant would
-- disagree — the parent saying the time is free and the constraint still
-- refusing to sell it. A segmented colour released mid-develop loses the whole
-- second worked part and keeps a truncated first one, which is exactly what
-- happened in the room.
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

  -- A-069. The cut, applied to the blocks the same way it was applied to the
  -- parent: everything starting at or after it goes, everything straddling it
  -- is truncated to it. `NEW."blockedEnd"` is the released instant itself
  -- (set above), so this is the parent's own answer rather than a second copy
  -- of the arithmetic.
  IF NEW."status" = 'no_show' AND NEW."releasedAt" IS NOT NULL THEN
    UPDATE "AppointmentBlock"
       SET "blockedEnd" = NEW."blockedEnd"
     WHERE "appointmentId" = NEW."id" AND "blockedEnd" > NEW."blockedEnd";
    DELETE FROM "AppointmentBlock"
     WHERE "appointmentId" = NEW."id" AND "blockedEnd" <= "blockedStart";
  END IF;

  RETURN NULL;
END $$;
