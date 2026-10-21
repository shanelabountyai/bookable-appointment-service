/** W-004 — `GET /api/v1/appointments` (API PRD §7). W-006 adds `POST`. Handler: `lib/api/appointments.ts`. */
import { api } from '@/lib/api/http';
import { listAppointments } from '@/lib/api/appointments';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return api({ scope: 'read' }, listAppointments, request, undefined);
}

