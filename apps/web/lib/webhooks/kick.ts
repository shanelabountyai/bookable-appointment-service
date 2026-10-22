/**
 * W-009 — the INLINE webhook carrier (API PRD §8 "Dispatch" 1, W-D20).
 *
 * `after()` runs the callback once the response has been sent — after the
 * write it follows has committed — and on Vercel it is backed by
 * `waitUntil`, so this needs no `@vercel/functions` dependency. It sweeps
 * every business (there is one) rather than threading a business id through
 * every caller; a sweep with nothing due is two indexed queries.
 *
 * Called from: the API's write adapter, the MCP route, `readDesk` on a
 * server-action request (every desk mutation passes through it), the manage
 * link's gate on a server action (the client's own cancel/confirm/move) and
 * the public booking's confirm (W-D23). Best-effort by design — a failure is
 * logged and the daily sweep delivers it later.
 */
import 'server-only';
import { after } from 'next/server';

export function kickWebhooks(): void {
  after(async () => {
    try {
      const [{ prisma }, { sweepWebhooks }] = await Promise.all([import('@bookable/db'), import('../api/webhooks')]);
      const r = await sweepWebhooks({ prisma, now: () => new Date() }, { maxSends: 10 });
      if (r.queued + r.succeeded + r.failed + r.dead > 0) console.info('[webhooks] inline sweep', JSON.stringify(r));
    } catch (error) {
      console.error('[webhooks] inline sweep failed; the hourly sweep will retry', error);
    }
  });
}
