-- A-061 — "we already rang her."
--
-- Eighteen unconfirmed for tomorrow, the desk gets through nine, three of them
-- no answer, then the phone rings and a walk-in arrives. At 4pm the list looks
-- exactly as it did at 2pm, so somebody starts at the top and rings six people
-- twice — which reads as chaos to the client and is precisely why desks keep a
-- paper list beside the screen.
--
-- THE EXCEPTION TO "DERIVE IT" (operator R-7), and deliberately so. A-021's
-- list is derived and stays derived: nothing stores "needs a call". But "we
-- tried and she did not pick up" is derivable from nothing at all — no status
-- moves, no message is sent, the appointment is byte-for-byte identical
-- afterwards. There is no fact to read it back out of.
CREATE TYPE "CallAttemptOutcome" AS ENUM ('no_answer', 'left_message');

CREATE TABLE "CallDownAttempt" (
  "id"            TEXT NOT NULL,
  "businessId"    TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  -- The appointment's startDay AT THE MOMENT of the call. CHAR(10), never
  -- `date` — a Postgres date crossing into a JS Date is the silent day-west
  -- shift the rental build paid for, and this column is compared against
  -- `Appointment.startDay`, which is CHAR(10) for the same reason.
  --
  -- It is also what makes "cleared when the appointment confirms or the day
  -- rolls" require no clearing code: a confirmed appointment is not on the
  -- list at all, and a reschedule to another day (D-6 keeps the same row)
  -- stops matching, so a stale "no answer" cannot resurface against a booking
  -- made a fortnight later.
  "forDay"        CHAR(10) NOT NULL,
  "outcome"       "CallAttemptOutcome" NOT NULL,
  -- D-9. At 4pm the question is who rang her, and "the front desk" is four
  -- people.
  "triedByActor"  "Actor" NOT NULL,
  "actorRef"      TEXT,
  "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CallDownAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CallDownAttempt"
  ADD CONSTRAINT "CallDownAttempt_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CallDownAttempt"
  ADD CONSTRAINT "CallDownAttempt_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ONE ROW PER APPOINTMENT PER DAY. A second call re-stamps it rather than
-- appending — the useful fact is the most recent attempt, and the history of
-- them is what the appointment event log is for. It is also what makes two
-- people at the desk pressing the same button in the same second an upsert
-- rather than a row that reads "tried, tried".
CREATE UNIQUE INDEX "CallDownAttempt_appointmentId_forDay_key"
  ON "CallDownAttempt"("appointmentId", "forDay");

CREATE INDEX "CallDownAttempt_businessId_forDay_idx"
  ON "CallDownAttempt"("businessId", "forDay");
