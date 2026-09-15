-- A-119 / D-56 — A WAITLIST ENTRY IS A VISIT, NOT A SERVICE.
--
-- `serviceId` (one, with an FK) becomes ordered `serviceIds` (many, no FK),
-- so a client waiting for cut + colour is matched against the footprint of
-- the appointment she actually wants (D-23: the first line's bufferBefore,
-- the sum of the durations, the last line's bufferAfter) rather than against
-- whichever service happened to be first.
--
-- NO BACKFILL GUESS. Every existing row becomes a one-element list holding
-- exactly the service it already named — which is the same entry it was, and
-- matches exactly as it did before for a client who only ever wanted one
-- thing. Rows are copied BEFORE the old column is dropped, in one
-- transaction, so a half-applied migration cannot leave an entry with no
-- services at all (an entry the matcher would silently never offer).
--
-- The FK to Service goes with the column. `providerIds` on this same table
-- has been an un-FK'd array since A-023 for the same reason: nothing in this
-- app deletes a service, and an array cannot carry a reference anyway.

ALTER TABLE "WaitlistEntry" ADD COLUMN "serviceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "WaitlistEntry" SET "serviceIds" = ARRAY["serviceId"];

-- The default existed only to add a NOT NULL column to populated rows; an
-- entry with no services is not a thing this application can mean, and
-- leaving the default would let one be written silently.
ALTER TABLE "WaitlistEntry" ALTER COLUMN "serviceIds" DROP DEFAULT;

ALTER TABLE "WaitlistEntry" DROP CONSTRAINT "WaitlistEntry_serviceId_fkey";
ALTER TABLE "WaitlistEntry" DROP COLUMN "serviceId";
