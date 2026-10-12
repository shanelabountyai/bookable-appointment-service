/**
 * Test harness: a real MCP client talking to a real server over an in-memory
 * transport, authenticated with a real token. Tests exercise `tools/list` and
 * `tools/call` the way a client does — schema validation, annotations and
 * `structuredContent` included — rather than calling handlers directly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PrismaClient } from '@bookable/db';
import { issueMcpToken } from '@bookable/db/mcp';
import { contextForToken } from '../context';
import { createBookableServer } from '../server';
import type { ToolDeps } from '../tools/define';

export interface Connected {
  client: Client;
  token: string;
  close: () => Promise<void>;
}

/** Connects with `token`. Throws if the token does not resolve — a test that wants that path calls `contextForToken` itself. */
export async function connectWithToken(token: string, deps: ToolDeps): Promise<Connected> {
  const initial = await contextForToken(deps.prisma, token, deps.now());
  if (!initial) throw new Error('connectWithToken: token did not resolve');
  const server = createBookableServer({ initial, refresh: (now) => contextForToken(deps.prisma, token, now) }, deps);
  const client = new Client({ name: 'bookable-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    token,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Issues a token for `staffUserId` (as `issuedById`) and connects with it. */
export async function connectAs(
  prisma: PrismaClient,
  args: { businessId: string; staffUserId: string; issuedById: string },
  deps: ToolDeps,
): Promise<Connected> {
  const { token } = await issueMcpToken(prisma, { ...args, label: 'test', now: deps.now() });
  return connectWithToken(token, deps);
}

/** Structured error payload of a failed call, or null if the call succeeded. */
export type CallResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * Structured error payload of a failed call, or null if the call succeeded. An
 * error with NO structured payload came from the SDK itself (schema validation,
 * unknown tool) and is surfaced as `{ error: 'SDK', message }` so an assertion
 * failure shows the reason instead of `undefined`.
 */
export function errorOf(result: CallResult): Record<string, unknown> | null {
  if (!result.isError) return null;
  if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
  return { error: 'SDK', message: (result.content as { text?: string }[]).map((c) => c.text ?? '').join('\n') };
}
