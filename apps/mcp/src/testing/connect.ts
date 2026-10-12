/**
 * Test harness: a real MCP client talking to a real server over an in-memory
 * transport. Tests exercise `tools/list` and `tools/call` the way a client
 * does — schema validation, annotations and `structuredContent` included —
 * rather than calling handlers directly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallerContext } from '../context';
import { createBookableServer } from '../server';
import type { ToolDeps } from '../tools/define';

export interface Connected {
  client: Client;
  close: () => Promise<void>;
}

export async function connectAs(ctx: CallerContext, deps: ToolDeps): Promise<Connected> {
  const server = createBookableServer(ctx, deps);
  const client = new Client({ name: 'bookable-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
