/**
 * stdio entry point — what a Claude Desktop / Claude Code MCP config launches.
 *
 *   { "command": "npx", "args": ["tsx", "apps/mcp/src/stdio.ts"],
 *     "env": { "DATABASE_URL": "...", "BOOKABLE_MCP_STAFF_ID": "..." } }
 *
 * stdout is the protocol channel, so nothing here may `console.log`; diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { prisma } from '@bookable/db';
import { contextForStaffId } from './context';
import { createBookableServer } from './server';

async function main(): Promise<void> {
  // M-001 only — replaced by BOOKABLE_MCP_TOKEN in M-003.
  const staffId = process.env.BOOKABLE_MCP_STAFF_ID;
  if (!staffId) {
    throw new Error('BOOKABLE_MCP_STAFF_ID is not set.');
  }
  const ctx = await contextForStaffId(prisma, staffId);
  if (!ctx) {
    throw new Error('BOOKABLE_MCP_STAFF_ID does not name an active staff member.');
  }

  const server = createBookableServer(ctx, { prisma, now: () => new Date() });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`bookable mcp: connected as ${ctx.staffName} (${ctx.role})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`bookable mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
