/**
 * Who is calling, and what world they may see (PRD §5).
 *
 * Resolved from the bearer token ON EVERY CALL, not once per connection: a
 * Claude Desktop session stays connected for hours, and "deactivation revokes
 * on the next call" is only true if the next call looks again. The cost is
 * one indexed lookup, which also keeps `lastUsedAt` honest.
 *
 * No tool ever takes a `businessId` argument: the business comes from here,
 * never from the model. `timezone` rides along because every wall-time the
 * model sends is resolved in the BUSINESS's zone, not the server's.
 */
import type { PrismaClient } from '@bookable/db';
import { resolveMcpToken } from '@bookable/db/mcp';
import type { StaffRole } from '@bookable/db/auth';
import type { ZoneId } from '@bookable/core/time';

export interface CallerContext {
  businessId: string;
  staffUserId: string;
  /** What the event log calls this person (A-037). */
  staffName: string;
  role: StaffRole;
  timezone: ZoneId;
  /** Rate-limit bucket and audit reference. */
  tokenId: string;
}

/** Null for an unknown, revoked, or deactivated-person token. */
export async function contextForToken(prisma: PrismaClient, token: string, now: Date): Promise<CallerContext | null> {
  const grant = await resolveMcpToken(prisma, token, now);
  if (!grant) return null;
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: grant.businessId },
    select: { timezone: true },
  });
  return {
    businessId: grant.businessId,
    staffUserId: grant.staffUserId,
    staffName: grant.staffName,
    role: grant.role,
    timezone: business.timezone as ZoneId,
    tokenId: grant.tokenId,
  };
}
