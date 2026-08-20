-- A-030 / D-29 — the exclusion constraint's unit becomes the BLOCK.
--
-- The D-2 invariant does not weaken here; it gets finer. Until now an
-- appointment was one tstzrange, and a range cannot express a hole, so a
-- colour's developing time was defended as if the provider were in the chair.
-- Now an appointment is one row per span she is ACTUALLY working, and the same
-- constraint — same key, same '[)', same active-status predicate, same
-- deferrability — ranges over those.
--
-- WHY A TRIGGER OWNS THE BLOCKS, as it already owned blockedStart/blockedEnd:
-- the property worth keeping is that no ORM call, script, psql session or
-- future migration can write an inconsistent range. If application code emitted
-- these rows, a path that forgot to would UNDER-block and double-book, and the
-- constraint could not tell. So the blocks are derived, in the database, from
-- data already on the appointment row.
--
-- WHY THE PATTERN IS SNAPSHOT ON THE APPOINTMENT rather than read from
-- ServiceSegment: identical reasoning to the buffer snapshot two columns above
-- it (D-18). The trigger must recompute on UPDATE without re-deriving which
-- service's segments applied at booking time — and re-splitting a service must
-- never silently re-cut an appointment already in the book. It also closes the
-- gap A-029 knowingly left behind, where the day grid redrew old appointments
-- from current segments.

-- ── 1. The snapshot ────────────────────────────────────────────────────────
-- Alternating minutes from the start of the BODY, beginning and ending with an
-- ACTIVE part: {45} is a cut, {50,40,30} is a colour, {60,35,25,30,30} is the
-- seeded balayage. Even indices (1st, 3rd, 5th) are worked; odd ones are gaps.
-- An EMPTY array means one continuous block, which is why no existing row needs
-- backfilling — every appointment booked before this migration is already
-- correct, the same trick A-029 used for services with no segment rows.
ALTER TABLE "Appointment" ADD COLUMN "segmentPattern" INTEGER[] NOT NULL DEFAULT '{}';

