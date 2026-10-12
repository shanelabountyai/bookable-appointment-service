/**
 * Streamable HTTP (M-014) — the same server, reached over HTTP with a bearer
 * token: `Authorization: Bearer bk_mcp_…`, the token an owner issued on
 * /staff/people. Transport-agnostic by construction: this file resolves the
 * credential and hands a per-request server to the SDK's web-standard
 * transport; the tool layer does not know it is on HTTP.
 *
 * STATELESS on purpose. A Vercel function has no memory between requests, so
 * each request gets its own server + transport and no session id. The cost is
 * one token lookup per request — which the per-call refresh (M-003) was doing
 * anyway. JSON responses rather than SSE, because every tool here answers in
 * one message and a plain response is what a serverless route does best.
 *
 * `handleMcpRequest` takes a web-standard Request and returns a Response, so
 * the Next route is three lines and the test needs no server process.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { type CallerContext, contextForToken } from './context';
import { createBookableServer } from './server';
import type { ToolDeps } from './tools/define';

const BEARER = /^Bearer\s+(\S+)$/i;

export function bearerToken(request: Request): string | null {
  const m = BEARER.exec(request.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
}

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: 'UNAUTHORIZED', message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      // RFC 6750: tell the client which scheme we wanted. No realm secrets in it.
      'WWW-Authenticate': 'Bearer realm="bookable-mcp"',
      'Cache-Control': 'no-store',
    },
  });
}

export async function handleMcpRequest(
  request: Request,
  deps: ToolDeps,
  resolve: (token: string, now: Date) => Promise<CallerContext | null> = (token, now) => contextForToken(deps.prisma, token, now),
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return unauthorized('Send the MCP token as "Authorization: Bearer <token>". An owner issues one on /staff/people.');
  const initial = await resolve(token, deps.now());
  if (!initial) return unauthorized('This token does not work — revoked, or its person is off the roster. Ask an owner for a new one.');

  const server = createBookableServer({ initial, refresh: (now) => resolve(token, now) }, deps);
  // No `sessionIdGenerator` → stateless (the SDK's own switch for it).
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Stateless: nothing to keep once the response is built.
    void server.close();
  }
}
