/**
 * M-014 — Bookable's MCP server over Streamable HTTP, at /api/mcp.
 *
 * Authentication is the MCP bearer token (issued on /staff/people), checked in
 * `handleMcpRequest`; the demo password gate exempts this path for that reason.
 * Stateless: every request is its own server, which is what a serverless
 * function can promise.
 *
 *   claude mcp add --transport http bookable https://<host>/api/mcp \
 *     --header "Authorization: Bearer bk_mcp_…"
 */
import { prisma } from '@bookable/db';
import { handleMcpRequest } from '@bookable/mcp';
import { kickWebhooks } from '@/lib/webhooks/kick';

export const dynamic = 'force-dynamic';

const handle = (request: Request) => handleMcpRequest(request, { prisma, now: () => new Date() });

export function POST(request: Request) {
  // W-009: an assistant's commit goes out inline, after the response.
  kickWebhooks();
  return handle(request);
}
export const GET = handle;
export const DELETE = handle;
