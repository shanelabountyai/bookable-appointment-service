/**
 * "Can she do this whole visit?" — SVC-02, asked by everything that moves an
 * appointment onto a different provider.
 *
 * A leaf module on purpose: A-019's bulk reassign and A-038's cross-provider
 * reschedule both need it, they live in different folders, and the rule is one
 * sentence that must not fork. "Where qualified" is the operative half of the
 * bulk action's NAME — a second copy that drifted would silently put a client
 * with a stylist who cannot do her colour.
 */
import type { Prisma, PrismaClient } from './generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * True only when the provider is linked to EVERY distinct service in the
 * visit. A multi-service visit (VISIT-01) is all-or-nothing: half a cut-and-
 * colour with the wrong stylist is not a partial success.
 */
export async function qualifiedForVisit(
  db: Db,
  args: { providerId: string; serviceIds: readonly string[] },
): Promise<boolean> {
  const needed = new Set(args.serviceIds);
  if (needed.size === 0) return true;

  const linked = await db.serviceProvider.count({
    where: { providerId: args.providerId, serviceId: { in: [...needed] } },
  });
  return linked >= needed.size;
}
