/**
 * M-014 — the server over Streamable HTTP with a bearer token.
 *
 * A real `StreamableHTTPClientTransport` with its `fetch` pointed at
 * `handleMcpRequest`, so what is exercised is the HTTP framing, the bearer
 * check and the stateless transport — without a listening socket.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { instantFromIso, toDate } from '@bookable/core/time';
import { PrismaClient } from '@bookable/db';
import { issueMcpToken, revokeMcpToken } from '@bookable/db/mcp';
import { resetDatabase } from '@bookable/db/testing';
import { handleMcpRequest } from './http';
import { seedTwoSalons, type Salon } from './testing/two-salons';
import { TOOLS } from './tools';

const prisma = new PrismaClient();
const NOW = toDate(instantFromIso('2026-06-09T14:00:00Z'));
const deps = { prisma, now: () => NOW };
const URL_ = new URL('https://bookable.test/api/mcp');

let a: Salon;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  ({ a } = await seedTwoSalons(prisma));
});

/** fetch that never touches the network: every request goes straight to the handler. */
const localFetch: typeof fetch = (input, init) => handleMcpRequest(new Request(input, init), deps);

async function connect(headers: Record<string, string>) {
  const client = new Client({ name: 'http-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(URL_, { fetch: localFetch, requestInit: { headers } });
  // The SDK types `sessionId?: string | undefined`; our `exactOptionalPropertyTypes` reads that as a different shape.
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  return client;
}

describe('Streamable HTTP with a bearer token', () => {
  it('lists and calls tools for a valid token, stateless, JSON responses', async () => {
    const { token, id } = await issueMcpToken(prisma, { businessId: a.businessId, staffUserId: a.staffId, issuedById: a.ownerId, label: 'laptop', now: NOW });
    const client = await connect({ Authorization: `Bearer ${token}` });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.filter((t) => t.roles.includes('staff')).map((t) => t.name).sort());
      const r = await client.callTool({ name: 'list_services', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect((r.structuredContent as { services: unknown[] }).services).toHaveLength(a.serviceIds.length);
      // Every request resolves the token afresh: lastUsedAt moved.
      expect((await prisma.mcpToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).toEqual(NOW);
    } finally {
      await client.close();
    }
  });

  it('no token → 401 with a Bearer challenge and no server-side work', async () => {
    const res = await handleMcpRequest(new Request(URL_, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(await res.json()).toMatchObject({ error: 'UNAUTHORIZED', message: expect.stringMatching(/staff\/people/) });
    await expect(connect({})).rejects.toThrow();
  });

  it('a revoked token → 401 on the next request, mid-session', async () => {
    const { token, id } = await issueMcpToken(prisma, { businessId: a.businessId, staffUserId: a.staffId, issuedById: a.ownerId, label: 'laptop', now: NOW });
    const client = await connect({ Authorization: `Bearer ${token}` });
    try {
      expect((await client.callTool({ name: 'list_services', arguments: {} })).isError).toBeFalsy();
      await revokeMcpToken(prisma, { businessId: a.businessId, id, now: NOW });
      await expect(client.callTool({ name: 'list_services', arguments: {} })).rejects.toThrow(/401|Unauthorized/i);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('a malformed Authorization header is 401, not 500', async () => {
    for (const authorization of ['Basic abc', 'bk_mcp_raw', 'Bearer', 'Bearer  ']) {
      const res = await handleMcpRequest(new Request(URL_, { method: 'POST', body: '{}', headers: { authorization } }), deps);
      expect(res.status, authorization).toBe(401);
    }
  });
});