-- The parts must be positive and must add up to the body. A pattern that
-- disagreed with endAt would place blocks outside the appointment.
--
-- A CHECK cannot contain a subquery (verified: "cannot use subquery in check
-- constraint"), so the sum goes through an IMMUTABLE function covering all
-- three rules — odd count, every part positive, sums to the body.
--
-- IT RETURNS -1, NOT NULL, FOR A MALFORMED PATTERN, and that is the whole
-- point of this comment. A CHECK constraint PASSES when it evaluates to NULL
-- (SQL three-valued logic: only an explicit FALSE rejects the row), so a NULL
-- sentinel here made the constraint silently accept every malformed pattern —
-- including one ending on a gap, which would leave the last worked part
-- unblocked and let the database double-book it. A test caught it; the
-- sentinel is a real value so the comparison is definitively false.
CREATE OR REPLACE FUNCTION "appointment_pattern_minutes"(pattern INTEGER[])
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN cardinality(pattern) % 2 = 0 THEN -1
    WHEN EXISTS (SELECT 1 FROM unnest(pattern) p WHERE p <= 0) THEN -1
    ELSE (SELECT sum(p)::int FROM unnest(pattern) p)
  END
$$;

ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_segment_pattern_sums"
  CHECK (
    cardinality("segmentPattern") = 0
    OR "appointment_pattern_minutes"("segmentPattern") * 60
       = EXTRACT(EPOCH FROM ("endAt" - "startAt"))
  );

-- ── 2. The blocks ──────────────────────────────────────────────────────────
-- providerId and status are DENORMALISED here because a partial exclusion
-- constraint cannot join. They are written by the trigger below from the parent
-- and never by anything else, so the "a status enum is never one edit" trap
-- does not open: there is still exactly one writer, and the predicate below is
-- still asserted equal to ACTIVE_STATUSES by a test.
CREATE TABLE "AppointmentBlock" (
  "id"            TEXT PRIMARY KEY,
  "businessId"    TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "providerId"    TEXT NOT NULL,
  "status"        "AppointmentStatus" NOT NULL,
  "ordinal"       INTEGER NOT NULL,
  "blockedStart"  TIMESTAMPTZ(3) NOT NULL,
  "blockedEnd"    TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "appointment_block_well_formed" CHECK ("blockedEnd" >= "blockedStart")
);

-- Names match what Prisma derives from the model, so the drift check stays
-- silent — it compares names, not just shapes.
ALTER TABLE "AppointmentBlock"
  ADD CONSTRAINT "AppointmentBlock_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "AppointmentBlock_appointmentId_ordinal_key"
  ON "AppointmentBlock" ("appointmentId", "ordinal");
CREATE INDEX "AppointmentBlock_appointmentId_idx" ON "AppointmentBlock" ("appointmentId");
CREATE INDEX "AppointmentBlock_providerId_blockedStart_blockedEnd_idx"
  ON "AppointmentBlock" ("providerId", "blockedStart", "blockedEnd");

-- ── 3. THE INVARIANT, moved ────────────────────────────────────────────────
-- Byte-identical to the constraint it replaces except for the table it sits on:
-- same providerId key, same '[)' (with '[]' the salon can never book
-- consecutive clients), same predicate derived from ACTIVE_STATUSES (NOT the
-- terminal set — `completed` and `no_show` still occupy their time), same
-- DEFERRABLE INITIALLY IMMEDIATE so A-018's multi-row column push can still opt
-- into a commit-time check while ordinary bookings stay checked at statement
-- end and the nine race interleavings are unaffected.
ALTER TABLE "AppointmentBlock"
  ADD CONSTRAINT "appointment_block_no_overlap"
  EXCLUDE USING gist (
    "providerId" WITH =,
    tstzrange("blockedStart", "blockedEnd", '[)') WITH &&
  )
  WHERE (status NOT IN ('cancelled', 'cancelled_late'))
  DEFERRABLE INITIALLY IMMEDIATE;

-- ── 4. The trigger that fills it ───────────────────────────────────────────
-- Runs AFTER, because on INSERT the row must exist before a child can point at
-- it. Deletes and re-emits rather than diffing: an appointment has one to three
-- blocks, and a rewrite cannot leave a stale one behind.
--
-- The three shapes:
--   isOverride     → ONE zero-width block (D-8/D-16). An empty tstzrange
--                    participates in no `&&`, so the override is permitted
--                    without weakening the constraint, and the true range still
--                    lives in "overriddenFromRange" on the parent.
--   empty pattern  → ONE block, the whole [blockedStart, blockedEnd) envelope.
--                    Every pre-A-030 appointment, and every unsegmented one.
--   a pattern      → one block per ACTIVE part, walked from startAt on the
--                    PHYSICAL axis. `timestamptz + interval '<n> minutes'` adds
--                    exact physical minutes, so a colour that spans a DST
--                    transition keeps its true durations — the same rule the
--                    engine follows and the reason a 90-minute service starting
--                    01:30 on spring-forward day ends at 04:00 on the wall.
--                    The leading buffer extends the FIRST block back and the
--                    trailing buffer extends the LAST one forward; buffers are
--                    the visit's, never each part's (SEG-01).
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

  -- The trailing buffer belongs to the last worked part only. The CHECK above
  -- guarantees the pattern ends on an active part, so this row exists.
  UPDATE "AppointmentBlock"
     SET "blockedEnd" = "blockedEnd" + make_interval(mins => NEW."bufferAfterMinutes")
   WHERE "appointmentId" = NEW."id" AND "ordinal" = emitted - 1;

  RETURN NULL;
END $$;

CREATE TRIGGER "appointment_blocks"
  AFTER INSERT OR UPDATE ON "Appointment"
  FOR EACH ROW EXECUTE FUNCTION "appointment_write_blocks"();

-- ── 5. Backfill, then retire the old constraint ────────────────────────────
-- Every existing appointment has an empty pattern, so this emits exactly the
-- range the old constraint was already enforcing — the invariant is continuous
-- across the migration rather than briefly absent.
INSERT INTO "AppointmentBlock"
  ("id","businessId","appointmentId","providerId","status","ordinal","blockedStart","blockedEnd")
SELECT a."id" || '-b0', a."businessId", a."id", a."providerId", a."status", 0, a."blockedStart", a."blockedEnd"
  FROM "Appointment" a;

ALTER TABLE "Appointment" DROP CONSTRAINT "appointment_no_overlap";
