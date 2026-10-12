/**
 * Builds the MCP server for ONE caller. Transport-agnostic: stdio.ts and the
 * later HTTP route (M-014) both call this and attach their own transport.
 *
 * Role scoping happens HERE, at registration: a tool whose `roles` excludes
 * the caller is never registered, so it is absent from `tools/list` rather
 * than present-and-refused (PRD §5). A model calls anything it can see.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CallerContext } from './context';
import type { ToolDeps } from './tools/define';
import { TOOLS } from './tools';

export const SERVER_INFO = { name: 'bookable', version: '0.1.0' } as const;

export function createBookableServer(ctx: CallerContext, deps: ToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO);

  for (const tool of TOOLS) {
    if (!tool.roles.includes(ctx.role)) continue;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
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
