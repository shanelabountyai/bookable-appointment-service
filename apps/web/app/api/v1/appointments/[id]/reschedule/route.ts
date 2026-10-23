/** W-007 — `POST /api/v1/appointments/{id}/reschedule` (API PRD §7): `write` scope, `Idempotency-Key` required. Handler: `lib/api/moves.ts`. */
import { api } from '@/lib/api/http';
import { postReschedule } from '@/lib/api/moves';

export const dynamic = 'force-dynamic';

const post = postReschedule();

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api({ scope: 'write' }, post, request, context);
}
