/** W-003 — `GET /api/v1/providers` (API PRD §7). Handler: `lib/api/catalog.ts`. */
import { api } from '@/lib/api/http';
import { getProviders } from '@/lib/api/catalog';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return api({ scope: 'read' }, getProviders, request, undefined);
}
