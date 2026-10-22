/** W-005 — `GET /api/v1/waitlist` (API PRD §7). `POST` (W-007) requires `write` and an `Idempotency-Key`. Handler: `lib/api/clients.ts`. */
import { api } from '@/lib/api/http';
import { postWaitlist } from '@/lib/api/moves';
import { getWaitlist } from '@/lib/api/clients';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return api({ scope: 'read' }, getWaitlist, request, undefined);
}

const post = postWaitlist();

export function POST(request: Request) {
  return api({ scope: 'write' }, post, request, undefined);
}
