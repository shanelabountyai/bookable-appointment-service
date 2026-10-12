/**
 * Builds the MCP server for ONE credential. Transport-agnostic: stdio.ts and
 * the later HTTP route (M-014) both call this and attach their own transport.
 *
 * Role scoping happens twice, on purpose:
 *  - at registration, from the context the token resolved to when the
 *    connection opened — a tool whose `roles` excludes the caller is never
 *    registered, so it is absent from `tools/list` rather than refused (PRD
 *    §5: a model calls anything it can see);
 *  - on every call, from a FRESH resolution — a token revoked, or a person
 *    deactivated or demoted since the listing, is refused on this call, not
 *    at the next reconnect.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CallerContext } from './context';
import { FORBIDDEN, UNAUTHORIZED } from './errors';
import type { ToolDeps } from './tools/define';
import { TOOLS } from './tools';

export const SERVER_INFO = { name: 'bookable', version: '0.1.0' } as const;

export interface Credential {
  /** What the token resolved to when the connection opened. Decides the listing. */
  initial: CallerContext;
  /** Resolves the SAME token again. Null means refuse this call. */
  refresh: (now: Date) => Promise<CallerContext | null>;
}

export function createBookableServer(credential: Credential, deps: ToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO);

  for (const tool of TOOLS) {
    if (!tool.roles.includes(credential.initial.role)) continue;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const ctx = await credential.refresh(deps.now());
        if (!ctx) return UNAUTHORIZED;
        if (!tool.roles.includes(ctx.role)) return FORBIDDEN;
        const result = await tool.handler(ctx, args, deps);
        return {
          content: [{ type: 'text', text: result.summary }],
          structuredContent: result.data,
        };
      },
    );
  }

  return server;
}
