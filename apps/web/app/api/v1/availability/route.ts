/** W-003 — `GET /api/v1/availability` (API PRD §7). Handler: `lib/api/catalog.ts`. */
import { api } from '@/lib/api/http';
import { getAvailability } from '@/lib/api/catalog';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return api({ scope: 'read' }, getAvailability, request, undefined);
}
