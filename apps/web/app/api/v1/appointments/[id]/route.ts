/** W-004 — `GET /api/v1/appointments/{id}` (API PRD §7). Handler: `lib/api/appointments.ts`. */
import { api } from '@/lib/api/http';
import { getAppointment } from '@/lib/api/appointments';

export const dynamic = 'force-dynamic';

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api({ scope: 'read' }, getAppointment, request, context);
}
