-- A-048 — the outbox, made ready for a real driver.
--
-- Three ceilings, one migration. All three are invisible while the wired
-- adapter is a console log, and all three become "a client texted twice, and a
-- log that cannot say which driver handled what" on the first day Twilio is
-- real. Doing this AFTER the adapter means debugging double-sends against a
-- live SMS bill.

-- 1. The claim's fifth state. Adding an enum value is transaction-safe on
--    PG 12+ so long as the value is not USED in the same transaction, which
--    is why nothing below writes it.
ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'sending';

-- 2. Provenance. `deliveredBy` answers "was this row really sent?" per ROW
--    rather than per BUILD; `externalId` is the value dispatch.ts already
--    received from the adapter and discarded for want of a column.
ALTER TABLE "NotificationOutbox"
  ADD COLUMN "deliveredBy" TEXT,
  ADD COLUMN "externalId"  TEXT;

-- 3. The claim reads the whole queue by age, across businesses — a dispatcher
--    is not per-tenant, so the existing ("businessId", status) index cannot
--    serve it.
CREATE INDEX "NotificationOutbox_status_createdAt_idx"
  ON "NotificationOutbox" ("status", "createdAt");
