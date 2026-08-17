-- A-013. The rate-limit counter behind the manage-link route (TOKEN-02).
--
-- Deliberately NOT a §8 entity: no `businessId` (the key is a client IP, which
-- belongs to no tenant), no cuid id (the key IS the identity, so an upsert is
-- one statement with no read first), and no foreign keys.

-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key")
);
