-- A-132 / D-63(1) — WHEN THE DESK MADE THE CLAIM.
--
-- The running-late cascade starts at the chair's checkout once the chair is
-- empty, but only for a checkout at or after the claim: "Dana is 40 behind",
-- said with nobody in the chair, must still land whole on the next client.
-- `updatedAt` cannot answer that, because a push (D-43) rewrites the row and a
-- push is not a new claim about the chair.
--
-- Backfilled from `updatedAt`: the best record of the last claim there is, and
-- a row only lives for its own day.

ALTER TABLE "ProviderRunningLate" ADD COLUMN "claimedAt" TIMESTAMPTZ(3);
UPDATE "ProviderRunningLate" SET "claimedAt" = "updatedAt";
ALTER TABLE "ProviderRunningLate" ALTER COLUMN "claimedAt" SET NOT NULL;
