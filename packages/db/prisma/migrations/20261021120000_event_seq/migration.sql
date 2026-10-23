-- W-008 (API PRD §8). A per-business, gapless event sequence in COMMIT order,
-- and one snapshot per event for the webhook pipeline. Hand-written.
--
-- LOCK AUDIT (W-D18). The PRD hoped to number events under "the existing
-- business-row lock the booking path already takes". There is none: booking
-- takes an advisory lock on provider+day, reschedule its own key, transitions
-- the appointment row, and ten other writers take nothing business-wide. So
-- this is the PRD's fallback — a `BusinessEventSeq` row locked FOR UPDATE —
-- with one change: the number is handed out by a DEFERRED constraint trigger,
-- i.e. at COMMIT, after every other lock the transaction will ever take.
--   * Seq order is commit order: the row lock is held until the commit is
--     visible, so the next committer cannot number before it.
--   * No new deadlock: taken at insert time, a series booking (provider-day
--     lock, seq lock, next provider-day lock) and a single booking on that
--     second day would deadlock. Taken last, it waits on nothing.
--   * Gapless: a rolled-back transaction never fires a deferred trigger.
--   * Every writer is covered, including ones written later, because no
--     writer participates.

ALTER TABLE "AppointmentEvent" ADD COLUMN "seq" INTEGER;

CREATE TABLE "BusinessEventSeq" (
    "businessId" TEXT NOT NULL,
    "last" INTEGER NOT NULL,
    CONSTRAINT "BusinessEventSeq_pkey" PRIMARY KEY ("businessId")
);

CREATE TABLE "EventSnapshot" (
    "eventId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EventSnapshot_pkey" PRIMARY KEY ("eventId")
);

CREATE UNIQUE INDEX "AppointmentEvent_businessId_seq_key" ON "AppointmentEvent"("businessId", "seq");

ALTER TABLE "BusinessEventSeq" ADD CONSTRAINT "BusinessEventSeq_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "AppointmentEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill existing history in (createdAt, id) order — the best order the
-- log can reconstruct. The append-only trigger is lifted for this statement only.
ALTER TABLE "AppointmentEvent" DISABLE TRIGGER "appointment_event_no_update_delete";
UPDATE "AppointmentEvent" e SET "seq" = n.seq
  FROM (SELECT id, row_number() OVER (PARTITION BY "businessId" ORDER BY "createdAt", id)::int AS seq FROM "AppointmentEvent") n
 WHERE e.id = n.id;
ALTER TABLE "AppointmentEvent" ENABLE TRIGGER "appointment_event_no_update_delete";
INSERT INTO "BusinessEventSeq" ("businessId", "last")
  SELECT "businessId", max("seq") FROM "AppointmentEvent" GROUP BY "businessId";

-- Append-only, except that the seq trigger may fill `seq` once, from NULL,
-- with every other column unchanged.
CREATE OR REPLACE FUNCTION "appointment_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."seq" IS NULL AND NEW."seq" IS NOT NULL
     AND (to_jsonb(NEW) - 'seq') = (to_jsonb(OLD) - 'seq') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AppointmentEvent is append-only (attempted % on id=%)', TG_OP, OLD."id"
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE OR REPLACE FUNCTION "appointment_event_assign_seq"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE next_seq INTEGER;
BEGIN
  INSERT INTO "BusinessEventSeq" ("businessId", "last") VALUES (NEW."businessId", 1)
  ON CONFLICT ("businessId") DO UPDATE SET "last" = "BusinessEventSeq"."last" + 1
  RETURNING "last" INTO next_seq;
  UPDATE "AppointmentEvent" SET "seq" = next_seq WHERE "id" = NEW."id";
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "appointment_event_seq"
  AFTER INSERT ON "AppointmentEvent"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "appointment_event_assign_seq"();
