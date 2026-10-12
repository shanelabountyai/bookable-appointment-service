-- M-009 (MCP PRD OQ-M1, §8).
-- 1. How an actor reached the system, on every event. Backfilled from `actor`
--    so history reads honestly: a customer_token row came through the manage
--    link, a system row from a job, and everything else was the desk — there
--    was no other way in before this migration.
CREATE TYPE "EventChannel" AS ENUM ('desk', 'manage_link', 'mcp', 'system');
ALTER TABLE "AppointmentEvent" ADD COLUMN "channel" "EventChannel" NOT NULL DEFAULT 'desk';
UPDATE "AppointmentEvent" SET "channel" = 'manage_link' WHERE "actor" = 'customer_token';
UPDATE "AppointmentEvent" SET "channel" = 'system' WHERE "actor" = 'system';

-- 2. Preview-then-commit proposals. Single-use by `usedAt`; the claim is one UPDATE.
CREATE TABLE "McpProposal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "argsHash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "outcome" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "McpProposal_businessId_createdAt_idx" ON "McpProposal"("businessId", "createdAt");
CREATE INDEX "McpProposal_staffUserId_idx" ON "McpProposal"("staffUserId");

ALTER TABLE "McpProposal" ADD CONSTRAINT "McpProposal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpProposal" ADD CONSTRAINT "McpProposal_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
