-- W-010 (API PRD §8 "Signature"): secret rotation. The previous secret keeps
-- signing for 24 h after a rotation, so every delivery in that window carries
-- two v1= values and a receiver holding either secret verifies.

-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN     "previousSecret" TEXT,
ADD COLUMN     "previousSecretExpiresAt" TIMESTAMPTZ(3);

