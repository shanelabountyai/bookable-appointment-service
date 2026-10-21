/** W-005 — `GET /api/v1/waitlist` (API PRD §7). W-007 adds `POST`. Handler: `lib/api/clients.ts`. */
import { api } from '@/lib/api/http';
import { getWaitlist } from '@/lib/api/clients';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return api({ scope: 'read' }, getWaitlist, request, undefined);
}

