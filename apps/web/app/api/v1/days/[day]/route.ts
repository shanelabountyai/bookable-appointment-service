/** W-004 — `GET /api/v1/days/{day}` (API PRD §7). Handler: `lib/api/appointments.ts`. */
import { api } from '@/lib/api/http';
import { getDay } from '@/lib/api/appointments';

export const dynamic = 'force-dynamic';

export function GET(request: Request, context: { params: Promise<{ day: string }> }) {
  return api({ scope: 'read' }, getDay, request, context);
}
