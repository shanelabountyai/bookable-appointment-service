/**
 * A-013 — the gate every token-reachable surface goes through.
 *
 * TOKEN-02 requires the route to be rate-limited BECAUSE IT RETURNS PII. That
 * makes the limiter part of the gate rather than a decoration on one page: the
 * page and the cancel action both come through here, so a limit that the page
 * enforces cannot be walked around by posting the action directly.
 *
 * ONE OUTCOME FOR EVERY FAILURE. Unknown token, revoked token, expired token
 * and wrong-appointment token all produce the same `'no-link'` — TOKEN-02's
 * "clear, non-enumerating message". Telling a caller which of their guesses
 * was a real-but-expired link is exactly the oracle a random 256-bit token
 * exists to deny them.
 */
import { headers } from 'next/headers';
import { prisma } from '@bookable/db';
import { type ManageGrant, verifyManageToken } from '@bookable/db/appointments';
import { consumeRateLimit } from '@bookable/db/rate-limit';

/**
 * Generous by human standards, useless by scraping ones: a customer opening
 * the link, reading it, cancelling and reloading spends four. It is a ceiling
 * on bulk retrieval, not a usability tax — and the honest limit for a page
 * with no login is one that a real customer can never hit.
 */
const LIMIT = 30;
const WINDOW_MS = 5 * 60 * 1000;

export type GateResult =
  | { ok: true; grant: ManageGrant }
  | { ok: false; reason: 'no-link' | 'too-many' };

export async function openManageLink(token: string, now: Date): Promise<GateResult> {
  const allowed = await consumeRateLimit(prisma, {
    key: `manage:${await callerKey()}`,
    limit: LIMIT,
    windowMs: WINDOW_MS,
    now,
  });
  // Counted BEFORE the token is looked up, so a guessing loop pays for its
  // guesses whether or not any of them land.
  if (!allowed) return { ok: false, reason: 'too-many' };

  const grant = await verifyManageToken(prisma, token, now);
  return grant ? { ok: true, grant } : { ok: false, reason: 'no-link' };
}

/**
 * Who is asking, for limiting purposes.
 *
 * ponytail: the first hop of `x-forwarded-for`, with everyone unidentifiable
 * sharing one bucket. The known ceiling is that behind a proxy which does not
 * set the header — or in front of one large NAT — the whole world is one
 * caller and the limit is collective. Vercel (the deploy target) always sets
 * it, so the ceiling bites in local dev, where it is harmless. Upgrade path if
 * this ever runs behind something else: read the platform's own trusted
 * client-IP header instead, in this one function.
 */
async function callerKey(): Promise<string> {
  const forwarded = (await headers()).get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}
