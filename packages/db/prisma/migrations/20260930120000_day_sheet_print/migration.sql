-- A-150 (C9, D-73) — WHEN THE PAPER WAS MADE.
--
-- One row per press of the day sheet's Print button, so the screen can say
-- "3 changed since print". providerId NULL is the whole salon's sheet.

-- CreateTable
CREATE TABLE "DaySheetPrint" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "day" CHAR(10) NOT NULL,
    "providerId" TEXT,
    "actor" "Actor" NOT NULL,
    "actorRef" TEXT,
    "printedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DaySheetPrint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DaySheetPrint_businessId_day_printedAt_idx" ON "DaySheetPrint"("businessId", "day", "printedAt");

-- AddForeignKey
ALTER TABLE "DaySheetPrint" ADD CONSTRAINT "DaySheetPrint_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DaySheetPrint" ADD CONSTRAINT "DaySheetPrint_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

