-- W-001 (API PRD §5): a bearer credential for an INTEGRATION, not a person.
-- Stored hashed, shown once, revocable, scoped.

-- An integration's writes record `channel = api` (W-D1). Adding an enum value
-- is safe inside a migration transaction on PG 12+ as long as nothing in the
-- same transaction USES it, and nothing here does.
ALTER TYPE "EventChannel" ADD VALUE 'api';

CREATE TYPE "ApiScope" AS ENUM ('read', 'write', 'prices', 'contacts');

CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" "ApiScope"[],
    "issuedById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_businessId_idx" ON "ApiKey"("businessId");

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict: staff are deactivated, never deleted (StaffUser's own comment).
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
