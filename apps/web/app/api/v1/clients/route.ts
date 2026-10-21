/** W-005 — `GET /api/v1/clients?q=` (API PRD §7). `POST` (W-006) requires `write` and an `Idempotency-Key`. Handler: `lib/api/clients.ts`. */
import { api } from '@/lib/api/http';
import { postClient } from '@/lib/api/writes';
import { searchClientsHandler } from '@/lib/api/clients';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return api({ scope: 'read' }, searchClientsHandler, request, undefined);
}

const post = postClient();

export function POST(request: Request) {
  return api({ scope: 'write' }, post, request, undefined);
}
