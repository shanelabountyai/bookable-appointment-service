-- A-073 — THE MARK OUTGROWS ITS NAME.
--
-- A-072 shipped `FreedSlotOffer`: "who have we already rung about this freed
-- slot?" A-073 needs the identical mechanism for a different errand — "who
-- have we already rung about not having been in since April?" — and the
-- backlog row says to REUSE it rather than invent a third shape beside
-- `CallDownAttempt` and this one.
--
-- Reusing it under the old name would have meant writing rows into a table
-- called `FreedSlotOffer` with `freedKey = 'lapsed'`, which is a pun rather
-- than a model. So the second caller renames it to what it always was: a
-- record that somebody at this desk rang this client about SOMETHING, and what
-- she said. Nothing else changes — same columns, same unique key, same
-- cascades, same four outcomes.
--
-- A rename rather than a new table, because the data is the same data: the
-- offers A-072 recorded this morning are call marks, and dropping them to
-- start again would lose the only record of a round of phone calls.

ALTER TABLE "FreedSlotOffer" RENAME TO "ClientCallMark";

-- `freedKey` → `subject`: WHAT was rung about. `freed:<A-067 row key>` for an
-- offer of a freed slot, `lapsed` for the client who has stopped coming. The
-- unique key below is what makes one client one row per subject, so a second
-- call re-stamps rather than appending.
ALTER TABLE "ClientCallMark" RENAME COLUMN "freedKey" TO "subject";
ALTER TABLE "ClientCallMark" RENAME COLUMN "offeredByActor" TO "calledByActor";

ALTER TYPE "FreedOfferOutcome" RENAME TO "CallMarkOutcome";

ALTER INDEX "FreedSlotOffer_pkey" RENAME TO "ClientCallMark_pkey";
ALTER INDEX "FreedSlotOffer_freedKey_clientId_key" RENAME TO "ClientCallMark_subject_clientId_key";
ALTER INDEX "FreedSlotOffer_businessId_freedKey_idx" RENAME TO "ClientCallMark_businessId_subject_idx";

ALTER TABLE "ClientCallMark" RENAME CONSTRAINT "FreedSlotOffer_businessId_fkey" TO "ClientCallMark_businessId_fkey";
ALTER TABLE "ClientCallMark" RENAME CONSTRAINT "FreedSlotOffer_appointmentId_fkey" TO "ClientCallMark_appointmentId_fkey";
ALTER TABLE "ClientCallMark" RENAME CONSTRAINT "FreedSlotOffer_clientId_fkey" TO "ClientCallMark_clientId_fkey";

-- The rows A-072 wrote get the new subject prefix, so one column has one
-- grammar rather than two eras of it.
UPDATE "ClientCallMark" SET "subject" = 'freed:' || "subject" WHERE "subject" NOT LIKE 'freed:%' AND "subject" <> 'lapsed';
