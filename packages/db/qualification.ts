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

export interface QualifiedProvider {
  id: string;
  displayName: string;
  /** SVC-02 breaks "any provider" ties on this, so it travels with the row —
   *  a caller that had to fetch it separately would be one refactor away from
   *  a non-deterministic assignment. */
  displayOrder: number;
}

/**
 * EVERY active provider who can do the whole visit, in the one order every
 * staff surface uses (`displayOrder`, then name).
 *
 * A-056 extracted this from `walkInOptions`, which had counted the links
 * inline. Two copies of "qualified for all of it" is the fork
 * `qualifiedForVisit` above exists to prevent, and A-056's "anyone" search is
 * the second caller that would have made it a fork.
 */
export async function providersForVisit(
  db: Db,
  args: { businessId: string; serviceIds: readonly string[] },
): Promise<QualifiedProvider[]> {
  const needed = new Set(args.serviceIds);
  if (needed.size === 0) return [];

  const links = await db.serviceProvider.findMany({
    where: { businessId: args.businessId, serviceId: { in: [...needed] }, provider: { active: true } },
    select: { providerId: true, provider: { select: { displayName: true, displayOrder: true } } },
  });

  // ALL of it, not some of it (VISIT-01): half a cut-and-colour with the wrong
  // stylist is not a partial success.
  const counts = new Map<string, number>();
  for (const link of links) counts.set(link.providerId, (counts.get(link.providerId) ?? 0) + 1);

  return [...new Map(links.map((link) => [link.providerId, link])).values()]
    .filter((link) => counts.get(link.providerId) === needed.size)
    .map((link) => ({
      id: link.providerId,
      displayName: link.provider.displayName,
      displayOrder: link.provider.displayOrder,
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder || a.displayName.localeCompare(b.displayName));
}
