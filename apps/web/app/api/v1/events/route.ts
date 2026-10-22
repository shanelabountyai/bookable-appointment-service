/** W-008 — `GET /api/v1/events?since=<seq>`, the catch-up door (API PRD §7, §8). Handler: `lib/api/events.ts`. */
import { api } from '@/lib/api/http';
import { listEvents } from '@/lib/api/events';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return api({ scope: 'read' }, listEvents, request, undefined);
}
