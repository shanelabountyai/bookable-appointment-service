-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "conflictAckAt" TIMESTAMPTZ(3),
ADD COLUMN     "conflictAckReason" TEXT,
ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "NotificationOutbox" ADD COLUMN     "appointmentId" TEXT;

-- CreateIndex
CREATE INDEX "NotificationOutbox_appointmentId_idx" ON "NotificationOutbox"("appointmentId");

-- AddForeignKey
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN SECTION. Prisma cannot express constraint deferrability.
--
-- Source: docs/reviews/05-operator-review-milestone-1.md, R-2.
-- ═══════════════════════════════════════════════════════════════════════════

-- MAKE THE NO-OVERLAP CONSTRAINT DEFERRABLE.
--
-- The problem it fixes is an ordinary front-desk move, not an edge case:
-- "put Mrs. Hall at 2 and move Jenny to 3" — a swap. There is NO order of
-- single-row UPDATEs that avoids a transient overlap, so the transaction dies
-- with 23P01, which the write path reports to staff as "that slot is taken"
-- while they are trying to MOVE it. Same shape for any non-uniform column push
-- (A-018) or bulk reassignment (A-019).
--
-- INITIALLY IMMEDIATE is the important half: ordinary single-row bookings are
-- still checked at statement end exactly as before, so the eight race
-- interleavings in A-009 are unaffected and no booking path gets slower or
-- laxer. Only a transaction that explicitly opts in with
--   SET CONSTRAINTS appointment_no_overlap DEFERRED;
-- has its check moved to COMMIT — which is precisely where a multi-row
-- rearrangement needs it.
--
-- Verified against PG17 before writing this: with the constraint merely
-- DEFERRABLE the swap still fails; inside SET CONSTRAINTS ... DEFERRED it
-- succeeds and both rows land correctly.
--
-- Deferrability cannot be altered in place — `ALTER TABLE ... ALTER CONSTRAINT`
-- is foreign-key only (verified: "constraint ... is not a foreign key
-- constraint"), so the constraint is dropped and re-added. The predicate and
-- range are byte-identical to the original; only DEFERRABLE is added.
ALTER TABLE "Appointment" DROP CONSTRAINT "appointment_no_overlap";

ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist (
    "providerId" WITH =,
    tstzrange("blockedStart", "blockedEnd", '[)') WITH &&
  )
  WHERE (status NOT IN ('cancelled', 'cancelled_late'))
  DEFERRABLE INITIALLY IMMEDIATE;
