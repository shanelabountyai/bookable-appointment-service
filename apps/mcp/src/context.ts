/**
 * Who is calling, and what world they may see (PRD §5).
 *
 * Built ONCE per connection from the credential and threaded into every tool.
 * No tool ever takes a `businessId` argument: the business comes from here,
 * never from the model. `timezone` rides along because every wall-time the
 * model sends is resolved in the BUSINESS's zone, not the server's.
 */
import type { PrismaClient } from '@bookable/db';
import { findStaffById, type StaffRole } from '@bookable/db/auth';
import type { ZoneId } from '@bookable/core/time';

export interface CallerContext {
  businessId: string;
  staffUserId: string;
  /** What the event log calls this person (A-037). */
  staffName: string;
  role: StaffRole;
  timezone: ZoneId;
  /** Null until M-002/M-003 give calls a token to be rate-limited by. */
  tokenId: string | null;
}

/**
 * M-001 ONLY. Resolves a context from a bare `StaffUser` id so the server can
 * be run end-to-end before tokens exist. M-003 replaces this with token
 * resolution and deletes it — a staff id is not a credential.
 */
export async function contextForStaffId(prisma: PrismaClient, staffUserId: string): Promise<CallerContext | null> {
  const staff = await findStaffById(prisma, staffUserId);
  if (!staff) return null;
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  return {
    businessId: staff.businessId,
    staffUserId: staff.id,
    staffName: staff.name,
    role: staff.role,
    timezone: business.timezone as ZoneId,
    tokenId: null,
  };
}
