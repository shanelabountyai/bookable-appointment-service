/**
 * stdio entry point — what a Claude Desktop / Claude Code MCP config launches.
 *
 *   { "command": "npx", "args": ["tsx", "apps/mcp/src/stdio.ts"],
 *     "env": { "DATABASE_URL": "...", "BOOKABLE_MCP_TOKEN": "bk_mcp_..." } }
 *
 * The token is issued by an owner on /staff/people (M-002). stdout is the
 * protocol channel, so nothing here may `console.log`; diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { prisma } from '@bookable/db';
import { contextForToken } from './context';
import { createBookableServer } from './server';

async function main(): Promise<void> {
  const token = process.env.BOOKABLE_MCP_TOKEN;
  if (!token) {
    throw new Error('BOOKABLE_MCP_TOKEN is not set. An owner can issue one on /staff/people.');
  }
  const initial = await contextForToken(prisma, token, new Date());
  if (!initial) {
    throw new Error('BOOKABLE_MCP_TOKEN is not a working token — revoked, or its person is off the roster.');
  }

  const server = createBookableServer(
    { initial, refresh: (now) => contextForToken(prisma, token, now) },
    { prisma, now: () => new Date() },
  );
  await server.connect(new StdioServerTransport());
  process.stderr.write(`bookable mcp: connected as ${initial.staffName} (${initial.role})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`bookable mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
