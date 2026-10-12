/**
 * M-014 — /api/mcp answers a real HTTP client with a bearer token, against the
 * production build. The unit suite covers the protocol; this proves the route
 * is mounted, the demo gate lets it through, and the Next runtime can run the
 * server (bundling, Prisma engine, the lot).
 */
import { PrismaClient } from '@bookable/db';
import { issueMcpToken } from '@bookable/db/mcp';
import { STAFF_EMAIL, expect, test } from './fixtures';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
};

test.describe('/api/mcp', () => {
  test('initialize and tools/list with a bearer token; 401 without one', async ({ request }) => {
    const prisma = new PrismaClient();
    try {
      const owner = await prisma.staffUser.findFirstOrThrow({ where: { email: STAFF_EMAIL } });
      const { token } = await issueMcpToken(prisma, {
        businessId: owner.businessId,
        staffUserId: owner.id,
        issuedById: owner.id,
        label: 'e2e',
        now: new Date(),
      });
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' };

      const init = await request.post('/api/mcp', { headers, data: INIT });
      expect(init.status()).toBe(200);
      const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
      expect(initBody.result.serverInfo.name).toBe('bookable');

      const list = await request.post('/api/mcp', { headers, data: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
      expect(list.status()).toBe(200);
      const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
      expect(tools).toContain('find_open_times');
      expect(tools).toContain('commit_proposal');
      expect(tools).toContain('get_week_report'); // the owner's token

      const bare = await request.post('/api/mcp', { headers: { Accept: headers.Accept }, data: INIT });
      expect(bare.status()).toBe(401);
      expect(bare.headers()['www-authenticate']).toMatch(/^Bearer/);
    } finally {
      await prisma.$disconnect();
    }
  });
});
