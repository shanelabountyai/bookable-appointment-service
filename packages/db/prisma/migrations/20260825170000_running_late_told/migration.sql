-- A-059 — "I've already rung her."
--
-- Setting a running-late delta (A-018) tells nobody. The grid goes amber, the
-- engine stops selling the next forty minutes, and every client still on her
-- way arrives at the time printed on her confirmation. So the desk rings them
-- — and kept the list of who it had got to on a Post-it, which is the shadow
-- calendar A-018 exists to end, reappearing one layer down.
--
-- WHAT THIS IS NOT: a message. Nothing is sent by writing one of these rows.
-- It records a HUMAN phone call, which is why it is not a NotificationOutbox
-- row — those render through `deliveryWord()` and would read "queued", telling
-- the second person at the desk that the system has it in hand when a person
-- does.
CREATE TABLE "RunningLateTold" (
  "id"               TEXT NOT NULL,
  "businessId"       TEXT NOT NULL,
  "runningLateId"    TEXT NOT NULL,
  "appointmentId"    TEXT NOT NULL,
  -- The delta at the moment somebody rang. Without it the tick outlives what
  -- it claims: she was told "about twenty", Dana is now fifty behind, and the
  -- screen still says she has been told.
  "minutesToldAbout" INTEGER NOT NULL,
  "toldByActor"      "Actor" NOT NULL,
  "actorRef"         TEXT,
  "createdAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RunningLateTold_pkey" PRIMARY KEY ("id")
);

-- ON DELETE CASCADE IS THE FEATURE, not an ownership detail. "Cleared when the
-- delta clears" is this line: `clearRunningLate` deletes the ProviderRunningLate
-- row and the ticks go with it, so there is no cleanup job to forget to run and
-- no second write path that could leave yesterday's calls sitting under
-- tomorrow's claim.
ALTER TABLE "RunningLateTold"
  ADD CONSTRAINT "RunningLateTold_runningLateId_fkey"
  FOREIGN KEY ("runningLateId") REFERENCES "ProviderRunningLate"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RunningLateTold"
  ADD CONSTRAINT "RunningLateTold_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RunningLateTold"
  ADD CONSTRAINT "RunningLateTold_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- One tick per client per delta. This is what makes two people at the desk
-- ticking the same row in the same second an upsert rather than two rows and a
-- list that reads "told, told".
CREATE UNIQUE INDEX "RunningLateTold_runningLateId_appointmentId_key"
  ON "RunningLateTold"("runningLateId", "appointmentId");

CREATE INDEX "RunningLateTold_businessId_appointmentId_idx"
  ON "RunningLateTold"("businessId", "appointmentId");
