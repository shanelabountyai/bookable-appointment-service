/** W-005 — `GET /api/v1/clients/{id}` (API PRD §7). Handler: `lib/api/clients.ts`. */
import { api } from '@/lib/api/http';
import { getClient } from '@/lib/api/clients';

export const dynamic = 'force-dynamic';

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api({ scope: 'read' }, getClient, request, context);
}
