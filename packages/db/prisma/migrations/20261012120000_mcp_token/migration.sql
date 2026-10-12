-- M-002 (MCP PRD §5): a bearer credential for ONE named staff member, used by
-- an AI client acting for them. Stored hashed, shown once, revocable.
CREATE TABLE "McpToken" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "McpToken"("tokenHash");
CREATE INDEX "McpToken_businessId_idx" ON "McpToken"("businessId");
CREATE INDEX "McpToken_staffUserId_idx" ON "McpToken"("staffUserId");

ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict: staff are deactivated, never deleted. A token outliving its person is a loud failure, not a silent clean-up.
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
