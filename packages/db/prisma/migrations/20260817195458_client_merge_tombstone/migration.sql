-- A-015 / operator R-10. The merge TOMBSTONE.
--
-- A losing client record is never deleted. It keeps its phone number and
-- points at the survivor, so the old number still finds the person — the
-- moment the front desk needs it most is six weeks after the merge, when she
-- rings from it. Deletion is impossible anyway: AppointmentEvent is
-- append-only and its foreign keys are Restrict.
--
-- A CHECK forbidding self-reference is deliberately absent: it would be a
-- second mechanism disagreeing with the application's own refusal, and a row
-- pointing at itself is a resolution cycle rather than a data-shape error.
-- See the guard in mergeClients, which refuses it with a sentence.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "mergedAt" TIMESTAMPTZ(3),
ADD COLUMN     "mergedIntoClientId" TEXT;

-- CreateIndex
CREATE INDEX "Client_mergedIntoClientId_idx" ON "Client"("mergedIntoClientId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_mergedIntoClientId_fkey" FOREIGN KEY ("mergedIntoClientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
