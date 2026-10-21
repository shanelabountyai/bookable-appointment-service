/**
 * W-001 — who is calling /api/v1 (API PRD §5).
 *
 * `Authorization: Bearer bk_api_…` → an unrevoked `ApiKey` → its business and
 * scopes, resolved on EVERY request (a revocation is honoured on the next
 * call, not the next deploy). No endpoint takes a `businessId`: it comes from
 * here and nowhere else. The business's IANA zone rides along because every
 * wall time an integration sends is read in the SALON's zone, never the
 * server's (D-3).
 *
 * Lives in `apps/web/lib/api` (W-D10), imports only workspace packages — no
 * `@/` paths — so the unit suite can run it without Next.
 */
import type { ZoneId } from '@bookable/core/time';
import type { PrismaClient } from '@bookable/db';
import { type ApiGrant, resolveApiKey } from '@bookable/db/api';

export interface ApiCaller extends ApiGrant {
  timezone: ZoneId;
}

const BEARER = /^Bearer\s+(\S+)$/i;

export function bearerOf(request: Request): string | null {
  const m = BEARER.exec(request.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
}

/** Null for a missing, malformed, unknown or revoked key — one answer for all four (§6: `UNAUTHENTICATED`). */
export async function resolveCaller(prisma: PrismaClient, request: Request, now: Date): Promise<ApiCaller | null> {
  const key = bearerOf(request);
  if (!key) return null;
  const grant = await resolveApiKey(prisma, key, now);
  if (!grant) return null;
  const business = await prisma.business.findUniqueOrThrow({ where: { id: grant.businessId }, select: { timezone: true } });
  return { ...grant, timezone: business.timezone as ZoneId };
}
