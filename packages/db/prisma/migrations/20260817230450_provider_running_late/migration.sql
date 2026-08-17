-- A-018 / D-22. The running-late delta.
--
-- A stored per-provider-per-day value, NOT a rewrite of `startAt`: rewriting
-- would change the time on the confirmation the client is already holding.
-- The unique index is what makes "set it" an upsert and "clear it" a delete —
-- absent means on time, which is the state that needs no explanation.

-- CreateTable
CREATE TABLE "ProviderRunningLate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "day" CHAR(10) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "setByActor" "Actor" NOT NULL,
    "actorRef" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProviderRunningLate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderRunningLate_businessId_day_idx" ON "ProviderRunningLate"("businessId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRunningLate_providerId_day_key" ON "ProviderRunningLate"("providerId", "day");

-- AddForeignKey
ALTER TABLE "ProviderRunningLate" ADD CONSTRAINT "ProviderRunningLate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRunningLate" ADD CONSTRAINT "ProviderRunningLate_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
