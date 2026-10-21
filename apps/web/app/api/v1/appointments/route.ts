/** W-004 — `GET /api/v1/appointments` (API PRD §7). `POST` (W-006) requires `write` and an `Idempotency-Key`. Handler: `lib/api/appointments.ts`. */
import { api } from '@/lib/api/http';
import { postAppointment } from '@/lib/api/writes';
import { listAppointments } from '@/lib/api/appointments';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return api({ scope: 'read' }, listAppointments, request, undefined);
}

const post = postAppointment();

export function POST(request: Request) {
  return api({ scope: 'write' }, post, request, undefined);
}
