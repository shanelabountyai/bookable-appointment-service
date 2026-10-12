import { listServices } from '@bookable/db/settings';
import { z } from 'zod';
import { ALL_ROLES, defineTool } from './define';

export const serviceShape = {
  id: z.string(),
  name: z.string(),
  duration_minutes: z.number().int(),
  price_cents: z.number().int(),
  /** False = the desk may book it, self-serve may not (BOOK-01). MCP is the desk. */
  bookable_online: z.boolean(),
};

export const listServicesTool = defineTool({
  name: 'list_services',
  roles: ALL_ROLES,
  description:
    'List the services this salon offers, with duration and price. Use it first to get service ids for find_open_times or prepare_booking. Only active services are returned; it does not say who can perform them — list_providers does.',
  inputSchema: {},
  outputSchema: { services: z.array(z.object(serviceShape)) },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async handler(ctx, _args, deps) {
    const rows = await listServices(deps.prisma, ctx.businessId, false);
    const services = rows.map((s) => ({
      id: s.id,
      name: s.name,
      duration_minutes: s.durationMinutes,
      price_cents: s.priceCents,
      bookable_online: s.bookableOnline,
    }));
    return {
      summary: `${services.length} active service${services.length === 1 ? '' : 's'}.`,
      data: { services },
    };
  },
});
