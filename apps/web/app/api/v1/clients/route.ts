/** W-005 — `GET /api/v1/clients?q=` (API PRD §7). W-006 adds `POST`. Handler: `lib/api/clients.ts`. */
import { api } from '@/lib/api/http';
import { searchClientsHandler } from '@/lib/api/clients';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return api({ scope: 'read' }, searchClientsHandler, request, undefined);
}

