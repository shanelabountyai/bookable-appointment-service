/** W-012 — `GET /api/v1/openapi.json` (API PRD §6.9). Public: the contract is not a secret; the data is. */
import { openApiDocument } from '@/lib/api/openapi';

export const dynamic = 'force-static';

export function GET() {
  return Response.json(openApiDocument());
}
